import test from 'node:test';
import assert from 'node:assert/strict';
import { deduplicateOperationalAlerts, isActionableOperationalAlert } from './operationalAlertPresentation.js';

test('operational priorities collapse repeated alerts by account, type, and ASIN, retaining the freshest row', () => {
  const rows = [
    { id: 'old', amazon_account_id: 'a', alert_type: 'campaign_active_no_stock', asin: 'B0F45JG27L', created_at: '2026-10-01' },
    { id: 'fresh', amazon_account_id: 'a', type: 'campaign_active_no_stock', entity_id: 'B0F45JG27L', updated_at: '2026-10-02' },
    { id: 'other-account', amazon_account_id: 'b', alert_type: 'campaign_active_no_stock', asin: 'B0F45JG27L', created_at: '2026-10-02' },
    { id: 'other-type', amazon_account_id: 'a', alert_type: 'out_of_stock', asin: 'B0F45JG27L', created_at: '2026-10-02' },
  ];
  assert.deepEqual(deduplicateOperationalAlerts(rows).map(row => row.id).sort(), ['fresh', 'other-account', 'other-type']);
});

test('legacy explicit keys do not split one business incident into multiple rows', () => {
  const rows = [
    { id: 'old', deduplication_key: 'canonical', created_at: '2026-10-01' },
    { id: 'fresh', deduplication_key: 'canonical', created_at: '2026-10-02' },
  ];
  assert.deepEqual(deduplicateOperationalAlerts(rows).map(row => row.id), ['fresh']);
});

test('completed restock and confirmed stock-pause notices do not appear as action items', () => {
  assert.equal(isActionableOperationalAlert({ alert_type: 'restock_detected' }), false);
  assert.equal(isActionableOperationalAlert({ alert_type: 'out_of_stock', message: 'FBA-1 sem estoque. Ads pausados.' }), false);
  assert.equal(isActionableOperationalAlert({ alert_type: 'campaign_active_no_stock', title: 'Pausa Amazon pendente' }), true);
  assert.equal(isActionableOperationalAlert({ alert_type: 'sync_error', severity: 'high' }), true);
});

test('campaign-specific pause failures stay separate for the same product', () => {
  const rows = [
    { id: 'campaign-1', amazon_account_id: 'acct', alert_type: 'campaign_paused', asin: 'B0F45JG27L', campaign_id: 'c1', created_at: '2026-10-01' },
    { id: 'campaign-2', amazon_account_id: 'acct', alert_type: 'campaign_paused', asin: 'B0F45JG27L', campaign_id: 'c2', created_at: '2026-10-02' },
  ];
  assert.deepEqual(deduplicateOperationalAlerts(rows).map(row => row.id).sort(), ['campaign-1', 'campaign-2']);
});
