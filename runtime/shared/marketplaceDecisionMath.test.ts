import { strict as assert } from 'node:assert';
import {
  calculateEconomicCpc,
  estimateBayesianConversion,
  estimateCanonicalElasticity,
  forecastDemand,
  probabilityAtLeastOneSale,
  rankThompsonBidArms,
  simulateProfitCurve,
} from './marketplaceDecisionMath.ts';

const noOrders = estimateBayesianConversion({ clicks: 20, orders: 0, priorAlpha: 1, priorBeta: 19, sustainableThreshold: 0.05 });
assert.ok(noOrders.mean > 0 && noOrders.mean < 0.05);
assert.ok(noOrders.lower < noOrders.mean);

const oneOrder = estimateBayesianConversion({ clicks: 5, orders: 1 });
assert.ok(oneOrder.mean < 0.20);
assert.ok(oneOrder.lower < oneOrder.mean);

const mature = estimateBayesianConversion({ clicks: 200, orders: 20 });
assert.ok(Math.abs(mature.mean - 0.0955) < 0.002);
assert.ok(mature.upper - mature.lower < oneOrder.upper - oneOrder.lower);
assert.ok(probabilityAtLeastOneSale(mature.lower, 20) > 0);

const cpc = calculateEconomicCpc({ conversionRate: mature.mean, conversionLowerBound: mature.lower, allowableAdSpendPerOrder: 20, safetyFactor: 0.85 });
assert.ok(cpc.safeMaxCpc < cpc.maximumEconomicCpc);

const growing = forecastDemand(Array.from({ length: 30 }, (_, index) => ({
  date: `2026-07-${String(index + 1).padStart(2, '0')}`,
  units: 1 + index * 0.1,
  stockQty: 20,
})), '2026-07-30');
assert.equal(growing.status, 'OK');
assert.ok((growing.predicted7d || 0) > (growing.predicted1d || 0) * 5);

const decreasing = forecastDemand(Array.from({ length: 14 }, (_, index) => ({
  date: `2026-07-${String(index + 1).padStart(2, '0')}`,
  units: Math.max(0.2, 5 - index * 0.25), stockQty: 20,
})));
assert.equal(decreasing.status, 'OK');
assert.ok((decreasing.predicted1d || 0) < 4);

assert.equal(forecastDemand([{ date: '2026-07-01', units: 2 }]).status, 'INSUFFICIENT_DATA');

const elasticity = estimateCanonicalElasticity([
  { date: '2026-07-01', price: 100, units: 10, stockQty: 20, adsSpend: 10 },
  { date: '2026-07-08', price: 102, units: 9.5, stockQty: 20, adsSpend: 10 },
  { date: '2026-07-15', price: 104, units: 8.8, stockQty: 20, adsSpend: 11 },
  { date: '2026-07-22', price: 106, units: 8.1, stockQty: 20, adsSpend: 10 },
]);
assert.equal(elasticity.status, 'ELASTIC');
assert.ok((elasticity.elasticity || 0) > 1);

const stockOutElasticity = estimateCanonicalElasticity([
  { date: '2026-07-01', price: 100, units: 10, stockQty: 20, adsSpend: 10 },
  { date: '2026-07-08', price: 102, units: 1, stockQty: 0, adsSpend: 10 },
  { date: '2026-07-15', price: 104, units: 8, stockQty: 20, adsSpend: 30 },
]);
assert.equal(stockOutElasticity.status, 'INSUFFICIENT_DATA');

const curve = simulateProfitCurve({
  currentPrice: 100, economicFloor: 80, variableCostPerUnit: 60,
  referralFeePct: 15, salesTaxPct: 7, baselineDailyUnits: 10, adsSpendPerDay: 20,
  elasticity, maximumChangePct: 0.02,
});
assert.equal(curve.status, 'OK');
assert.ok(curve.best && curve.best.price >= 80);

const arms = rankThompsonBidArms({
  seed: 'account|sku|window', currentBid: 0.50, safeMaxCpc: 0.52,
  posteriorAlpha: mature.posteriorAlpha, posteriorBeta: mature.posteriorBeta,
  allowableAdSpendPerOrder: 20, projectedClicks: 10, inStock: true,
  defensive: false, winnerProtected: false, cooldownActive: false,
});
assert.equal(arms.eligible, true);
assert.ok(arms.arms.every((arm) => arm.bid <= 0.52));
