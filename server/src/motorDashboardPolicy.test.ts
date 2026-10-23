import { deepStrictEqual as eq, ok } from 'node:assert/strict';
import { dailyMotorReadModel } from './motorDashboardPolicy.ts';
import { schedulerReplayBlocked, shouldDispatchRun, shouldRecoverDailyCatchUpRun } from './schedulerPolicy.ts';

const now = Date.parse('2026-10-24T12:00:00Z');
const historical = { slot_key: '2026-10-23', status: 'exhausted', attempt_count: 6,
  started_at: '2026-10-23T04:25:00Z', finished_at: '2026-10-23T04:30:00Z',
  last_error: 'deployment_interrupted; remote state not confirmed; automatic replay blocked' };

Deno.test('daily read model keeps the 23/10 record intact, unknown and historical with no current execution', () => {
  const before = JSON.stringify(historical);
  const result = dailyMotorReadModel({ latest: historical, today: '2026-10-24', due: true, now });
  eq(result.status, 'exhausted'); eq(result.remote_outcome, 'unknown'); eq(result.replay, 'blocked'); eq(result.reconciliation, 'pending');
  eq(result.is_running, false); eq(result.no_current_execution, true); eq(result.last_cycle_date, '2026-10-23');
  eq(result.confirmed_success, false); ok(result.states.includes('historical_exhausted'));
  ok(result.states.includes('blocked_remote_unknown')); ok(result.status_age_seconds! > 86400);
  eq(JSON.stringify(historical), before);
});

Deno.test('running requires live evidence and an unexpired lease; old running rows are stale', () => {
  const stale = dailyMotorReadModel({ latest: { ...historical, status: 'running', finished_at: null, last_error: null }, today: '2026-10-24', due: true, now });
  eq(stale.is_running, false); ok(stale.states.includes('data_stale'));
  const current = dailyMotorReadModel({ latest: historical, today: '2026-10-24', due: true, now,
    current: { id: 'current', status: 'running', started_at: '2026-10-24T11:59:00Z', lease_expires_at: '2026-10-24T12:02:00Z' } });
  eq(current.is_running, true); eq(current.current_run?.id, 'current');
  eq(current.reconciliation, 'pending'); // old uncertainty does not disappear when another run exists
});

Deno.test('scheduler failures and unavailable ledgers are explicit, never an invented idle state', () => {
  const model = dailyMotorReadModel({ today: '2026-10-24', due: true, now,
    sourceErrors: [{ source: 'current_run', error: 'offline' }], scheduler: { last_error: 'offline' } });
  eq(model.current_execution_known, false); ok(model.states.includes('scheduler_error'));
  const succeeded = dailyMotorReadModel({ latest: { slot_key: '2026-10-24', status: 'succeeded', finished_at: '2026-10-24T11:00:00Z' }, today: '2026-10-24', due: true, now });
  eq(succeeded.confirmed_success, true); eq(succeeded.is_running, false); ok(succeeded.states.includes('succeeded'));
});

Deno.test('historical unknown scheduler rows cannot auto-recover or dispatch after a refresh or restart', () => {
  eq(schedulerReplayBlocked(historical), true);
  eq(schedulerReplayBlocked({ last_error: 'Etapa excedeu 180000 ms; estado remoto desconhecido.' }), true);
  eq(shouldDispatchRun(historical, now, 12), false);
  eq(shouldRecoverDailyCatchUpRun({ name: 'daily', function: 'runCanonicalDecisionCycle', cron: '25 1 * * *', catch_up_daily: true }, historical, now), false);
});
