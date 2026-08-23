/**
 * Scheduler self-hosted do LivingFinds.
 *
 * Lê base44/schedules/amazon-automation-schedule.json e executa crons no timezone
 * configurado. Cada função/conta possui lock em memória para impedir sobreposição
 * quando uma execução ultrapassa o próximo disparo.
 */
import { join } from 'jsr:@std/path@1';
import { makeFunctions } from './sdk/functions.ts';
import { sql } from './db.ts';

// deno-lint-ignore no-explicit-any
type Job = { name: string; function: string; cron: string; payload?: Record<string, any>; run_on_startup?: boolean };

type SchedulerHealth = {
  enabled: boolean;
  started: boolean;
  started_at: string | null;
  jobs_loaded: number;
  startup_jobs: number;
  last_tick_at: string | null;
  last_dispatch_at: string | null;
  last_success_at: string | null;
  last_error_at: string | null;
  last_error: string | null;
  running_jobs: number;
};

const schedulerHealth: SchedulerHealth = {
  enabled: true,
  started: false,
  started_at: null,
  jobs_loaded: 0,
  startup_jobs: 0,
  last_tick_at: null,
  last_dispatch_at: null,
  last_success_at: null,
  last_error_at: null,
  last_error: null,
  running_jobs: 0,
};

export function getSchedulerHealth(): SchedulerHealth & { tick_age_seconds: number | null; healthy: boolean } {
  const tickMs = schedulerHealth.last_tick_at ? Date.parse(schedulerHealth.last_tick_at) : NaN;
  const tickAge = Number.isFinite(tickMs) ? Math.max(0, Math.round((Date.now() - tickMs) / 1000)) : null;
  const healthy = schedulerHealth.enabled && schedulerHealth.started && schedulerHealth.jobs_loaded > 0 && tickAge !== null && tickAge <= 120;
  return { ...schedulerHealth, tick_age_seconds: tickAge, healthy };
}

function schedulesFile(): string {
  return Deno.env.get('SCHEDULES_FILE') ??
    join(import.meta.dirname!, '..', '..', 'base44', 'schedules', 'amazon-automation-schedule.json');
}

function matchField(field: string, value: number): boolean {
  if (field === '*') return true;
  for (const part of field.split(',')) {
    const step = part.includes('/') ? Number(part.split('/')[1]) : 1;
    const range = part.split('/')[0];
    if (range === '*') {
      if (value % step === 0) return true;
      continue;
    }
    if (range.includes('-')) {
      const [a, b] = range.split('-').map(Number);
      if (value >= a && value <= b && (value - a) % step === 0) return true;
    } else if (Number(range) === value) {
      return true;
    }
  }
  return false;
}

function cronMatches(cron: string, d: { min: number; hour: number; dom: number; mon: number; dow: number }): boolean {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const [mi, ho, dm, mo, dw] = fields;
  return matchField(mi, d.min) && matchField(ho, d.hour) && matchField(dm, d.dom) &&
    matchField(mo, d.mon) && matchField(dw, d.dow);
}

function nowInTz(tz: string) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    minute: '2-digit',
    hour: '2-digit',
    day: '2-digit',
    month: '2-digit',
    weekday: 'short',
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((part) => [part.type, part.value]));
  const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    min: Number(parts.minute),
    hour: Number(parts.hour === '24' ? '0' : parts.hour),
    dom: Number(parts.day),
    mon: Number(parts.month),
    dow: dowMap[parts.weekday as string] ?? 0,
  };
}

export async function startScheduler(): Promise<void> {
  if ((Deno.env.get('ENABLE_SCHEDULER') ?? 'true') === 'false') {
    schedulerHealth.enabled = false;
    console.log('[scheduler] desativado (ENABLE_SCHEDULER=false)');
    return;
  }

  let config: { timezone?: string; jobs?: Job[] };
  try {
    config = JSON.parse(await Deno.readTextFile(schedulesFile()));
  } catch (error) {
    schedulerHealth.last_error_at = new Date().toISOString();
    schedulerHealth.last_error = (error as Error).message;
    console.error('[scheduler] não consegui ler o arquivo de schedules:', (error as Error).message);
    return;
  }

  const timezone = config.timezone ?? 'America/Sao_Paulo';
  const jobs = config.jobs ?? [];
  const service = makeFunctions(true);
  const runningJobs = new Map<string, { startedAt: number; functionName: string }>();
  schedulerHealth.started = true;
  schedulerHealth.started_at = new Date().toISOString();
  schedulerHealth.jobs_loaded = jobs.length;
  schedulerHealth.startup_jobs = jobs.filter((item) => item.run_on_startup === true).length;
  console.log(`[scheduler] ${jobs.length} jobs agendados (tz=${timezone})`);

  const lastRunSlots = new Map<string, string>();
  const tick = async () => {
    schedulerHealth.last_tick_at = new Date().toISOString();
    schedulerHealth.running_jobs = runningJobs.size;
    const now = nowInTz(timezone);

    for (const job of jobs) {
      if (!cronMatches(job.cron, now)) continue;
      const accountScope = String(job.payload?.amazon_account_id || 'all-accounts');
      const jobKey = `${job.function}|${accountScope}`;
      const slotKey = `${now.mon}-${now.dom}-${now.hour}-${now.min}`;
      if (lastRunSlots.get(jobKey) === slotKey) continue;
      lastRunSlots.set(jobKey, slotKey);
      const running = runningJobs.get(jobKey);
      if (running) {
        const elapsedSeconds = Math.round((Date.now() - running.startedAt) / 1000);
        console.warn(`[scheduler] ignorando sobreposição '${job.name}' para ${job.function}/${accountScope} (${elapsedSeconds}s em execução)`);
        continue;
      }

      runningJobs.set(jobKey, { startedAt: Date.now(), functionName: job.function });
      schedulerHealth.running_jobs = runningJobs.size;
      schedulerHealth.last_dispatch_at = new Date().toISOString();
      console.log(`[scheduler] disparando '${job.name}' -> ${job.function}`);
      (async () => {
        try {
          await sql.begin(async (tx: any) => {
            const [lock] = await tx`
              select pg_try_advisory_xact_lock(hashtextextended(${jobKey}, 0)) as acquired
            `;
            if (!lock?.acquired) {
              console.warn(`[scheduler] skipped_concurrent_execution '${job.name}'/${accountScope}`);
              return;
            }
            const response = await service.invoke(job.function, job.payload ?? {});
            if (response.ok) {
              schedulerHealth.last_success_at = new Date().toISOString();
              schedulerHealth.last_error = null;
            } else {
              schedulerHealth.last_error_at = new Date().toISOString();
              schedulerHealth.last_error = `${job.function} status=${response.status}`;
            }
            console.log(`[scheduler] '${job.function}' ok=${response.ok} status=${response.status}`);
          });
        } catch (error) {
          schedulerHealth.last_error_at = new Date().toISOString();
          schedulerHealth.last_error = (error as Error)?.message || String(error);
          console.error(`[scheduler] '${job.function}' erro:`, (error as Error)?.message);
        } finally {
          runningJobs.delete(jobKey);
          schedulerHealth.running_jobs = runningJobs.size;
        }
      })();
    }
  };

  setInterval(tick, 30_000);
  tick();

  const runStartupJob = (job: Job, attempt = 1) => {
    const accountScope = String(job.payload?.amazon_account_id || 'all-accounts');
    const jobKey = `${job.function}|${accountScope}`;
    if (runningJobs.has(jobKey)) {
      if (attempt < 10) setTimeout(() => runStartupJob(job, attempt + 1), 30_000);
      else console.error(`[scheduler] startup '${job.name}' abandonado após ${attempt} tentativas por sobreposição`);
      return;
    }
    runningJobs.set(jobKey, { startedAt: Date.now(), functionName: job.function });
    schedulerHealth.running_jobs = runningJobs.size;
    schedulerHealth.last_dispatch_at = new Date().toISOString();
    console.log(`[scheduler] startup '${job.name}' -> ${job.function} (tentativa ${attempt})`);
    service.invoke(job.function, { ...(job.payload ?? {}), _startup_execution: true })
      .then((response) => {
        const locked = response?.data?.results?.some?.((item: any) => item?.locked === true) === true;
        if (response.ok) {
          schedulerHealth.last_success_at = new Date().toISOString();
          schedulerHealth.last_error = null;
        } else {
          schedulerHealth.last_error_at = new Date().toISOString();
          schedulerHealth.last_error = `${job.function} status=${response.status}`;
        }
        console.log(`[scheduler] startup '${job.function}' ok=${response.ok} status=${response.status} locked=${locked}`);
        if (locked && attempt < 10) setTimeout(() => runStartupJob(job, attempt + 1), 30_000);
      })
      .catch((error) => {
        schedulerHealth.last_error_at = new Date().toISOString();
        schedulerHealth.last_error = (error as Error)?.message || String(error);
        console.error(`[scheduler] startup '${job.function}' erro:`, (error as Error)?.message);
      })
      .finally(() => {
        runningJobs.delete(jobKey);
        schedulerHealth.running_jobs = runningJobs.size;
      });
  };

  const startupJobs = jobs.filter((item) => item.run_on_startup === true);
  startupJobs.forEach((job, index) => {
    setTimeout(() => runStartupJob(job), 1_000 + index * 30_000);
  });
}
