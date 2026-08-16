import { strict as assert } from 'node:assert';
import {
  buildCanonicalBidDecision,
  canonicalDecisionIdempotencyKey,
  evaluateDecisionGovernance,
} from './canonicalDecisionPolicy.ts';

const baseBid = {
  currentBid: 0.50, safeMaxCpc: 0.80, impressions: 0, clicks: 0,
  sameSkuOrders: 0, haloOrders: 0, spend: 0, maxSpendWithoutSale: 15, spendShare: 0,
  ageHours: 12, inStock: true, structurallyComplete: true, dataFresh: true,
  economicsComplete: true, cooldownActive: false, pendingInsertion: false,
  winnerProtected: false, lowVolumeGuarded: false, defensive: false,
  isManualExact: true, adGroupConfirmed: true, productAdConfirmed: true,
  priorReductionCount: 0, attributionComplete: true, acos: null,
  targetAcos: 20, breakEvenAcos: 30, profitAfterAds: 0,
};

const zeroDelivery = buildCanonicalBidDecision(baseBid);
assert.equal(zeroDelivery.action, 'RECOVER_ZERO_DELIVERY');
assert.ok(zeroDelivery.changePct > 0 && zeroDelivery.changePct <= 0.05);
assert.equal(zeroDelivery.requiresPairedAdGroup, true);

const impressionsNoClick = buildCanonicalBidDecision({ ...baseBid, impressions: 600 });
assert.equal(impressionsNoClick.action, 'DECREASE_SOFT');

const firstNoSale = buildCanonicalBidDecision({ ...baseBid, impressions: 1000, clicks: 20, spend: 16, spendShare: 0.28 });
assert.equal(firstNoSale.action, 'DECREASE_STRONG');
assert.equal(firstNoSale.reasonCode, 'EARLY_ECONOMIC_LOSS_GUARD');
assert.ok(firstNoSale.changePct >= -0.21);

const repeatedNoSale = buildCanonicalBidDecision({ ...baseBid, impressions: 3000, clicks: 40, spend: 35, spendShare: 0.50, priorReductionCount: 2 });
assert.equal(repeatedNoSale.action, 'DECREASE_STRONG');
assert.ok(repeatedNoSale.changePct >= -0.21);

const haloOnly = buildCanonicalBidDecision({ ...baseBid, impressions: 1000, clicks: 20, spend: 16, haloOrders: 4 });
assert.notEqual(haloOnly.reasonCode, 'WINNER_PROTECTED');

const profitable = buildCanonicalBidDecision({ ...baseBid, impressions: 2000, clicks: 80, sameSkuOrders: 8, spend: 40, acos: 15, profitAfterAds: 60 });
assert.equal(profitable.action, 'INCREASE');

const blockedPause = evaluateDecisionGovernance({
  actionType: 'pause_campaign', entityType: 'campaign', snapshotId: 'snap-1',
  reasonCode: 'zero_sales', reason: 'sem venda', confidence: 0.95,
  dataFresh: true, productEligible: true, listingActive: true, offerActive: true,
  buyable: true, inStock: true, economicsComplete: true, economicConfidence: 0.95,
  rollbackPlan: 'enable_campaign',
});
assert.equal(blockedPause.allowed, false);
assert.ok(blockedPause.blockers.some((blocker) => blocker.code === 'NO_SALE_PAUSE_BLOCKED'));

const protectiveReduction = evaluateDecisionGovernance({
  actionType: 'reduce_bid', entityType: 'keyword', snapshotId: 'snap-guard',
  currentValue: 0.80, proposedValue: 0.64, reasonCode: 'EARLY_ECONOMIC_LOSS_GUARD',
  confidence: 0.97, dataFresh: true, productEligible: true, listingActive: true,
  offerActive: true, buyable: true, inStock: true, economicsComplete: true,
  economicConfidence: 0.65, rollbackPlan: 'restore_bid',
});
assert.equal(protectiveReduction.allowed, true);

const priceBelowFloor = evaluateDecisionGovernance({
  actionType: 'decrease_price', entityType: 'product_price', snapshotId: 'snap-2',
  currentValue: 100, proposedValue: 70, economicFloor: 80, confidence: 0.95,
  predictionConfidence: 0.95, economicConfidence: 0.95, dataFresh: true,
  productEligible: true, listingActive: true, offerActive: true, buyable: true,
  inStock: true, economicsComplete: true, competitionFresh: true,
  stockCoverageDays: 30, profitAfterAds: 20, currentAcos: 10, targetAcos: 20,
  rollbackPlan: 'restore_previous_price',
});
assert.equal(priceBelowFloor.allowed, false);
assert.ok(priceBelowFloor.blockers.some((blocker) => blocker.code === 'PRICE_BELOW_FLOOR'));

const key = canonicalDecisionIdempotencyKey({
  accountId: 'A', profileId: 'P', marketplaceId: 'M', entityType: 'keyword',
  entityId: 'K', actionType: 'set_bid', decisionWindow: '2026-08-04T00:00:00Z',
});
assert.equal(key, 'a|p|m|keyword|k|set_bid|2026-08-04t00:00:00z');
