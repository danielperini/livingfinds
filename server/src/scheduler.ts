/**
 * Scheduler self-hosted do LivingFinds.
 *
 * Lê base44/schedules/amazon-automation-schedule.json e executa crons no timezone
 * configurado. Cada job possui lock em memória para impedir sobreposição quando uma
 * execução ultrapassa o próximo disparo.
 */
import { join } from 'jsr:@std/path@1';
import { makeFunctions } from './sdk/functions.ts';

// deno-lint-ignore no-explicit-any
type Job = { name: string; function: string; cron: string; payload?: Record<string, any> };

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

  let lastMinuteKey = '';
  const tick = async () => {
    const now = nowInTz(timezone);
    const minuteKey = `${now.mon}-${now.dom}-${now.hour}-${now.min}`;
    if (minuteKey === lastMinuteKey) return;
    lastMinuteKey = minuteKey;

    for (const job of jobs) {
      if (!cronMatches(job.cron, now)) continue;
      const jobKey = `${job.name}|${job.function}`;
      const running = runningJobs.get(jobKey);
      if (running) {
        const elapsedSeconds = Math.round((Date.now() - running.startedAt) / 1000);
        console.warn(`[scheduler] ignorando sobreposição '${job.name}' (${elapsedSeconds}s em execução)`);
        continue;
      }

      runningJobs.set(jobKey, { startedAt: Date.now(), functionName: job.function });
      console.log(`[scheduler] disparando '${job.name}' -> ${job.function}`);
      service.invoke(job.function, job.payload ?? {})
        .then((response) => console.log(`[scheduler] '${job.function}' ok=${response.ok} status=${response.status}`))
        .catch((error) => console.error(`[scheduler] '${job.function}' erro:`, error?.message))
        .finally(() => runningJobs.delete(jobKey));
    }
  };

  setInterval(tick, 30_000);
  tick();
}
