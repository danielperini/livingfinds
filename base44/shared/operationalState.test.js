import test from 'node:test';
import assert from 'node:assert/strict';
import { alertClassification, groupOperationalAlerts, decisionRecoveryEligibility, schedulerOperationalHealth } from './operationalState.js';
const now = Date.parse('2026-10-24T12:00:00Z');
const fresh = '2026-10-24T11:55:00Z';
test('historical and stale alerts stay queryable, never actionable; no evidence is resolved', () => {
  const rows = [{ id: 'old', created_at: '2026-10-20' }, { id: 'resolved', status: 'resolved' }, { id: 'history', status: 'historical' }];
  const before = JSON.stringify(rows);
  const result = groupOperationalAlerts(rows, now);
  assert.equal(result.active.length, 0); assert.equal(result.history.length, 3);
  assert.equal(JSON.stringify(rows), before);
  assert.equal(alertClassification({ created_at: fresh }, now), 'stale_without_current_evidence');
});
test('duplicates group by account, ASIN, campaign and cause', () => {
  const base = { amazon_account_id: 'a', asin: 'p', campaign_id: 'c', alert_type: 'low_stock', last_detected_at: fresh, data_freshness: 'fresh' };
  const result = groupOperationalAlerts([{ ...base, id: '1' }, { ...base, id: '2' }, { ...base, id: '3', campaign_id: 'other' }], now);
  assert.equal(result.active.length, 2); assert.equal(result.active[0].occurrences, 2);
  assert.equal(result.history[0].classification, 'duplicate');
});
test('remote unknown remains visible despite age or an unsupported resolved flag', () => {
  const row = { status: 'resolved', remote_outcome: 'unknown', created_at: '2020-01-01' };
  assert.equal(alertClassification(row, now), 'remote_unknown');
  assert.equal(groupOperationalAlerts([row], now).reconciliation.length, 1);
  assert.equal(decisionRecoveryEligibility(row, now).safe, false);
});
test('technical failure is explicit and a tick or unrelated success never clears job errors', () => {
  assert.equal(alertClassification({ alert_type: 'scheduler_error', created_at: fresh }, now), 'technical_failure');
  const health = schedulerOperationalHealth({ enabled: true, started: true, jobs_loaded: 4, last_tick_at: fresh,
    last_success_at: fresh, job_errors: { broken: { job: 'broken', cause: 'connection refused', at: fresh } } }, Date.parse(fresh));
  assert.equal(health.ticking, true); assert.equal(health.healthy, false);
  assert.equal(health.active_job_errors[0].cause, 'connection refused');
});
test('stale or undated proposals require new collection; sent proposals require reconciliation', () => {
  assert.equal(decisionRecoveryEligibility({ created_at: '2026-10-20' }, now).reason, 'new_collection_and_decision_required');
  assert.equal(decisionRecoveryEligibility({}, now).safe, false);
  assert.equal(decisionRecoveryEligibility({ created_at: fresh, amazon_request_id: 'request' }, now).reason, 'reconciliation_required');
  assert.equal(decisionRecoveryEligibility({ created_at: fresh }, now).safe, true);
});
