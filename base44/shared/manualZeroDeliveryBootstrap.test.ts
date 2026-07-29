import {
  buildBootstrapIdempotencyKey,
  calculateBootstrapBid,
  classifyAmazonFailure,
  diagnoseZeroDelivery,
  eligibleForBudgetIncrease,
} from './manualZeroDeliveryBootstrap.ts';

function assert(value: unknown, message = 'assertion failed'): asserts value {
  if (!value) throw new Error(message);
}
const base = {
  campaignType: 'SP', targetingType: 'manual', matchType: 'exact',
  structureComplete: true, remoteEnabled: true, metricsFresh: true,
  stock: 10, stockEligible: true, listingEligible: true,
  impressions: 0, clicks: 0, spend: 0,
  createdAt: '2026-01-01T00:00:00Z', attempts: 0,
};
const now = new Date('2026-01-10T00:00:00Z');

Deno.test('01 candidate is eligible', () => assert(diagnoseZeroDelivery(base, now).eligible));
Deno.test('02 only SP', () => assert(diagnoseZeroDelivery({ ...base, campaignType: 'SB' }, now).status === 'ineligible_campaign_type'));
Deno.test('03 only manual', () => assert(diagnoseZeroDelivery({ ...base, targetingType: 'auto' }, now).status === 'ineligible_targeting_type'));
Deno.test('04 only exact', () => assert(diagnoseZeroDelivery({ ...base, matchType: 'phrase' }, now).status === 'ineligible_match_type'));
Deno.test('05 complete structure', () => assert(diagnoseZeroDelivery({ ...base, structureComplete: false }, now).status === 'incomplete_structure'));
Deno.test('06 Amazon enabled confirmation', () => assert(diagnoseZeroDelivery({ ...base, remoteEnabled: false }, now).status === 'amazon_entity_not_enabled'));
Deno.test('07 fresh metrics required', () => assert(diagnoseZeroDelivery({ ...base, metricsFresh: false }, now).status === 'metrics_unavailable'));
Deno.test('08 stock required', () => assert(diagnoseZeroDelivery({ ...base, stock: 0 }, now).status === 'out_of_stock'));
Deno.test('09 listing eligible required', () => assert(diagnoseZeroDelivery({ ...base, listingEligible: false }, now).status === 'listing_ineligible'));
Deno.test('10 impressions mean delivering', () => assert(diagnoseZeroDelivery({ ...base, impressions: 1 }, now).status === 'delivering'));
Deno.test('11 clicks mean delivering', () => assert(diagnoseZeroDelivery({ ...base, clicks: 1 }, now).status === 'delivering'));
Deno.test('12 spend means delivering', () => assert(diagnoseZeroDelivery({ ...base, spend: .01 }, now).status === 'delivering'));
Deno.test('13 minimum age is 7 days', () => assert(diagnoseZeroDelivery({ ...base, createdAt: '2026-01-04T12:00:00Z' }, now).status === 'learning_under_7d'));
Deno.test('14 maximum two attempts', () => assert(diagnoseZeroDelivery({ ...base, attempts: 2 }, now).status === 'replacement_review_required'));
Deno.test('15 cooldown is 72h', () => assert(diagnoseZeroDelivery({ ...base, attempts: 1, lastRescueAt: '2026-01-08T00:00:00Z' }, now).status === 'cooldown'));
Deno.test('16 bid increase is capped at 10 percent and economic cap', () => {
  const result = calculateBootstrapBid({ currentBid: 1, suggestedLow: 2, suggestedMid: 3, safeMaxCpc: 1.15, maxBid: 5 });
  assert(!result.eligible && result.bid === 1);
});
Deno.test('19 bid respects the absolute R$0.70 ceiling', () => {
  const result = calculateBootstrapBid({ currentBid: 0.60, suggestedLow: 0.90, suggestedMid: 1, safeMaxCpc: 1, maxBid: 5 });
  assert(result.eligible && result.bid === 0.66);
});
Deno.test('20 campaigns older than 15 days require replacement review', () => {
  assert(diagnoseZeroDelivery({ ...base, createdAt: '2025-12-01T00:00:00Z' }, now).status === 'replacement_review_required');
});
Deno.test('21 protected priority window permits an older campaign', () => {
  assert(diagnoseZeroDelivery({
    ...base,
    createdAt: '2025-12-20T00:00:00Z',
    maxAgeDays: 45,
  }, now).eligible);
});
Deno.test('17 bid never rises without economic cap', () => assert(!calculateBootstrapBid({ currentBid: 1, suggestedLow: 1.2 }).eligible));
Deno.test('18 idempotency and budget winner protection', () => {
  const key1 = buildBootstrapIdempotencyKey({ accountId: 'a', campaignId: 'c', keywordId: 'k', attempt: 1, window: '2026-01-10', bid: 1.2 });
  const key2 = buildBootstrapIdempotencyKey({ accountId: 'a', campaignId: 'c', keywordId: 'k', attempt: 1, window: '2026-01-10', bid: 1.2 });
  assert(key1 === key2);
  assert(eligibleForBudgetIncrease({ winner: true, impressions: 10, spend: 9, orders: 1, sales: 20, budgetRatio: .85, campaign: {} }));
  assert(!eligibleForBudgetIncrease({ winner: true, impressions: 0, spend: 0, orders: 0, sales: 0, budgetRatio: 1, campaign: {} }));
  assert(classifyAmazonFailure(429) === 'retryable' && classifyAmazonFailure(400) === 'terminal');
});
