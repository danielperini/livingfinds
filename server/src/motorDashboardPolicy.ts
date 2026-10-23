import { safeMotorError } from './motorRunPolicy.ts';
import { schedulerReplayBlocked } from './schedulerPolicy.ts';

type Row = Record<string, any>;
const age = (value: any, now: number) => {
  const at = Date.parse(value || '');
  return Number.isFinite(at) && at <= now ? Math.floor((now - at) / 1000) : null;
};

/** Read model only: does not recover, retry, reconcile or modify the source row. */
export function dailyMotorReadModel(input: { latest?: Row | null; current?: Row | null; unknown?: Row | null;
  today: string; due: boolean; now?: number; scheduler?: Row; sourceErrors?: Array<{ source: string; error: string }> }) {
  const now = input.now ?? Date.now();
  const run = input.latest;
  const durable = input.current;
  const current = durable?.status === 'running' && Date.parse(durable.lease_expires_at || '') > now
    ? durable : run?.status === 'running' && !run.finished_at && run.slot_key === input.today &&
      (age(run.updated_at || run.started_at, now) ?? Infinity) < 600 ? run : null;
  const error = String(run?.last_error || '');
  const inferredUnknown = schedulerReplayBlocked({ last_error: error });
  const unknown = input.unknown || (inferredUnknown || run?.remote_outcome === 'unknown' || run?.status === 'remote_unknown' ? run : null);
  const states: string[] = [];
  if (current) states.push('running');
  if (run?.status === 'exhausted' && !current) states.push('historical_exhausted');
  if (unknown) states.push('blocked_remote_unknown', 'reconciliation_pending');
  if (run?.status === 'succeeded') states.push('succeeded');
  if (input.scheduler?.status === 'technical_failure' || input.sourceErrors?.some(item => ['scheduler','scheduler_jobs'].includes(item.source)) || (input.scheduler?.last_error && (!input.scheduler.last_success_at || Date.parse(input.scheduler.last_error_at || '') > Date.parse(input.scheduler.last_success_at)))) states.push('scheduler_error');
  if (input.sourceErrors?.length) states.push('technical_failure');
  const statusAge = age(run?.finished_at || run?.updated_at || run?.started_at, now);
  if (run?.status === 'running' && !current) states.push('data_stale');
  return {
    date: run?.slot_key || input.today, last_cycle_date: run?.slot_key || null, checked_at: new Date(now).toISOString(),
    scheduled_local_time: '01:25', due: input.due,
    status: String(run?.status || (input.due ? 'missing' : 'not_due')),
    display_state: current ? 'running' : unknown ? 'blocked_remote_unknown' : states[0] || 'no_current_cycle', states,
    is_running: Boolean(current), current_run: current ? { id: current.id || null, started_at: current.started_at, correlation_id: current.correlation_id || null, status: 'running' } : null,
    no_current_execution: !current, current_execution_known: !input.sourceErrors?.length,
    correlation_id: run?.correlation_id || run?.result_summary?.correlation_id || null,
    correlation_status: run?.correlation_id || run?.result_summary?.correlation_id ? 'recorded' : 'missing_legacy_evidence',
    cycle_scope: current ? 'current_and_history' : 'historical',
    attempts: Number(run?.attempt_count || 0), recovery_count: Number(run?.recovery_count || 0),
    started_at: run?.started_at ?? null, finished_at: run?.finished_at ?? null,
    status_age_seconds: statusAge, last_error: error ? safeMotorError(error) : null,
    confirmed_success: run?.status === 'succeeded' && !unknown,
    remote_outcome: unknown ? 'unknown' : run?.remote_outcome || 'not_recorded',
    replay: unknown || run?.status === 'exhausted' ? 'blocked' : 'not_requested',
    reconciliation: unknown ? 'pending' : 'not_required',
    block_reason: unknown ? safeMotorError(error || 'remote_outcome_unknown_reconcile_before_replay') : run?.status === 'exhausted' ? 'attempt_limit_reached' : null,
    source_errors: input.sourceErrors || [],
  };
}
