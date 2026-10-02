import { assertEquals } from 'jsr:@std/assert';
import { stockAdsDecision } from './stockAdsPolicy.ts';
import { hasFreshAdsInventory } from './stockAdsPolicy.ts';
import { inventoryAvailable, campaignStateConfirmed, isStockCampaignPause } from './inventorySyncPolicy.ts';

Deno.test('missing, ambiguous and invalid inventory never becomes sellable or zero', () => {
  for (const quantity of [undefined, null, '', true, -1, 1.5, 'bad']) {
    assertEquals(inventoryAvailable({ totalQuantity: 60, inventoryDetails: { fulfillableQuantity: quantity } }), null);
    assertEquals(stockAdsDecision({ available_quantity: quantity, fba_inventory: 60 }), 'unknown');
  }
  for (const status of ['mapping_conflict', 'invalid_inventory', 'not_found']) {
    assertEquals(stockAdsDecision({ available_quantity: 60, catalog_sync_status: status }), 'unknown');
  }
  assertEquals(inventoryAvailable({ inventoryDetails: { fulfillableQuantity: 0 } }), 0);
});

Deno.test('activation requires successful recent inventory sync', () => {
  const now = Date.parse('2026-10-02T12:00:00Z');
  const product = { available_quantity: 1, catalog_sync_status: 'success', last_catalog_sync_at: new Date(now).toISOString() };
  assertEquals(hasFreshAdsInventory(product, now), true);
  assertEquals(hasFreshAdsInventory(product, now + 31 * 60_000), false);
  assertEquals(hasFreshAdsInventory(product, now - 1), false);
  assertEquals(hasFreshAdsInventory({ ...product, catalog_sync_status: 'failed' }, now), false);
});

Deno.test('Amazon multi-status must confirm the requested campaign individually', () => {
  assertEquals(campaignStateConfirmed(207, { campaigns: { success: [{ campaignId: '42' }] } }, '42'), true);
  assertEquals(campaignStateConfirmed(207, { campaigns: { error: [{ campaignId: '42' }] } }, '42'), false);
  assertEquals(campaignStateConfirmed(200, {} , '42'), false);
  assertEquals(campaignStateConfirmed(200, { campaigns: { success: [{ campaignId: '41' }] } }, '42'), false);
  assertEquals(campaignStateConfirmed(500, { campaigns: { success: [{ campaignId: '42' }] } }, '42'), false);
});

Deno.test('restock never overrides financial, manual or unknown campaign pauses', () => {
  assertEquals(isStockCampaignPause({ last_pause_reason: 'out_of_stock_confirmed' }), true);
  for (const reason of ['USER_MANUAL_PRODUCT_LOCK', 'negative_margin', 'budget_exhausted', '', 'unknown']) {
    assertEquals(isStockCampaignPause({ last_pause_reason: reason }), false);
  }
});

Deno.test('pauses advertising with zero units', () => {
  assertEquals(stockAdsDecision({ available_quantity: 0 }), 'pause');
});

Deno.test('activates advertising even with one or three units', () => {
  for (const quantity of [1, 2, 3, 8, 60, 92]) {
    assertEquals(stockAdsDecision({ available_quantity: quantity }), 'activate');
  }
});

Deno.test('does not guess when inventory is unknown', () => {
  assertEquals(stockAdsDecision({}), 'unknown');
  assertEquals(stockAdsDecision({ available_quantity: 'invalid' }), 'unknown');
  assertEquals(stockAdsDecision({ available_quantity: -1 }), 'unknown');
});

Deno.test('explicit zero available stock takes precedence over FBA stock', () => {
  assertEquals(stockAdsDecision({ available_quantity: 0, fba_inventory: 60 }), 'pause');
  assertEquals(stockAdsDecision({ fba_inventory: 1 }), 'unknown');
});
