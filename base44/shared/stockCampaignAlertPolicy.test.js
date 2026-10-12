import test from 'node:test';
import assert from 'node:assert/strict';
import {
  belongsToStockCampaignAlert,
  isStockCampaignAlert,
  planStockCampaignAlertReconciliation,
} from './stockCampaignAlertPolicy.js';

test('recognizes legacy campaign-without-stock alerts using either schema field', () => {
  assert.equal(isStockCampaignAlert({ type: 'campaign_active_no_stock' }), true);
  assert.equal(isStockCampaignAlert({ alert_type: 'campaign_active_no_stock' }), true);
  assert.equal(isStockCampaignAlert({ title: 'Campanha ativa sem estoque: B0F45JG27L' }), true);
  assert.equal(isStockCampaignAlert({ alert_type: 'low_roas', title: 'ROAS baixo' }), false);
});

test('matches old product-id alerts and canonical ASIN alerts to the same product', () => {
  const oldRow = { type: 'campaign_active_no_stock', entity_id: 'product-12', message: 'B0F45JG27L com estoque = 0' };
  const canonical = { alert_type: 'campaign_active_no_stock', entity_id: 'B0F45JG27L' };
  assert.equal(belongsToStockCampaignAlert(oldRow, { asin: 'B0F45JG27L', productId: 'product-12' }), true);
  assert.equal(belongsToStockCampaignAlert(canonical, { asin: 'B0F45JG27L' }), true);
});

test('resolves all matching alerts after successful pause and retains one actionable alert if campaigns remain', () => {
  const alerts = [
    { id: 'old', type: 'campaign_active_no_stock', entity_id: 'p1', message: 'B0F45JG27L sem estoque', created_at: '2026-10-01' },
    { id: 'new', alert_type: 'campaign_active_no_stock', entity_id: 'B0F45JG27L', updated_at: '2026-10-02' },
    { id: 'other', alert_type: 'high_acos', entity_id: 'B0F45JG27L' },
  ];
  const resolved = planStockCampaignAlertReconciliation(alerts, { asin: 'B0F45JG27L', productId: 'p1' });
  assert.equal(resolved.keep, null);
  assert.deepEqual(resolved.resolve.map(row => row.id), ['old', 'new']);

  const stillActive = planStockCampaignAlertReconciliation(alerts, { asin: 'B0F45JG27L', productId: 'p1', activeCampaignCount: 2 });
  assert.equal(stillActive.keep.id, 'new');
  assert.deepEqual(stillActive.resolve.map(row => row.id), ['old']);
});
