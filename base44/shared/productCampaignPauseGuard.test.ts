import { strict as assert } from 'node:assert';
import {
  campaignMatchesProduct,
  findPauseLockedProduct,
  isProductCampaignPauseLocked,
} from './productCampaignPauseGuard.ts';

const campaign = { id: 'db-1', campaign_id: '123', asin: 'B0ABC', sku: 'SKU-1' };

assert.equal(isProductCampaignPauseLocked({ campaign_pause_lock: true }), true);
assert.equal(isProductCampaignPauseLocked({ campaign_status: 'paused' }), true);
assert.equal(isProductCampaignPauseLocked({ campaign_status: 'paused', pause_reason: 'out_of_stock_confirmed' }), false);
assert.equal(isProductCampaignPauseLocked({ campaign_status: 'active' }), false);
assert.equal(campaignMatchesProduct(campaign, { linked_campaign_ids: ['123'] }), true);
assert.equal(campaignMatchesProduct(campaign, { asin: 'b0abc' }), true);
assert.equal(findPauseLockedProduct([{ asin: 'B0ABC', campaign_status: 'paused' }], campaign)?.asin, 'B0ABC');

console.log('productCampaignPauseGuard tests passed');
