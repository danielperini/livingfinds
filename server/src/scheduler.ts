import { schedulerOperationalHealth } from '../../base44/shared/operationalState.js';
/**
 * Scheduler self-hosted do LivingFinds.
 *
 * Lê base44/schedules/amazon-automation-schedule.json e executa crons no timezone
 * configurado. Locks PostgreSQL de sessão impedem concorrência entre réplicas e
 * acionadores locais; a conexão fica reservada no pool isolado do scheduler durante a execução.
 */
import { readDailyMotorWithSql } from './motorDashboard.ts';
import { join } from 'jsr:@std/path@1';
import { makeFunctions } from './sdk/functions.ts';
import { schedulerSql } from './db.ts';
import {
  dailyCatchUpSlot,
  classifyAuditJobException,
  classifyAuditJobResponse,
  failedJobStages,
  isDailyCycleExecutionConfirmedResponse,
  isStaleFinalAttempt,
  isSuccessfulJobResponse,
  retryDelaySeconds,
  runWithLock,
  shouldDispatchRun,
  shouldDispatchScheduledRun,
  shouldRecoverDailyCatchUpRun,
  validateSchedule,
} from './schedulerPolicy.ts';

// deno-lint-ignore no-explicit-any
type Job = {
  name: string;
  function: string;
  cron: string;
  payload?: Record<string, any>;
  run_on_startup?: boolean;
  catch_up_daily?: boolean;
  /** Um watchdog confirmado pode reconciliar o ledger do ciclo diário que ele recuperou. */
  reconciles_daily_function?: string;
  retry?: { max_attempts?: number; base_delay_seconds?: number; max_delay_seconds?: number };
};

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
  job_errors: Record<string, { job: string; slot_key: string; cause: string; at: string }>;
};

const DAILY_CATCH_UP_MAX_RECOVERIES = 4;

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
  job_errors: {},
};

export function getSchedulerHealth() {
  return schedulerOperationalHealth(schedulerHealth);
}

function recordSchedulerFailure(job: string, slotKey: string, cause: unknown) {
  const at = new Date().toISOString();
  const message = safeError(cause);
  schedulerHealth.job_errors[job] = { job, slot_key: slotKey, cause: message, at };
  schedulerHealth.last_error_at = at;
  schedulerHealth.last_error = `${job}: ${message}`;
}
function clearSchedulerFailure(job: string) {
  delete schedulerHealth.job_errors[job];
  const outstanding = Object.values(schedulerHealth.job_errors).sort((a,b) => b.at.localeCompare(a.at))[0];
  schedulerHealth.last_error = outstanding ? `${outstanding.job}: ${outstanding.cause}` : null;
}

function schedulesFile(): string {
  return Deno.env.get('SCHEDULES_FILE') ??
    join(
      import.meta.dirname!,
      '..',
      '..',
      'base44',
      'schedules',
      'amazon-automation-schedule.json',
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

function cronMatches(
  cron: string,
  d: { min: number; hour: number; dom: number; mon: number; dow: number },
): boolean {
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
    year: 'numeric',
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(new Date()).map((part) => [part.type, part.value]),
  );
  const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    min: Number(parts.minute),
    hour: Number(parts.hour === '24' ? '0' : parts.hour),
    dom: Number(parts.day),
    mon: Number(parts.month),
    year: Number(parts.year),
    dow: dowMap[parts.weekday as string] ?? 0,
  };
}

export async function getDailyMotorRunStatus(timezone = 'America/Sao_Paulo') {
  const local = nowInTz(timezone);
  const day = `${local.year}-${String(local.mon).padStart(2, '0')}-${
    String(local.dom).padStart(2, '0')
  }`;
  return await readDailyMotorWithSql(schedulerSql as any, {
    today: day, due: local.hour * 60 + local.min >= 85, scheduler: getSchedulerHealth(),
  });
}

function safeError(value: unknown): string {
  return String((value as Error)?.message || value || 'scheduler_job_failed')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/Atza\|[^\s]+/gi, '[redacted]')
    .replace(/(?:token|secret|password|authorization)\s*[:=]\s*[^,\s"]+/gi, '[redacted]')
    .slice(0, 500);
}

async function ensureRunLedger(): Promise<void> {
  await schedulerSql.unsafe(`
    create table if not exists scheduler_job_runs (
      job_key text not null,
      slot_key text not null,
      job_name text not null,
      function_name text not null,
      status text not null check (status in ('running','succeeded','failed','exhausted')),
      attempt_count integer not null default 0,
      recovery_count integer not null default 0,
      started_at timestamptz,
      finished_at timestamptz,
      next_attempt_at timestamptz,
      last_error text,
      updated_at timestamptz not null default now(),
      primary key (job_key, slot_key)
    )
  `);
  await schedulerSql.unsafe('alter table scheduler_job_runs add column if not exists correlation_id text');
  await schedulerSql.unsafe('alter table scheduler_job_runs add column if not exists outcome_class text');
  await schedulerSql.unsafe("alter table scheduler_job_runs add column if not exists result_summary jsonb not null default '{}'::jsonb");
  await schedulerSql.unsafe(
    'alter table scheduler_job_runs add column if not exists recovery_count integer not null default 0',
  );
  await schedulerSql.unsafe(
    'create index if not exists scheduler_job_runs_retry_idx on scheduler_job_runs (status, next_attempt_at)',
  );
}

async function getRun(jobKey: string, slotKey: string) {
  const rows = await schedulerSql.unsafe(
    'select status, attempt_count, recovery_count, next_attempt_at, started_at, finished_at, last_error, correlation_id from scheduler_job_runs where job_key=$1 and slot_key=$2 limit 1',
    [jobKey, slotKey],
  );
  return rows[0] as unknown as {
    status: string;
    attempt_count: number;
    recovery_count: number;
    next_attempt_at: string | null;
    started_at: string | null;
    finished_at: string | null;
    last_error: string | null;
    correlation_id?: string | null;
  } | undefined;
}

async function tryAcquireDistributedLock(lockKey: string): Promise<(() => Promise<void>) | null> {
  const connection = await schedulerSql.reserve();
  try {
    const rows = await connection.unsafe(
      'select pg_try_advisory_lock(hashtextextended($1, 0)) as acquired',
      [lockKey],
    );
    if (!rows[0]?.acquired) {
      await connection.release();
      return null;
    }
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      try {
        await connection.unsafe('select pg_advisory_unlock(hashtextextended($1, 0))', [lockKey]);
      } finally {
        await connection.release();
      }
    };
  } catch (error) {
    await connection.release();
    throw error;
  }
}

async function runWithDistributedLock<T>(
  lockKey: string,
  action: () => Promise<T>,
): Promise<{ acquired: false } | { acquired: true; value: T }> {
  return runWithLock(() => tryAcquireDistributedLock(lockKey), action);
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
    recordSchedulerFailure('schedule_load', 'startup', error);
    console.error('[scheduler] não consegui ler o arquivo de schedules:', (error as Error).message);
    setTimeout(() => void startScheduler(), 60_000);
    return;
  }

  const timezone = config.timezone ?? 'America/Sao_Paulo';
  const jobs = config.jobs ?? [];
  for (const issue of validateSchedule(jobs)) {
    console.error('[scheduler] configuração inválida: ' + issue);
  }
  try {
    await ensureRunLedger();
  } catch (error) {
    schedulerHealth.last_error_at = new Date().toISOString();
    recordSchedulerFailure('scheduler_ledger', 'startup', error);
    console.error('[scheduler] ledger persistente indisponível:', safeError(error));
    setTimeout(() => void startScheduler(), 60_000);
    return;
  }
  clearSchedulerFailure('schedule_load');
  clearSchedulerFailure('scheduler_ledger');
  const service = makeFunctions(true);
  const runningJobs = new Map<string, { startedAt: number; functionName: string }>();
  schedulerHealth.started = true;
  schedulerHealth.started_at = new Date().toISOString();
  schedulerHealth.jobs_loaded = jobs.length;
  schedulerHealth.startup_jobs = jobs.filter((item) => item.run_on_startup === true).length;
  console.log(`[scheduler] ${jobs.length} jobs agendados (tz=${timezone})`);

  const jobKeyOf = (job: Job) =>
    `${job.function}|${String(job.payload?.amazon_account_id || 'all-accounts')}`;
  const dispatch = async (
    job: Job,
    slotKey: string,
    payload: Record<string, any> = job.payload ?? {},
  ) => {
    const jobKey = jobKeyOf(job);
    const running = runningJobs.get(jobKey);
    if (running) return;
    runningJobs.set(jobKey, { startedAt: Date.now(), functionName: job.function });
    schedulerHealth.running_jobs = runningJobs.size;
    schedulerHealth.last_dispatch_at = new Date().toISOString();

    void (async () => {
      try {
        const maxAttempts = Math.max(1, Math.min(12, Number(job.retry?.max_attempts ?? 1)));
        const beforeLock = await getRun(jobKey, slotKey);
        if (
          !shouldDispatchScheduledRun(job, beforeLock, Date.now(), maxAttempts) &&
          !isStaleFinalAttempt(beforeLock, Date.now(), maxAttempts)
        ) return;
        const result = await runWithDistributedLock(`livingfinds:scheduler:${jobKey}`, async () => {
          let previous = await getRun(jobKey, slotKey);
          if (shouldRecoverDailyCatchUpRun(job, previous, Date.now())) {
            const reopened = await schedulerSql.unsafe(
              "update scheduler_job_runs set status='failed',attempt_count=0, recovery_count=recovery_count+1, next_attempt_at=now(), last_error='bounded_daily_recovery_scheduled', updated_at=now() where job_key=$1 and slot_key=$2 and status='exhausted' and recovery_count < $3 and finished_at <= now() - interval '1 hour' returning status,attempt_count,recovery_count,next_attempt_at,started_at,finished_at",
              [jobKey, slotKey, DAILY_CATCH_UP_MAX_RECOVERIES],
            );
            if (reopened[0]) previous = reopened[0] as unknown as typeof previous;
          }
          if (!shouldDispatchRun(previous, Date.now(), maxAttempts)) {
            if (isStaleFinalAttempt(previous, Date.now(), maxAttempts)) {
              await schedulerSql.unsafe(
                `update scheduler_job_runs set status='exhausted',finished_at=now(),next_attempt_at=null,
                 last_error=coalesce(last_error||'; ','')||'remote_unknown; scheduler lease expired; automatic replay blocked',updated_at=now()
                 where job_key=$1 and slot_key=$2 and status='running'`,
                [jobKey, slotKey],
              );
            }
            return { skipped: true };
          }
          const attempt = Number(previous?.attempt_count || 0) + 1;
          const stableCorrelationId = String(payload.correlation_id || previous?.correlation_id || '').trim().slice(0, 180) || crypto.randomUUID();
          await schedulerSql.unsafe(
            `
            insert into scheduler_job_runs (job_key,slot_key,job_name,function_name,status,attempt_count,started_at,finished_at,next_attempt_at,last_error,updated_at,correlation_id,outcome_class,result_summary)
            values ($1,$2,$3,$4,'running',$5,now(),null,null,null,now(),$6,null,'{}'::jsonb)
            on conflict (job_key,slot_key) do update set
              job_name=excluded.job_name,function_name=excluded.function_name,status='running',attempt_count=excluded.attempt_count,
              started_at=now(),finished_at=null,next_attempt_at=null,last_error=null,updated_at=now(),correlation_id=excluded.correlation_id,
              outcome_class=null,result_summary='{}'::jsonb
          `,
            [jobKey, slotKey, job.name, job.function, attempt, stableCorrelationId],
          );

          let response: any;
          let errorText: string | null = null;
          let outcomeClass: string | null = null;
          let resultSummary: Record<string, unknown> = {};
          try {
            response = await service.invoke(job.function, {
              ...payload,
              correlation_id: stableCorrelationId,
              _scheduler_slot_key: slotKey,
              _scheduler_attempt: attempt,
            });
            const auditOutcome = classifyAuditJobResponse(job.function, response);
            if (auditOutcome) {
              outcomeClass = auditOutcome.classification;
              resultSummary = auditOutcome.summary || {};
              if (!auditOutcome.scheduler_success) errorText = auditOutcome.error || `${job.function} ${auditOutcome.classification}`;
            } else if (!isSuccessfulJobResponse(response)) {
              const failedStages = failedJobStages(response)
                .map(({ name, detail }) => `${name}:${safeError(detail)}`);
              errorText = failedStages.join('; ').slice(0, 500) ||
                `${job.function} status=${
                  response?.status ?? 'unknown'
                } returned unsuccessful or partial result`;
            }
            if (response?.data?.remote_outcome === 'unknown' || response?.remote_outcome === 'unknown') {
              errorText = `remote_unknown; automatic replay blocked; ${errorText || 'remote reconciliation required'}`.slice(0, 500);
            }
          } catch (error) {
            const auditFailure = classifyAuditJobException(job.function, error, stableCorrelationId);
            if (auditFailure) {
              outcomeClass = auditFailure.classification;
              resultSummary = auditFailure.summary || {};
              errorText = `${job.function} ${auditFailure.classification}: ${safeError(error)}`;
            } else {
              errorText = `remote_unknown; invocation interrupted; automatic replay blocked; ${safeError(error)}`;
            }
          }

          const succeeded = errorText === null;
          const exhausted = !succeeded && attempt >= maxAttempts;
          const delay = retryDelaySeconds(
            attempt,
            Number(job.retry?.base_delay_seconds ?? 60),
            Number(job.retry?.max_delay_seconds ?? 1800),
          );
          await schedulerSql.unsafe(
            `
            update scheduler_job_runs set status=$3, finished_at=now(),
              next_attempt_at=case when $3='failed' then now() + ($4 * interval '1 second') else null end,
              last_error=$5, updated_at=now(),outcome_class=$6,result_summary=$7::jsonb
            where job_key=$1 and slot_key=$2
          `,
            [
              jobKey,
              slotKey,
              succeeded ? 'succeeded' : exhausted ? 'exhausted' : 'failed',
              delay,
              errorText,
              outcomeClass,
              JSON.stringify(resultSummary),
            ],
          );

          if (succeeded) {
            schedulerHealth.last_success_at = new Date().toISOString();
            clearSchedulerFailure(jobKey);
          } else {
            schedulerHealth.last_error_at = new Date().toISOString();
            recordSchedulerFailure(jobKey, slotKey, `${job.function} attempt=${attempt}/${maxAttempts}: ${errorText}`);
          }
          console.log(
            `[scheduler] ${job.function} slot=${slotKey} attempt=${attempt}/${maxAttempts} status=${
              succeeded ? 'succeeded' : exhausted ? 'exhausted' : 'retry_scheduled'
            }`,
          );
          return {
            skipped: false,
            succeeded,
            exhausted,
            attempt,
            dailyCycleConfirmed: isDailyCycleExecutionConfirmedResponse(response),
          };
        });
        if (!result.acquired) {
          console.warn('[scheduler] skipped_concurrent_execution ' + job.name + '/' + slotKey);
        } else if (
          !result.value.skipped && job.reconciles_daily_function &&
          (result.value.succeeded || result.value.dailyCycleConfirmed)
        ) {
          const reconciledJob = jobs.find((candidate) => candidate.function === job.reconciles_daily_function && candidate.catch_up_daily === true);
          const reconciledDay = /^\d{4}-\d{2}-\d{2}/.exec(slotKey)?.[0];
          if (reconciledJob && reconciledDay) {
            const reconciledKey = jobKeyOf(reconciledJob);
            await schedulerSql.unsafe(`
              insert into scheduler_job_runs (job_key,slot_key,job_name,function_name,status,attempt_count,started_at,finished_at,next_attempt_at,last_error,updated_at)
              values ($1,$2,$3,$4,'succeeded',0,now(),now(),null,null,now())
              on conflict (job_key,slot_key) do update set
                status='succeeded',finished_at=now(),next_attempt_at=null,last_error=null,updated_at=now()
              where scheduler_job_runs.last_error is null or scheduler_job_runs.last_error !~* 'remote_unknown|remote.*(unknown|not confirmed)|automatic replay blocked|deployment_interrupted'
            `, [reconciledKey, reconciledDay, reconciledJob.name, reconciledJob.function]);
          }
        }
      } catch (error) {
        schedulerHealth.last_error_at = new Date().toISOString();
        recordSchedulerFailure(jobKey, slotKey, error);
        console.error(`[scheduler] '${job.function}' erro:`, safeError(error));
      } finally {
        runningJobs.delete(jobKey);
        schedulerHealth.running_jobs = runningJobs.size;
      }
    })();
  };

  const tick = async () => {
    schedulerHealth.last_tick_at = new Date().toISOString();
    schedulerHealth.running_jobs = runningJobs.size;
    const now = nowInTz(timezone);
    const dueRetryRows = await schedulerSql.unsafe(
      `
      select job_key,slot_key from scheduler_job_runs
      where ((status='failed' and next_attempt_at <= now())
         or (status='running' and started_at <= now() - interval '10 minutes'))
        and job_key = any($1::text[])
      order by coalesce(next_attempt_at,started_at) asc limit 100
    `,
      [jobs.map(jobKeyOf)],
    ).catch((error) => {
      schedulerHealth.last_error_at = new Date().toISOString();
      recordSchedulerFailure('scheduler_retry_scan', 'tick', error);
      throw error;
    }) as unknown as Array<{ job_key: string; slot_key: string }>;
    clearSchedulerFailure('scheduler_retry_scan');
    const jobsByKey = new Map(jobs.map((job) => [jobKeyOf(job), job]));
    for (const row of dueRetryRows) {
      const job = jobsByKey.get(row.job_key);
      if (job) dispatch(job, row.slot_key);
    }

    for (const job of jobs) {
      const catchUpSlot = dailyCatchUpSlot(job, {
        year: now.year,
        month: now.mon,
        day: now.dom,
        hour: now.hour,
        min: now.min,
      });
      if (catchUpSlot) dispatch(job, catchUpSlot);
      else if (cronMatches(job.cron, now)) {
        dispatch(
          job,
          `${now.year}-${String(now.mon).padStart(2, '0')}-${String(now.dom).padStart(2, '0')}-${
            String(now.hour).padStart(2, '0')
          }-${String(now.min).padStart(2, '0')}`,
        );
      }
    }
  };

  let ticking = false;
  const guardedTick = async () => {
    if (ticking) return;
    ticking = true;
    try { await tick(); clearSchedulerFailure('scheduler_tick'); }
    catch (error) { recordSchedulerFailure('scheduler_tick', 'tick', error); console.error('[scheduler] tick failed:', safeError(error)); }
    finally { ticking = false; }
  };
  setInterval(() => void guardedTick(), 30_000);
  await guardedTick();

  // Preserve explicit startup jobs, but make them durable and at most once per local day.
  const bootNow = nowInTz(timezone);
  const bootSlot = `startup-${bootNow.year}-${String(bootNow.mon).padStart(2, '0')}-${
    String(bootNow.dom).padStart(2, '0')
  }`;
  jobs.filter((job) => job.run_on_startup === true).forEach((job) => {
    dispatch(job, bootSlot, { ...(job.payload ?? {}), _startup_execution: true });
  });
}
