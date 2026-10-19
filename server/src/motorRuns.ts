import { query, sql } from './db.ts';
import {
  motorFailureRemoteOutcome,
  motorRemoteOutcome,
  safeMotorError,
  summarizeMotorResult,
  terminalMotorStatus,
} from './motorRunPolicy.ts';

export type MotorRunStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'interrupted'
  | 'remote_unknown';
export type MotorFunction =
  | 'runCanonicalDecisionCycle'
  | 'runUnifiedDecisionEngine'
  | 'runStrategyEngine'
  | 'executeApprovedDecisionQueue'
  | 'confirmExecutedDecisions';
type DbRow = Record<string, any>;

const ALLOWED_FUNCTIONS = new Set<MotorFunction>([
  'runCanonicalDecisionCycle',
  'runUnifiedDecisionEngine',
  'runStrategyEngine',
  'executeApprovedDecisionQueue',
  'confirmExecutedDecisions',
]);
const LEASE_MS = 5 * 60_000;
const HEARTBEAT_MS = 15_000;
const RUN_TIMEOUT_MS = 20 * 60_000;
let ensurePromise: Promise<void> | null = null;

function quoteRunTable(name: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) {
    throw new Error('Nome interno da tabela de execução inválido.');
  }
  return `"${name}"`;
}

export function isMotorFunction(value: unknown): value is MotorFunction {
  return typeof value === 'string' && ALLOWED_FUNCTIONS.has(value as MotorFunction);
}

export async function ensureMotorRunTable(): Promise<void> {
  if (ensurePromise) return await ensurePromise;
  ensurePromise = (async () => {
    await sql.unsafe(`
    create table if not exists motor_execution_runs (
      id text primary key,
      request_key text not null unique,
      function_name text not null,
      account_scope text not null,
      status text not null check (status in ('queued','running','completed','partial','failed','interrupted','remote_unknown')),
      current_stage text,
      accepted_at timestamptz not null default now(),
      started_at timestamptz,
      last_activity_at timestamptz not null default now(),
      finished_at timestamptz,
      attempt_count integer not null default 0,
      stage_results jsonb not null default '{}'::jsonb,
      counters jsonb not null default '{}'::jsonb,
      errors jsonb not null default '[]'::jsonb,
      result_summary jsonb,
      request_payload jsonb not null default '{}'::jsonb,
      remote_outcome text not null default 'not_attempted',
      lease_id text,
      lease_expires_at timestamptz,
      created_at timestamptz not null default now()
    )
  `);
    await sql.unsafe(
      `create index if not exists motor_execution_runs_queue_idx on motor_execution_runs(status, created_at)`,
    );
    await sql.unsafe(
      `create index if not exists motor_execution_runs_scope_idx on motor_execution_runs(account_scope, status, last_activity_at desc)`,
    );
    // Cross-process exclusivity is enforced by a PostgreSQL advisory transaction lock
    // in both enqueue and claim. Avoid adding a uniqueness constraint over legacy rows.
  })();
  try {
    await ensurePromise;
  } catch (error) {
    ensurePromise = null;
    throw error;
  }
}

export async function enqueueMotorRun(input: {
  request_key: string;
  function_name: MotorFunction;
  account_id?: string | null;
  payload?: Record<string, unknown>;
}) {
  await ensureMotorRunTable();
  if (!isMotorFunction(input.function_name)) {
    throw new Error('Função de motor não permitida na fila durável.');
  }
  const requestKey = String(input.request_key || '').trim().slice(0, 180);
  if (!requestKey) throw new Error('request_key obrigatório para idempotência da execução.');
  const scope = String(input.account_id || 'default-account').trim().slice(0, 180);
  const payload = { ...(input.payload || {}) };
  delete (payload as any)._motor_execution_run_id;
  delete (payload as any)._motor_execution_lease;

  return await sql.begin(async (tx) => {
    await tx.unsafe('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `motor-run:${scope}`,
    ]);
    const existingRequest = await tx.unsafe(
      'select * from motor_execution_runs where request_key=$1 limit 1',
      [requestKey] as any[],
    ) as unknown as DbRow[];
    if (existingRequest[0]) return { run: existingRequest[0], reused: true };
    const active = await tx.unsafe(
      `select * from motor_execution_runs where account_scope=$1 and (status in ('queued','running','remote_unknown') or remote_outcome='unknown') order by created_at asc limit 1`,
      [scope] as any[],
    ) as unknown as DbRow[];
    if (active[0]) return { run: active[0], reused: true, blocked_by_existing: true };
    const id = crypto.randomUUID();
    const inserted = await tx.unsafe(
      `insert into motor_execution_runs(id,request_key,function_name,account_scope,status,request_payload)
       values($1,$2,$3,$4,'queued',$5::jsonb) returning *`,
      [id, requestKey, input.function_name, scope, JSON.stringify(payload)] as any[],
    ) as unknown as DbRow[];
    return { run: inserted[0], reused: false };
  });
}

export async function getMotorRun(id: string) {
  await ensureMotorRunTable();
  const rows = await query<DbRow>(
    `select id,request_key,function_name,account_scope,status,current_stage,accepted_at,started_at,last_activity_at,finished_at,attempt_count,stage_results,counters,errors,result_summary,remote_outcome from motor_execution_runs where id=$1 limit 1`,
    [id],
  );
  return rows[0] || null;
}

export async function listMotorRuns(accountId: string, limit = 10) {
  await ensureMotorRunTable();
  const safeLimit = Math.max(1, Math.min(50, Math.floor(Number(limit) || 10)));
  return await query<DbRow>(
    `select id,request_key,function_name,account_scope,status,current_stage,accepted_at,started_at,last_activity_at,finished_at,attempt_count,stage_results,counters,errors,result_summary,remote_outcome
     from motor_execution_runs where account_scope=$1 order by accepted_at desc limit $2`,
    [accountId || 'default-account', safeLimit],
  );
}

export async function reportMotorRunProgress(
  id: string,
  leaseId: string,
  patch: Record<string, unknown>,
) {
  await ensureMotorRunTable();
  const stage = String(patch.stage || '').slice(0, 120);
  const stageStatus = String(patch.stage_status || '').slice(0, 40);
  const safeError = patch.error ? safeMotorError(patch.error) : null;
  const result = patch.result && typeof patch.result === 'object'
    ? patch.result as Record<string, unknown>
    : null;
  const stagePatch = stage
    ? {
      [stage]: {
        status: stageStatus || 'running',
        started_at: patch.started_at || null,
        completed_at: patch.completed_at || null,
        duration_ms: patch.duration_ms ?? null,
        error: safeError,
        summary: result ? summarizeMotorResult(result) : null,
        remote_outcome: patch.remote_outcome || null,
      },
    }
    : {};
  const newStatus = patch.status ? String(patch.status) : null;
  if (
    newStatus &&
    !['queued', 'running', 'completed', 'partial', 'failed', 'interrupted', 'remote_unknown']
      .includes(newStatus)
  ) {
    throw new Error('Status de execução inválido.');
  }
  const rows = await sql.unsafe(
    `update motor_execution_runs set
      current_stage=coalesce($3,current_stage),
      status=coalesce($4,status),
      last_activity_at=now(),
      finished_at=case when $4 in ('completed','partial','failed','interrupted','remote_unknown') then now() else finished_at end,
      stage_results=stage_results || $5::jsonb,
      counters=counters || jsonb_build_object(
        'stages_recorded', jsonb_object_length(stage_results || $5::jsonb),
        'stages_completed', coalesce((counters->>'stages_completed')::integer,0) + case when $3='completed' then 1 else 0 end,
        'stages_failed', coalesce((counters->>'stages_failed')::integer,0) + case when $3='failed' then 1 else 0 end,
        'stages_remote_unknown', coalesce((counters->>'stages_remote_unknown')::integer,0) + case when $3='remote_unknown' then 1 else 0 end
      ) || $6::jsonb,
      errors=case when $7::text is null then errors else errors || jsonb_build_array(jsonb_build_object('stage',$3,'message',$7::text,'at',now())) end,
      remote_outcome=coalesce($8,remote_outcome)
     where id=$1 and lease_id=$2 and status='running' returning id,status,current_stage,last_activity_at`,
    [
      id,
      leaseId,
      stage || null,
      newStatus,
      JSON.stringify(stagePatch),
      JSON.stringify(patch.counters || {}),
      safeError,
      patch.remote_outcome || null,
    ] as any[],
  ) as unknown as DbRow[];
  return Boolean(rows[0]);
}

async function claimNextRun(): Promise<DbRow | null> {
  return await claimNextRunWithSql(sql);
}

/** Atomic queue claim exposed for isolated PostgreSQL recovery tests. */
export async function claimNextRunWithSql(
  client: any,
  tableName = 'motor_execution_runs',
): Promise<DbRow | null> {
  const table = quoteRunTable(tableName);
  const leaseId = crypto.randomUUID();
  return await client.begin(async (tx: any) => {
    // A deploy session holds this lock while the scheduler and active work drain.
    // Claims that started before that gate finish first; new claims remain queued.
    const maintenance = await tx.unsafe(
      "select pg_try_advisory_xact_lock(hashtextextended('livingfinds:deploy-maintenance', 0)) as acquired",
    ) as unknown as Array<{ acquired: boolean }>;
    if (!maintenance[0]?.acquired) return null;
    const candidates = await tx.unsafe(
      `select id,account_scope from ${table} where status='queued' order by created_at asc for update skip locked limit 1`,
    ) as unknown as DbRow[];
    const candidate = candidates[0];
    if (!candidate) return null;
    await tx.unsafe(
      'select pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`motor-run:${candidate.account_scope}`] as any[],
    );
    const active = await tx.unsafe(
      `select id from ${table} where account_scope=$1 and (status in ('running','remote_unknown') or remote_outcome='unknown') limit 1`,
      [candidate.account_scope] as any[],
    ) as unknown as DbRow[];
    if (active[0]) return null;
    const rows = await tx.unsafe(
      `update ${table} set status='running',lease_id=$2,started_at=coalesce(started_at,now()),
         lease_expires_at=now()+($3::text||' milliseconds')::interval,attempt_count=attempt_count+1,last_activity_at=now()
       where id=$1 and status='queued' returning *`,
      [candidate.id, leaseId, LEASE_MS] as any[],
    ) as unknown as DbRow[];
    return rows[0] ? { ...rows[0], lease_id: leaseId } : null;
  });
}

async function heartbeat(id: string, leaseId: string) {
  await sql.unsafe(
    `update motor_execution_runs set last_activity_at=now(),lease_expires_at=now()+($3::text||' milliseconds')::interval
      where id=$1 and lease_id=$2 and status='running'`,
    [id, leaseId, LEASE_MS] as any[],
  );
}

export type MotorInvoker = (
  name: MotorFunction,
  payload: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

export function startMotorRunWorker(invoke: MotorInvoker): void {
  if (Deno.env.get('ENABLE_MOTOR_RUN_WORKER') === 'false') {
    console.log('[motor-runs] worker desativado (ENABLE_MOTOR_RUN_WORKER=false)');
    return;
  }
  let draining = false;
  const runOne = async () => {
    if (draining) return;
    draining = true;
    try {
      const run = await claimNextRun();
      if (!run) return;
      const id = String(run.id);
      const leaseId = String(run.lease_id);
      const heartbeatTimer = setInterval(
        () =>
          void heartbeat(id, leaseId).catch((error) =>
            console.error('[motor-runs] heartbeat failed:', safeMotorError(error))
          ),
        HEARTBEAT_MS,
      );
      const timeoutMs = Math.max(
        60_000,
        Math.min(30 * 60_000, Number(Deno.env.get('MOTOR_RUN_TIMEOUT_MS') || RUN_TIMEOUT_MS)),
      );
      const work = invoke(run.function_name as MotorFunction, {
        ...(run.request_payload || {}),
        _service_role: true,
        _motor_execution_run_id: id,
        _motor_execution_lease: leaseId,
      });
      let timer: number | undefined;
      const timed = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`motor_run_timeout_${timeoutMs}ms`)),
          timeoutMs,
        ) as unknown as number;
      });
      try {
        const result = await Promise.race([work, timed]);
        const status = terminalMotorStatus(result);
        const summary = summarizeMotorResult(result);
        const remoteOutcome = motorRemoteOutcome(run.function_name as MotorFunction, result);
        await sql.unsafe(
          `update motor_execution_runs set status=$3,finished_at=now(),last_activity_at=now(),lease_expires_at=null,
            result_summary=$4::jsonb,remote_outcome=$5,errors=case when $6::text is null then errors else errors || jsonb_build_array(jsonb_build_object('stage',current_stage,'message',$6::text,'at',now())) end
           where id=$1 and lease_id=$2 and status='running'`,
          [
            id,
            leaseId,
            status,
            JSON.stringify(summary),
            remoteOutcome,
            result.error ? safeMotorError(result.error) : null,
          ] as any[],
        );
      } catch (error) {
        const message = safeMotorError(error);
        const timedOut = message.includes('motor_run_timeout_');
        await sql.unsafe(
          `update motor_execution_runs set status=$3,finished_at=now(),last_activity_at=now(),lease_expires_at=null,
            remote_outcome=$4,errors=errors || jsonb_build_array(jsonb_build_object('stage',current_stage,'message',$5::text,'at',now())),
            result_summary=jsonb_build_object('message',$5::text,'partial_stages',stage_results)
           where id=$1 and lease_id=$2 and status='running'`,
          [
            id,
            leaseId,
            timedOut || run.function_name === 'executeApprovedDecisionQueue'
              ? 'remote_unknown'
              : 'failed',
            motorFailureRemoteOutcome(run.function_name, timedOut),
            message,
          ] as any[],
        );
        const failureStatus = timedOut || run.function_name === 'executeApprovedDecisionQueue'
          ? 'remote_unknown'
          : 'failed';
        console.error(`[motor-runs] ${id} terminou em ${failureStatus}: ${message}`);
        // A timed-out handler may still be executing. The remote_unknown record
        // blocks another run for this account; never replay side effects blindly.
      } finally {
        if (timer) clearTimeout(timer);
        clearInterval(heartbeatTimer);
      }
    } catch (error) {
      console.error('[motor-runs] worker error:', safeMotorError(error));
    } finally {
      draining = false;
    }
  };
  void ensureMotorRunTable().then(() => recoverExpiredMotorRuns()).then(runOne).catch((error) =>
    console.error('[motor-runs] startup failed:', safeMotorError(error))
  );
  setInterval(() => void runOne(), 2_000);
  setInterval(
    () =>
      void recoverExpiredMotorRuns().catch((error) =>
        console.error('[motor-runs] lease recovery failed:', safeMotorError(error))
      ),
    15_000,
  );
}

export async function recoverExpiredMotorRuns(): Promise<number> {
  await ensureMotorRunTable();
  return await recoverExpiredMotorRunsWithSql(sql);
}

/** Conservatively finalizes stale leases; possible remote writes are never requeued. */
export async function recoverExpiredMotorRunsWithSql(
  client: any,
  tableName = 'motor_execution_runs',
): Promise<number> {
  const table = quoteRunTable(tableName);
  const rows = await client.unsafe(
    `update ${table} set status=case when current_stage is null then 'interrupted' else 'remote_unknown' end,finished_at=now(),last_activity_at=now(),lease_expires_at=null,
      remote_outcome=case when current_stage is null then 'not_attempted' else 'unknown' end,
      errors=errors || jsonb_build_array(jsonb_build_object('stage',current_stage,'message','process_restart_or_lease_expired; no automatic replay','at',now()))
    where status='running' and lease_expires_at < now() returning id`,
  ) as unknown as DbRow[];
  return rows.length;
}
