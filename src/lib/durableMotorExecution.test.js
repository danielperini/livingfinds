import assert from 'node:assert/strict';
import test from 'node:test';
import { getDurableMotorExecution, listDurableMotorExecutions, startDurableMotorExecution } from './durableMotorExecution.js';

test('durable start returns the persisted run ID without waiting for completion', async () => {
  let received;
  const base44 = { functions: { invoke: async (name, payload) => {
    received = { name, payload };
    return { data: { run_id: 'run-123', status: 'queued', status_url: '/api/motor-runs/run-123' } };
  } } };
  const accepted = await startDurableMotorExecution(base44, {
    functionName: 'runUnifiedDecisionEngine', accountId: 'account-1', requestKey: 'cycle-1', payload: { dry_run: true },
  });
  assert.equal(accepted.run_id, 'run-123');
  assert.equal(received.name, 'startMotorExecution');
  assert.equal(received.payload.function_name, 'runUnifiedDecisionEngine');
  assert.equal(received.payload.payload.amazon_account_id, 'account-1');
});

test('run status lookup reports failures instead of inventing an empty result', async () => {
  const base44 = { functions: { invoke: async () => ({ data: { ok: false, error: 'ledger unavailable' } }) } };
  await assert.rejects(() => getDurableMotorExecution(base44, 'run-123'), /ledger unavailable/);
  await assert.rejects(() => listDurableMotorExecutions(base44, 'account-1'), /ledger unavailable/);
});

test('run list preserves actual empty state and does not synthesize progress', async () => {
  const base44 = { functions: { invoke: async (_name, payload) => {
    assert.equal(payload.account_id, 'account-1');
    return { data: { ok: true, runs: [] } };
  } } };
  assert.deepEqual(await listDurableMotorExecutions(base44, 'account-1'), []);
});
