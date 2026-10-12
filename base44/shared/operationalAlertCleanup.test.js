import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deduplicateActiveAlerts,
  getAlertAsin,
  planOperationalAlertCleanup,
} from './operationalAlertCleanup.js';

test('active alerts deduplicate across legacy keys and stock type aliases by ASIN', () => {
  const rows = [
    { id: 'old', amazon_account_id: 'acct', type: 'out_of_stock', entity_id: 'product-1', message: 'SKU A (B0F45JG27L) sem estoque', deduplication_key: 'legacy-1', created_at: '2026-10-01' },
    { id: 'new', amazon_account_id: 'acct', alert_type: 'low_stock', asin: 'B0F45JG27L', deduplication_key: 'legacy-2', created_at: '2026-10-02' },
  ];
  assert.deepEqual(deduplicateActiveAlerts(rows).map(row => row.id), ['new']);
});

test('stock alerts clear only after fresh zero stock and every linked campaign is confirmed paused', () => {
  const alert = { alert_type: 'campaign_active_no_stock' };
  assert.equal(planOperationalAlertCleanup(alert, { availableFbaQuantity: 0, linkedCampaignStates: ['paused'] }).reason, 'amazon_pause_confirmed');
  assert.equal(planOperationalAlertCleanup(alert, { availableFbaQuantity: 0, linkedCampaignStates: ['paused', 'enabled'] }).resolve, false);
  assert.equal(planOperationalAlertCleanup(alert, { availableFbaQuantity: 0, linkedCampaignStates: [undefined] }).resolve, false);
  assert.equal(planOperationalAlertCleanup(alert, { availableFbaQuantity: undefined, linkedCampaignStates: ['paused'] }).resolve, false);
});

test('completed campaign pause and restock notices are historical; unknown inventory is not cleared', () => {
  assert.equal(planOperationalAlertCleanup({ alert_type: 'campaign_paused' }, { linkedCampaignStates: ['paused'] }).reason, 'amazon_pause_confirmed');
  assert.equal(planOperationalAlertCleanup({ alert_type: 'campaign_paused' }, { linkedCampaignStates: ['enabled'] }).resolve, false);
  assert.equal(planOperationalAlertCleanup({ alert_type: 'restock_detected' }).reason, 'informational_event_archived');
  assert.equal(planOperationalAlertCleanup({ alert_type: 'out_of_stock' }, { availableFbaQuantity: undefined, linkedCampaignStates: [] }).resolve, false);
});

test('ASIN extraction handles old title and message-only alert rows', () => {
  assert.equal(getAlertAsin({ title: 'Campanha ativa sem estoque B0F45JG27L' }), 'B0F45JG27L');
});
