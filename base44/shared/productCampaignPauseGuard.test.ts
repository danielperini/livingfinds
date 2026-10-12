import { strict as assert } from 'node:assert';
import {
  campaignMatchesProduct,
  findPauseLockedProduct,
  isProductCampaignPauseLocked,
  productOfferEligibility,
} from './productCampaignPauseGuard.ts';

const campaign = { id: 'db-1', campaign_id: '123', asin: 'B0ABC', sku: 'SKU-1' };

assert.equal(isProductCampaignPauseLocked({ campaign_pause_lock: true }), true);
assert.equal(isProductCampaignPauseLocked({ campaign_status: 'paused' }), false);
assert.equal(isProductCampaignPauseLocked({ campaign_status: 'paused', pause_reason: 'out_of_stock_confirmed' }), false);
assert.equal(isProductCampaignPauseLocked({ campaign_status: 'active' }), false);
assert.equal(campaignMatchesProduct(campaign, { linked_campaign_ids: ['123'] }), true);
assert.equal(campaignMatchesProduct(campaign, { asin: 'b0abc' }), false, 'ASIN-only match is ambiguous when campaign has SKU');
assert.equal(campaignMatchesProduct({ asin: 'B0ABC', sku: 'SKU-1' }, { asin: 'B0ABC', sku: 'sku-1' }), true, 'normalized exact SKU match');
assert.equal(campaignMatchesProduct({ asin: 'B0ABC', sku: 'SKU-1', amazon_account_id: 'account-a' }, { asin: 'B0ABC', sku: 'SKU-1', amazon_account_id: 'account-b' }), false, 'campaign from another account');
assert.equal(campaignMatchesProduct({ asin: 'B0ABC' }, { asin: 'B0ABC', sku: 'SKU-2' }), false, 'missing campaign SKU cannot pause sibling SKU');
assert.equal(campaignMatchesProduct({ asin: 'B0ABC', sku: 'SKU-1' }, { asin: 'B0ABC' }), false, 'missing product SKU cannot be guessed from ASIN');
assert.equal(findPauseLockedProduct([{ asin: 'B0ABC', linked_campaign_ids: ['123'], campaign_pause_lock: true }], campaign)?.asin, 'B0ABC');
assert.equal(productOfferEligibility({ listing_buyable: false }).reason, 'LISTING_NOT_BUYABLE');
assert.equal(productOfferEligibility({ offer_active: false }).reason, 'OFFER_INACTIVE');
assert.equal(productOfferEligibility({ listing_suppressed: true }).reason, 'LISTING_SUPPRESSED');
assert.equal(productOfferEligibility({ listing_buyable: true, offer_active: true }).eligible, true);

console.log('productCampaignPauseGuard tests passed');
