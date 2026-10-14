import { assertEquals } from 'jsr:@std/assert@1';
import { manualKickoffCanComplete, shouldReactivateForManualKickoff } from './manualKickoffReactivationPolicy.ts';

const product = { manual_kickoff_status: 'pending', fba_inventory: 5, available_quantity: 5, catalog_sync_status: 'success', inventory_snapshot_at: '2026-10-14T12:00:00Z', last_catalog_sync_at: new Date().toISOString() };

Deno.test('one-time manual kickoff only reactivates paused campaigns with fresh sellable FBA stock', () => {
  assertEquals(shouldReactivateForManualKickoff(product, { campaign_id: '1' }, 'paused'), true);
  assertEquals(shouldReactivateForManualKickoff({ ...product, manual_kickoff_status: 'completed' }, { campaign_id: '1' }, 'paused'), false);
  assertEquals(shouldReactivateForManualKickoff({ ...product, fba_inventory: 0, available_quantity: 0 }, { campaign_id: '1' }, 'paused'), false);
  assertEquals(shouldReactivateForManualKickoff(product, { campaign_id: '1', state: 'archived' }, 'paused'), false);
});

Deno.test('manual kickoff completes only after all non-archived campaigns have confirmed remote states', () => {
  const campaigns = [{ campaign_id: '1' }, { campaign_id: '2' }, { campaign_id: '3', state: 'archived' }];
  assertEquals(manualKickoffCanComplete(product, campaigns, new Map([['1', 'enabled'], ['2', 'paused']])), false);
  assertEquals(manualKickoffCanComplete(product, campaigns, new Map([['1', 'enabled'], ['2', 'enabled']])), true);
  assertEquals(manualKickoffCanComplete(product, [], new Map()), false);
});
