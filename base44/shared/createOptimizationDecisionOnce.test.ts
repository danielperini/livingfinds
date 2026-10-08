import { strict as assert } from 'node:assert';
import { createOptimizationDecisionOnce } from './createOptimizationDecisionOnce.ts';
const payload = { amazon_account_id: 'account', idempotency_key: 'same-action' };

Deno.test('idempotency conflict reuses existing decision without reactivating it', async () => {
  const existing = { id: 'prior', status: 'cancelled', ...payload };
  const result = await createOptimizationDecisionOnce({
    create: async () => { throw new Error('duplicate key value violates unique constraint "optimization_decision_idempotency_unique"'); },
    filter: async (filter: any) => { assert.deepEqual(filter, payload); return [existing]; },
  }, payload);
  assert.equal(result, existing);
  assert.equal(result.status, 'cancelled');
});

Deno.test('unrelated database failures are not hidden', async () => {
  const failure = new Error('connection lost');
  await assert.rejects(createOptimizationDecisionOnce({ create: async () => { throw failure; } }, payload), error => error === failure);
});

Deno.test('unresolved unique conflict still fails', async () => {
  const failure = new Error('optimization_decision_idempotency_unique');
  await assert.rejects(createOptimizationDecisionOnce({ create: async () => { throw failure; }, filter: async () => [] }, payload), error => error === failure);
});
