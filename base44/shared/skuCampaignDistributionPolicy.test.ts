import { assertEquals } from 'jsr:@std/assert@1';
import {
  evaluateManualExactExpansion,
  resolveManualCampaignFloor,
  resolveManualExpansionLimits,
} from './skuCampaignDistributionPolicy.ts';

Deno.test('manual campaigns are not required as a floor, even for legacy callers', () => {
  assertEquals(resolveManualCampaignFloor(5), 0);
  assertEquals(resolveManualCampaignFloor(undefined), 0);
});

Deno.test('distribution clamps legacy fan-out to one new manual campaign per SKU per cycle', () => {
  assertEquals(resolveManualExpansionLimits(30, 15), { perRun: 10, perSku: 1 });
  assertEquals(resolveManualExpansionLimits(0, 0), { perRun: 0, perSku: 0 });
});

Deno.test('manual exact promotion requires fresh available stock and two verified same-SKU orders', () => {
  const base = {
    availableFbaUnits: 59,
    sameSkuAttributionVerified: true,
    sameSkuOrders: 2,
    manualCampaignCount: 2,
    createdThisCycle: 0,
    alreadyExact: false,
  };
  assertEquals(evaluateManualExactExpansion(base).eligible, true);
  assertEquals(evaluateManualExactExpansion({ ...base, sameSkuOrders: 1 }).reason, 'requires_two_verified_same_sku_orders');
  assertEquals(evaluateManualExactExpansion({ ...base, sameSkuAttributionVerified: false }).reason, 'same_sku_attribution_unverified');
  assertEquals(evaluateManualExactExpansion({ ...base, availableFbaUnits: 2 }).reason, 'insufficient_available_fba_for_manual_expansion');
  assertEquals(evaluateManualExactExpansion({ ...base, availableFbaUnits: 4 }).reason, 'insufficient_available_fba_for_manual_expansion');
});

Deno.test('campaign count is not treated as a target and over-concentrated SKUs stop expanding', () => {
  const crowded = evaluateManualExactExpansion({
    availableFbaUnits: 5,
    sameSkuAttributionVerified: true,
    sameSkuOrders: 8,
    manualCampaignCount: 47,
    createdThisCycle: 0,
    alreadyExact: false,
  });
  assertEquals(crowded.reason, 'manual_campaign_cap_reached');

  const oneOrderWithLargeStock = evaluateManualExactExpansion({
    availableFbaUnits: 59,
    sameSkuAttributionVerified: true,
    sameSkuOrders: 1,
    manualCampaignCount: 2,
    createdThisCycle: 0,
    alreadyExact: false,
  });
  assertEquals(oneOrderWithLargeStock.reason, 'requires_two_verified_same_sku_orders');
});

Deno.test('a SKU can receive at most one new exact campaign in a single cycle', () => {
  assertEquals(evaluateManualExactExpansion({
    availableFbaUnits: 24,
    sameSkuAttributionVerified: true,
    sameSkuOrders: 9,
    manualCampaignCount: 1,
    createdThisCycle: 1,
    alreadyExact: false,
  }).reason, 'per_sku_cycle_cap_reached');
});
