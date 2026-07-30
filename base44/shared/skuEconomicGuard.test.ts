import { strict as assert } from 'node:assert';
import {
  calculateEconomicCpc,
  calculateSkuWindowEconomics,
  calculateSmoothedSameSkuCvr,
  capBidChange,
  classifyEconomicCircuit,
  classifyEntityIntervention,
} from './skuEconomicGuard.ts';

const zeroOrders = calculateSkuWindowEconomics({
  sameSkuOrders: 0, spend: 33.46, contributionMarginPerOrder: 21.23,
});
assert.equal(zeroOrders.profit_after_ads_total, -33.46);
assert.equal(zeroOrders.profit_after_ads_per_order, -33.46);

const fixtureCvr = calculateSmoothedSameSkuCvr({ sameSkuOrders: 34, clicks: 887, priorWeight: 0 });
assert.ok(Math.abs(fixtureCvr.cvr - 0.0383) < 0.0001);
const fixtureCpc = calculateEconomicCpc({
  contributionMarginPerOrder: 21.23, sameSkuCvr: fixtureCvr.cvr, safetyFactor: 0.8,
});
assert.equal(fixtureCpc.maximum_economic_cpc, 0.81);
assert.equal(fixtureCpc.safe_max_cpc, 0.65);

assert.equal(classifyEntityIntervention({
  sameSkuOrders: 3, sameSkuSales: 338.89, spend: 104.36, clicks: 102,
  cpc: 1.02, contributionMarginPerOrder: 21.23, expectedClicksPerOrder: 26.1,
  safeMaxCpc: 0.65, sameSkuAcos: 0.3079, breakEvenAcos: 0.2497,
}).action, 'REDUCE_STRONG');
assert.equal(classifyEntityIntervention({
  sameSkuOrders: 0, sameSkuSales: 0, spend: 19.06, clicks: 23,
  cpc: 0.82, contributionMarginPerOrder: 21.23, expectedClicksPerOrder: 26.1,
  safeMaxCpc: 0.65, sameSkuAcos: 0.2203, breakEvenAcos: 0.2497,
}).action, 'REDUCE_SOFT');
assert.equal(classifyEntityIntervention({
  sameSkuOrders: 2, spend: 100, winnerConfirmed: true,
}).action, 'PRESERVE');

const fixtureEconomics = calculateSkuWindowEconomics({
  sameSkuOrders: 20, sameSkuSales: 1700, totalAttributedSales: 3247.45,
  spend: 635.46, realSkuRevenue: 1700, realContributionMargin: 424.57,
  contributionMarginPerOrder: 21.23, targetAcos: 0.15,
});
assert.equal(fixtureEconomics.real_profit_after_ads, -210.89);
assert.equal(fixtureEconomics.economic_attribution_status, 'HALO_OR_PERIOD_MISMATCH');
assert.equal(classifyEconomicCircuit({
  listingBuyable: true, offerActive: true, realAdCostRatio: 0.3738,
  targetAcos: 0.15, breakEvenAcos: 0.2497, realProfitAfterAds: -210.89,
}), 'LOSS_CONFIRMED');

assert.equal(classifyEntityIntervention({
  sameSkuOrders: 0, spend: 27.9, clicks: 35, cpc: 0.8,
  contributionMarginPerOrder: 21.23, expectedClicksPerOrder: 26.1, safeMaxCpc: 0.65,
}).action, 'REDUCE_STRONG');
assert.equal(classifyEntityIntervention({
  sameSkuOrders: 0, spend: 33.46, clicks: 41, contributionMarginPerOrder: 21.23,
  expectedClicksPerOrder: 20, priorReductionCount: 1,
}).action, 'PAUSE_CANDIDATE');
assert.equal(classifyEconomicCircuit({
  listingBuyable: false, offerActive: true, realProfitAfterAds: 100,
}), 'NOT_BUYABLE');
assert.equal(classifyEconomicCircuit({
  listingBuyable: true, offerActive: false, realProfitAfterAds: 100,
}), 'NOT_BUYABLE');
assert.equal(capBidChange(1, 0.5), 0.8);
assert.equal(capBidChange(1, 1.5), 1.2);

console.log('skuEconomicGuard tests passed');
