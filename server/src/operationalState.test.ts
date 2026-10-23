import { deepStrictEqual as eq, ok } from 'node:assert/strict';
import { sourceFreshness } from './motorDashboard.ts';
import { dashboardDecisionCounts } from '../../base44/shared/dashboardReads.js';
import { dailyMotorReadModel } from './motorDashboardPolicy.ts';
import { withCycleContext, currentCorrelationId } from './cycleContext.ts';
const now = Date.parse('2026-10-24T12:00:00Z');
Deno.test('3208 campaigns expose 1971 old/missing without labeling the whole source recent', () => {
  const rows = Array.from({ length: 3208 }, (_, i) => ({ synced_at: i < 1237 ? '2026-10-24T11:55:00Z' : i < 3000 ? '2026-10-20' : null }));
  const coverage = sourceFreshness(rows, ['synced_at'], now);
  eq(coverage.status, 'data_stale'); eq(coverage.recent_records, 1237);
  eq(coverage.old_records, 1763); eq(coverage.missing_timestamp_records, 208);
  eq(coverage.stale_records, 1971); eq(coverage.coverage_percent, 38.56);
});
Deno.test('1020 stale decisions are historical data, not an empty decision source', () => {
  const rows = Array.from({ length: 1020 }, (_, i) => ({ id: String(i), created_at: '2026-10-20T12:00:00Z', status: 'blocked' }));
  const counts = dashboardDecisionCounts(rows, now);
  eq(counts.recent_24h, 0); eq(counts.historical_total, 1020); eq(counts.stale, 1020);
  eq(counts.blocked, 1020); eq(counts.last_decision_at, '2026-10-20T12:00:00Z');
});
Deno.test('legacy correlation absence is explicit and historical remote uncertainty remains operationally blocked', () => {
  const model = dailyMotorReadModel({ latest: { status: 'exhausted', slot_key: '2026-10-23', attempt_count: 4,
    last_error: 'deployment_interrupted; automatic replay blocked' }, today: '2026-10-24', due: true, now });
  eq(model.correlation_status, 'missing_legacy_evidence'); eq(model.reconciliation, 'pending');
  eq(model.cycle_scope, 'historical'); eq(model.is_running, false); eq(model.replay, 'blocked');
});
Deno.test('every invocation gets correlation, nested stages share it, concurrent cycles stay isolated', async () => {
  const ids = await Promise.all([0,1].map(async () => await withCycleContext({}, async root => {
    ok(root.correlation_id); eq(currentCorrelationId(), root.correlation_id);
    await withCycleContext({}, async stage => { eq(stage.correlation_id, root.correlation_id); });
    return root.correlation_id;
  })));
  ok(ids[0] !== ids[1]);
});
