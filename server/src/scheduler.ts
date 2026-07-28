/**
 * Scheduler — substitui o agendador do Base44. Lê base44/schedules/amazon-automation-schedule.json
 * e dispara cada função no seu horário (timezone do arquivo, ex.: America/Sao_Paulo).
 * Implementa um matcher de cron de 5 campos (min hora dia-mês mês dia-semana) verificado a cada minuto.
 */
import { join } from 'jsr:@std/path@1';
import { makeFunctions } from './sdk/functions.ts';
import { sql } from './db.ts';

// deno-lint-ignore no-explicit-any
type Job = { name: string; function: string; cron: string; payload?: Record<string, any> };

function schedulesFile(): string {
  return (
    Deno.env.get('SCHEDULES_FILE') ??
    join(import.meta.dirname!, '..', '..', 'base44', 'schedules', 'amazon-automation-schedule.json')
  );
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
  const [mi, ho, dm, mo, dw] = cron.trim().split(/\s+/);
  return (
    matchField(mi, d.min) &&
    matchField(ho, d.hour) &&
    matchField(dm, d.dom) &&
    matchField(mo, d.mon) &&
    matchField(dw, d.dow)
  );
}

/** Componentes de data/hora no timezone alvo (via Intl, sem libs externas). */
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
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
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
  } catch (e) {
    console.error('[scheduler] não consegui ler o arquivo de schedules:', (e as Error).message);
    return;
  }
  const tz = config.timezone ?? 'America/Sao_Paulo';
  const jobs = config.jobs ?? [];
  const svc = makeFunctions(true);
  console.log(`[scheduler] ${jobs.length} jobs agendados (tz=${tz})`);

  let lastKey = '';
  const tick = async () => {
    const now = nowInTz(tz);
    const key = `${now.mon}-${now.dom}-${now.hour}-${now.min}`;
    if (key === lastKey) return; // evita disparo duplo dentro do mesmo minuto
    lastKey = key;
    for (const job of jobs) {
      if (cronMatches(job.cron, now)) {
        const executionKey = `${job.name}|${key}`;
        try {
          await sql.begin(async (tx) => {
            const rows = await tx<{ locked: boolean }[]>`
              SELECT pg_try_advisory_xact_lock(hashtext(${executionKey})) AS locked
            `;
            if (!rows[0]?.locked) {
              console.log(`[scheduler] '${job.name}' já está em execução em outro worker`);
              return;
            }
            console.log(`[scheduler] disparando '${job.name}' -> ${job.function}`);
            const result = await svc.invoke(job.function, job.payload ?? {});
            console.log(`[scheduler] '${job.function}' ok=${result.ok} status=${result.status}`);
          });
        } catch (e) {
          console.error(`[scheduler] '${job.function}' erro:`, (e as Error)?.message);
        }
      }
    }
  };
  // checa a cada 30s (o guard lastKey garante 1 disparo por minuto)
  setInterval(tick, 30_000);
  tick();
}
