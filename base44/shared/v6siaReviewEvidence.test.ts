import {
  latestRowsByKey,
  v6siaDecisionOutcome,
  v6siaImplementationStatus,
} from './v6siaReviewEvidence.ts';

Deno.test('V6SIA reports implementation only after remote confirmation', () => {
  const decisions = [
    { id: '1', status: 'executed', confirmation_status: 'confirmed' },
    { id: '2', status: 'completed', confirmation_status: 'confirmed' },
  ];
  if (v6siaImplementationStatus(decisions) !== 'implemented') throw new Error('expected implemented');
  if (v6siaImplementationStatus([{ status: 'executed', confirmation_status: 'pending' }]) !== 'pending_confirmation') {
    throw new Error('sent is not confirmed');
  }
  if (v6siaImplementationStatus([{ status: 'failed', confirmation_status: 'not_applicable' }]) !== 'not_implemented') {
    throw new Error('failed action must remain not implemented');
  }
  if (v6siaImplementationStatus([]) !== 'not_applicable') throw new Error('empty action set is not applicable');
});

Deno.test('V6SIA preserves partial execution outcomes per decision', () => {
  const status = v6siaImplementationStatus([
    { status: 'executed', confirmation_status: 'confirmed' },
    { status: 'blocked', confirmation_status: 'not_applicable' },
  ]);
  if (status !== 'partial') throw new Error('expected partial');
  const outcome = v6siaDecisionOutcome({
    id: 'd1', action: 'set_bid', entity_type: 'keyword', entity_id: 'k1',
    status: 'blocked', confirmation_status: 'not_applicable', error_message: 'invalid bid',
  });
  if (outcome.implementation_status !== 'not_implemented' || outcome.error !== 'invalid bid') {
    throw new Error('per-decision outcome must be explicit');
  }
});

Deno.test('V6SIA keeps newest report revision per natural key', () => {
  const rows = latestRowsByKey([
    { id: 'old', key: '2026-10-11|c1', at: '2026-10-12T00:00:00Z' },
    { id: 'new', key: '2026-10-11|c1', at: '2026-10-12T01:00:00Z' },
    { id: 'other', key: '2026-10-11|c2', at: '2026-10-12T00:30:00Z' },
  ], row => String(row.key), row => String(row.at));
  if (rows.length !== 2 || !rows.some(row => row.id === 'new') || rows.some(row => row.id === 'old')) {
    throw new Error('must dedupe by key and retain newest revision');
  }
});
