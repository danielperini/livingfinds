import { assertEquals } from 'jsr:@std/assert';
import { campaignCoverageEligible } from './campaignCoverageEligibility.ts';

const product = { asin: 'B0GNW1Q6V3', sku: 'SKU-002314V', available_quantity: 3 };

Deno.test('paused low-stock products without sales or activity qualify for discovery', () => {
  assertEquals(campaignCoverageEligible({ ...product, campaign_status: 'paused',
    pause_reason: 'low_stock_one_unit', sales: 0, acos: 0, impressions: 0 }), true);
  assertEquals(campaignCoverageEligible({ ...product, available_quantity: 1 }), true);
});

Deno.test('all eleven requested ASINs qualify without a metrics history', () => {
  const inventory = [
    ['B0HFB78DNP', 60], ['B0GFQ7SY5W', 24], ['B0HBM8V2DP', 92],
    ['B0GNW1Q6V3', 3], ['B0FHX1HPMT', 45], ['B0F45JG27L', 59],
    ['B0GHP9PPWN', 25], ['B0FN4RCXY2', 23], ['B0GHP68123', 8],
    ['B0GR6GXS1B', 15], ['B0GHP958MV', 24],
  ];
  for (const [asin, available_quantity] of inventory) {
    assertEquals(campaignCoverageEligible({ ...product, asin, available_quantity }), true);
  }
});

Deno.test('zero and unknown stock cannot launch discovery', () => {
  for (const available_quantity of [0, -1, undefined, null, '', 'invalid']) {
    assertEquals(campaignCoverageEligible({ ...product, available_quantity }), false);
  }
});

Deno.test('offer restrictions and explicit manual locks still block coverage', () => {
  for (const restriction of [
    { listing_buyable: false }, { listing_suppressed: true }, { offer_active: false },
    { campaign_pause_lock: true }, { ads_scope_status: 'manual_block' },
    { asin: '' }, { sku: '' },
  ]) assertEquals(campaignCoverageEligible({ ...product, ...restriction }), false);
});
