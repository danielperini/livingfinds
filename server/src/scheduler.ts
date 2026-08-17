/**
 * Scheduler self-hosted do LivingFinds.
 *
 * Lê runtime/schedules/amazon-automation-schedule.json e executa crons no timezone
 * configurado. Cada função/conta possui lock em memória para impedir sobreposição
 * quando uma execução ultrapassa o próximo disparo.
 */
import { join } from 'jsr:@std/path@1';
import { makeFunctions } from './sdk/functions.ts';
import { sql } from './db.ts';

// deno-lint-ignore no-explicit-any
type Job = { name: string; function: string; cron: string; payload?: Record<string, any>; run_on_startup?: boolean };

function schedulesFile(): string {
  return Deno.env.get('SCHEDULES_FILE') ??
    join(import.meta.dirname!, '..', '..', 'runtime', 'schedules', 'amazon-automation-schedule.json');
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
    console.log('[scheduler] desativado (ENABLE_SCHEDULER=false)');
    return;
  }

  let config: { timezone?: string; jobs?: Job[] };
  try {
    config = JSON.parse(await Deno.readTextFile(schedulesFile()));
  } catch (error) {
    console.error('[scheduler] não consegui ler o arquivo de schedules:', (error as Error).message);
    return;
  }

  const timezone = config.timezone ?? 'America/Sao_Paulo';
  const jobs = config.jobs ?? [];
  const service = makeFunctions(true);
  const runningJobs = new Map<string, { startedAt: number; functionName: string }>();
  console.log(`[scheduler] ${jobs.length} jobs agendados (tz=${timezone})`);

  const lastRunSlots = new Map<string, string>();
  const tick = async () => {
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
            console.log(`[scheduler] '${job.function}' ok=${response.ok} status=${response.status}`);
          });
        } catch (error) {
          console.error(`[scheduler] '${job.function}' erro:`, (error as Error)?.message);
        } finally {
          runningJobs.delete(jobKey);
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
    console.log(`[scheduler] startup '${job.name}' -> ${job.function} (tentativa ${attempt})`);
    service.invoke(job.function, { ...(job.payload ?? {}), _startup_execution: true })
      .then((response) => {
        const locked = response?.data?.results?.some?.((item: any) => item?.locked === true) === true;
        console.log(`[scheduler] startup '${job.function}' ok=${response.ok} status=${response.status} locked=${locked}`);
        if (locked && attempt < 10) setTimeout(() => runStartupJob(job, attempt + 1), 30_000);
      })
      .catch((error) => console.error(`[scheduler] startup '${job.function}' erro:`, (error as Error)?.message))
      .finally(() => runningJobs.delete(jobKey));
  };

  const startupJobs = jobs.filter((item) => item.run_on_startup === true);
  startupJobs.forEach((job, index) => {
    setTimeout(() => runStartupJob(job), 1_000 + index * 30_000);
  });
}
