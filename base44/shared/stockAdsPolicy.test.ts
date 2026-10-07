import { assertEquals } from 'jsr:@std/assert';
import { stockAdsDecision } from './stockAdsPolicy.ts';
import { hasFreshAdsInventory } from './stockAdsPolicy.ts';
import { inventoryAvailable, campaignStateConfirmed, isStockCampaignPause } from './inventorySyncPolicy.ts';

Deno.test('missing, ambiguous and invalid inventory never becomes sellable or zero', () => {
  for (const quantity of [undefined, null, '', true, -1, 1.5, 'bad']) {
    assertEquals(inventoryAvailable({ totalQuantity: 60, inventoryDetails: { fulfillableQuantity: quantity } }), null);
    assertEquals(stockAdsDecision({ fba_inventory: quantity }), 'unknown');
  }
  for (const status of ['mapping_conflict', 'invalid_inventory', 'not_found']) {
    assertEquals(stockAdsDecision({ fba_inventory: 60, catalog_sync_status: status }), 'unknown');
  }
  assertEquals(inventoryAvailable({ inventoryDetails: { fulfillableQuantity: 0 } }), 0);
});

Deno.test('activation requires successful recent inventory sync', () => {
  const now = Date.parse('2026-10-02T12:00:00Z');
  const product = { fba_inventory: 1, catalog_sync_status: 'success', last_catalog_sync_at: new Date(now).toISOString() };
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
  assertEquals(stockAdsDecision({ fba_inventory: 0 }), 'pause');
});

Deno.test('activates advertising even with one or three units', () => {
  for (const quantity of [1, 2, 3, 8, 60, 92]) {
    assertEquals(stockAdsDecision({ fba_inventory: quantity }), 'activate');
  }
});

Deno.test('does not guess when inventory is unknown', () => {
  assertEquals(stockAdsDecision({}), 'unknown');
  assertEquals(stockAdsDecision({ fba_inventory: 'invalid' }), 'unknown');
  assertEquals(stockAdsDecision({ fba_inventory: -1 }), 'unknown');
});

Deno.test('FBA balance takes precedence according to the selected stock policy', () => {
  assertEquals(stockAdsDecision({ available_quantity: 0, fba_inventory: 20 }), 'activate');
  assertEquals(stockAdsDecision({ available_quantity: 20, fba_inventory: 0 }), 'pause');
  assertEquals(stockAdsDecision({ fba_inventory: 1 }), 'activate');
});

Deno.test('seller confirmation permits temporary FBA override without changing Amazon quantity', async () => {
  const { confirmedFbaOverride } = await import('./fbaStockOverride.ts');
  const now = Date.now();
  const product = { fba_inventory: 0, fba_stock_override: { source: 'seller_confirmed', quantity: 20, confirmed_at: new Date(now - 1000).toISOString(), expires_at: new Date(now + 3600000).toISOString() } };
  assertEquals(stockAdsDecision(product), 'activate');
  assertEquals(product.fba_inventory, 0);
  assertEquals(confirmedFbaOverride(product, now + 3600001), null);
  assertEquals(confirmedFbaOverride({ ...product, fba_stock_override: { ...product.fba_stock_override, source: 'inferred_total' } }, now), null);
});
