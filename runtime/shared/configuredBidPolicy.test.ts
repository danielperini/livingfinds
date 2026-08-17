import { strict as assert } from 'node:assert';
import { clampBidToConfiguredPolicy, resolveConfiguredBidPolicy } from './configuredBidPolicy.ts';

Deno.test('uses the stricter configured bid/CPC limit', () => {
  const policy = resolveConfiguredBidPolicy({ min_bid: 0.2, max_bid: 3, max_cpc: 0.7 });
  assert.equal(policy.ceiling, 0.7);
  assert.equal(clampBidToConfiguredPolicy(1.2, policy), 0.7);
});

Deno.test('uses max_bid when CPC maximum is disabled', () => {
  const policy = resolveConfiguredBidPolicy({ min_bid: 0.2, max_bid: 2.35, max_cpc: null });
  assert.equal(policy.ceiling, 2.35);
});

Deno.test('does not let a conflicting minimum exceed the ceiling', () => {
  const policy = resolveConfiguredBidPolicy({ min_bid: 0.8, max_bid: 3, maximum_cpc: 0.7 });
  assert.equal(policy.minBid, 0.7);
  assert.equal(policy.ceiling, 0.7);
});
