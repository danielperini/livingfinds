import { createSalesModeWasteDecision } from './salesModeWasteDecisionPersistence.ts';

function fixture(response: (decision: Record<string, unknown>) => Record<string, unknown>) {
  const calls: Array<Record<string, unknown>> = [];
  const base44 = { asServiceRole: {
    entities: { OptimizationDecision: { create: async () => { throw new Error('must use explicit transactional operation'); }, filter: async () => [] } },
    functions: { invoke: async (_name: string, payload: Record<string, unknown>) => {
      calls.push(payload.decision as Record<string, unknown>);
      return { data: response(payload.decision as Record<string, unknown>) };
    } },
  } };
  return { base44, calls };
}

Deno.test('sales-mode decisions use the explicit idempotent PostgreSQL operation', async () => {
  const input = { id: 'decision-1', amazon_account_id: 'acct-1', idempotency_key: 'waste|acct-1|camp-1|target-1|2026-11-05', cycle_key: '2026-11-05', status: 'approved' };
  const { base44, calls } = fixture(() => ({ ok: true, created: true, reused: false, conflict: null, decision: input }));
  const result = await createSalesModeWasteDecision(base44, input);
  if (!result.created || result.reused || result.decision?.id !== 'decision-1') throw new Error('new decision must be reported as created');
  if (calls.length !== 1 || calls[0].idempotency_key !== input.idempotency_key || calls[0].cycle_key !== input.cycle_key) throw new Error('logical key was not sent to idempotent endpoint');
});

Deno.test('replay reuses confirmed decision without changing its state or result', async () => {
  const canonical = { id: 'decision-2', amazon_account_id: 'acct-1', idempotency_key: 'waste|acct-1|camp-1|target-1|2026-11-05', cycle_key: '2026-11-05', status: 'completed', confirmation_status: 'confirmed', value_before: 0.7, value_after: 0.49, execution_result: 'confirmed-result' };
  const { base44, calls } = fixture(() => ({ ok: true, created: false, reused: true, conflict: null, decision: canonical }));
  const result = await createSalesModeWasteDecision(base44, { ...canonical, status: 'approved', confirmation_status: 'pending', value_after: 0.42 });
  if (!result.reused || result.created || result.decision?.id !== canonical.id) throw new Error('existing decision must be reused');
  if (JSON.stringify(result.decision) !== JSON.stringify(canonical) || calls.length !== 1) throw new Error('existing decision was mutated or recreated');
});

Deno.test('divergent intent is surfaced as conflict, preserving the canonical row', async () => {
  const canonical = { id: 'decision-3', amazon_account_id: 'acct-1', idempotency_key: 'waste|acct-1|camp-1|target-1|2026-11-05', cycle_key: '2026-11-05', action: 'reduce_bid', value_after: 0.49, status: 'completed', confirmation_status: 'confirmed' };
  const { base44, calls } = fixture(() => ({ ok: true, created: false, reused: false, conflict: { constraint: 'optimization_decision_idempotency_unique', fields: ['value_after'] }, decision: canonical }));
  const result = await createSalesModeWasteDecision(base44, { ...canonical, value_after: 0.42 });
  if (!result.conflict?.fields.includes('value_after') || result.created || result.reused) throw new Error('divergent intent must be a conflict');
  if (result.decision?.id !== canonical.id || calls.length !== 1) throw new Error('canonical row not preserved');
});

Deno.test('persistence failure is not reported as success', async () => {
  const { base44 } = fixture(() => ({ ok: false, error: 'database unavailable' }));
  try {
    await createSalesModeWasteDecision(base44, { amazon_account_id: 'acct-1', idempotency_key: 'key', cycle_key: '2026-11-05' });
    throw new Error('expected persistence failure');
  } catch (error) {
    if (!String(error).includes('database unavailable')) throw error;
  }
});

Deno.test('missing cycle key is rejected before remote persistence', async () => {
  const { base44, calls } = fixture(() => ({ ok: true, created: true, reused: false, conflict: null, decision: {} }));
  try {
    await createSalesModeWasteDecision(base44, { amazon_account_id: 'acct-1', idempotency_key: 'key' });
    throw new Error('expected missing cycle key rejection');
  } catch (error) {
    if (!String(error).includes('cycle_key')) throw error;
  }
  if (calls.length !== 0) throw new Error('invalid intent version must not reach persistence');
});
