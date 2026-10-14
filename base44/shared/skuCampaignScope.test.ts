import { strict as assert } from 'node:assert';
import {
  latestMetricsByCampaign,
  resolveAccountHardCap,
  resolveProductScope,
  resolveSkuScopedRow,
  selectCampaignHourEvidence,
  uniqueCampaignRows,
} from './skuCampaignScope.ts';

const products = [
  { asin: 'B0VARIANT1', sku: 'SKU-RED' },
  { asin: 'B0VARIANT1', sku: 'SKU-BLACK' },
  { asin: 'B0SINGLE1', sku: 'SKU-ONLY' },
];
const productAds = [{ campaign_id: 'campaign-red', asin: 'B0VARIANT1', sku: 'SKU-RED' }];

assert.equal(resolveProductScope({ campaign_id: 'campaign-red' }, productAds, products).sku, 'SKU-RED');
assert.equal(resolveProductScope({ campaign_id: 'campaign-asin', asin: 'B0VARIANT1' }, [], products).status, 'ambiguous');
assert.equal(resolveProductScope({ campaign_id: 'campaign-asin', asin: 'B0SINGLE1' }, [], products).sku, 'SKU-ONLY');
assert.equal(resolveProductScope({ campaign_id: 'campaign-missing' }, [], products).status, 'missing_identity');
assert.equal(resolveProductScope({ campaign_id: 'campaign-conflict', sku: 'SKU-RED' }, [
  { campaign_id: 'campaign-conflict', sku: 'SKU-BLACK', asin: 'B0VARIANT1' },
], products).status, 'ambiguous');
assert.equal(resolveProductScope({ campaign_id: 'campaign-multi' }, [
  { campaign_id: 'campaign-multi', sku: 'SKU-RED', asin: 'B0VARIANT1' },
  { campaign_id: 'campaign-multi', sku: 'SKU-BLACK', asin: 'B0VARIANT1' },
], products).status, 'ambiguous');

const economics = [
  { asin: 'B0VARIANT1', sku: 'SKU-RED', updated_at: '2026-10-13T10:00:00Z', margin: 10 },
  { asin: 'B0VARIANT1', sku: 'SKU-BLACK', updated_at: '2026-10-13T11:00:00Z', margin: 50 },
];
assert.equal(resolveSkuScopedRow(products[0], economics)?.margin, 10);
assert.equal(resolveSkuScopedRow(products[0], [{ asin: 'B0VARIANT1', margin: 999 }]), null);

assert.equal(uniqueCampaignRows([
  { campaign_id: 'c1', updated_at: '2026-10-13T09:00:00Z' },
  { campaign_id: 'c1', updated_at: '2026-10-13T10:00:00Z' },
  { campaign_id: 'c2', updated_at: '2026-10-13T09:00:00Z' },
]).length, 2);
const byCampaign = latestMetricsByCampaign([
  { campaign_id: 'c1', date: '2026-10-14', synced_at: '2026-10-14T09:00:00Z', spend: 10 },
  { campaign_id: 'c1', date: '2026-10-14', synced_at: '2026-10-14T10:00:00Z', spend: 12 },
  { campaign_id: 'c2', date: '2026-10-13', synced_at: '2026-10-13T10:00:00Z', spend: 99 },
], '2026-10-14');
assert.equal(byCampaign.get('c1')?.spend, 12);
assert.equal(byCampaign.has('c2'), false);

const cap = resolveAccountHardCap(100, 75, 10);
assert.equal(cap.remaining, 15);
assert.equal(cap.reached, false);
assert.equal(resolveAccountHardCap(100, 90, 10).reached, true);
assert.equal(resolveAccountHardCap(100, 40, 0).remaining, 60);
assert.equal(resolveAccountHardCap(0, 90, 10).reached, false);

const decisionA = { campaign_id: 'c1', sku: 'SKU-RED', day_of_week: 2, hour: 10, updated_at: '2026-10-14T10:00:00Z' };
const patternA = { sku: 'SKU-RED', day_of_week: 2, hour: 10, updated_at: '2026-10-14T09:00:00Z' };
const patternB = { sku: 'SKU-BLACK', day_of_week: 2, hour: 10, updated_at: '2026-10-14T11:00:00Z' };
assert.equal(selectCampaignHourEvidence({
  decisions: [decisionA], patterns: [patternA, patternB], campaignId: 'c1', sku: 'SKU-RED', dayOfWeek: 2, hour: 10,
}).source, 'campaign_decision');
assert.equal(selectCampaignHourEvidence({
  decisions: [decisionA], patterns: [patternB], campaignId: 'c1', sku: 'SKU-RED', dayOfWeek: 2, hour: 10,
}).source, 'no_campaign_or_sku_history');
assert.equal(selectCampaignHourEvidence({
  decisions: [decisionA], patterns: [patternB], campaignId: 'c2', sku: 'SKU-BLACK', dayOfWeek: 2, hour: 10,
}).source, 'sku_pattern');


const profileAnchor = {
  sku: 'SKU-RED',
  asin: 'B0VARIANT1',
  slot_label: 'SKU_PROFILE_ANCHOR',
  asin_data_maturity: 'sufficient',
  asin_peak_hours_json: '[10,11]',
  asin_low_hours_json: '[20,21]',
  asin_profile_updated_at: '2026-10-14T09:00:00Z',
};
assert.equal(selectCampaignHourEvidence({
  decisions: [], patterns: [profileAnchor], campaignId: 'c-red', sku: 'SKU-RED', dayOfWeek: 3, hour: 10,
}).source, 'sku_profile');
assert.equal(selectCampaignHourEvidence({ decisions: [], patterns: [profileAnchor], campaignId: 'c-red', sku: 'SKU-RED', dayOfWeek: 3, hour: 10,
}).row?.classification, 'PEAK_STRONG');
assert.equal(selectCampaignHourEvidence({
  decisions: [], patterns: [profileAnchor], campaignId: 'c-black', sku: 'SKU-BLACK', dayOfWeek: 3, hour: 10,
}).source, 'no_campaign_or_sku_history');
const exactSlot = { sku: 'SKU-RED', day_of_week: 3, hour: 10, classification: 'LOSS', updated_at: '2026-10-14T08:00:00Z' };
assert.equal(selectCampaignHourEvidence({
  decisions: [], patterns: [profileAnchor, exactSlot], campaignId: 'c-red', sku: 'SKU-RED', dayOfWeek: 3, hour: 10,
}).row, exactSlot);

console.log('skuCampaignScope tests passed');
