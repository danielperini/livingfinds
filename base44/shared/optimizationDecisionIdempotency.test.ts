import { createOrLoadOptimizationDecision } from './optimizationDecisionIdempotency.ts';

Deno.test('generic create remains the default for decisions without an idempotency key', async () => {
  const expected = { id: 'generic-1', amazon_account_id: 'account-1' };
  let createCalls = 0;
  const result = await createOrLoadOptimizationDecision({
    create: async () => { createCalls++; return expected; },
    filter: async () => { throw new Error('generic create must not require an idempotency lookup'); },
  }, { amazon_account_id: 'account-1', decision_type: 'manual_review' });
  if (!result.created || result.reused || result.decision?.id !== expected.id || createCalls !== 1) {
    throw new Error('Generic create behavior changed.');
  }
});

Deno.test('concurrent decision creation resolves the unique-key race to the canonical row', async () => {
  const canonical = { id: 'decision-1', amazon_account_id: 'account-1', idempotency_key: 'daily|campaign-1' };
  let lookupQuery: Record<string, unknown> | null = null;
  const result = await createOrLoadOptimizationDecision({
    create: async () => { throw new Error('duplicate key value violates unique constraint "optimization_decision_idempotency_unique"'); },
    filter: async (query, sort, limit, offset) => {
      lookupQuery = query;
      if (sort !== '-created_at' || limit !== 10 || offset !== 0) throw new Error('wrong canonical lookup pagination');
      return [canonical];
    },
  }, { amazon_account_id: 'account-1', idempotency_key: 'daily|campaign-1' });

  if (result.created || result.decision?.id !== 'decision-1') throw new Error('race must reuse the canonical decision');
  if (JSON.stringify(lookupQuery) !== JSON.stringify({ amazon_account_id: 'account-1', idempotency_key: 'daily|campaign-1' })) {
    throw new Error('canonical lookup must be scoped by account and key');
  }
});

Deno.test('legacy adapter reports divergent intent and duplicate historical rows as conflicts', async () => {
  const canonical = { id: 'decision-1', amazon_account_id: 'account-1', idempotency_key: 'daily|campaign-1', action: 'pause_campaign', value_after: 'PAUSED' };
  const divergent = await createOrLoadOptimizationDecision({
    create: async () => { throw new Error('must not create'); },
    filter: async () => [canonical],
  }, { ...canonical, action: 'enable_campaign' });
  if (!divergent.conflict?.fields.includes('action') || divergent.reused || divergent.created) throw new Error('Divergent intent must be a conflict.');

  const duplicated = await createOrLoadOptimizationDecision({
    create: async () => { throw new Error('must not create'); },
    filter: async () => [canonical, { ...canonical, id: 'decision-2' }],
  }, canonical);
  if (!duplicated.conflict?.fields.includes('multiple_existing_rows') || duplicated.decision !== null) throw new Error('Historical duplicate must not be silently canonicalized.');
});

Deno.test('legacy helper preserves generic create behavior and rethrows unrelated database errors', async () => {
  const failure = new Error('database unavailable');
  let lookedUp = false;
  try {
    await createOrLoadOptimizationDecision({
      create: async () => { throw failure; },
      filter: async () => { lookedUp = true; return []; },
    }, { amazon_account_id: 'account-1', idempotency_key: 'key' });
    throw new Error('expected database error');
  } catch (error) {
    if (error !== failure || !lookedUp) throw error;
  }
});

Deno.test('missing canonical row after a unique-key conflict is not marked successful', async () => {
  const conflict = new Error('duplicate key value violates unique constraint "optimization_decision_idempotency_unique"');
  try {
    await createOrLoadOptimizationDecision({ create: async () => { throw conflict; }, filter: async () => [] }, {
      amazon_account_id: 'account-1', idempotency_key: 'daily|campaign-1',
    });
    throw new Error('expected unresolved conflict');
  } catch (error) {
    if (error !== conflict) throw error;
  }
});
