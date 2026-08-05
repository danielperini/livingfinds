import { strict as assert } from 'node:assert';
import {
  allocateVirtualBudgets,
  calculateMaxSpendWithoutSale,
  classifyEconomicCampaign,
  proposeEconomicAdjustment,
  resolveEconomicBalancerConfig,
} from './economicBudgetBalancer.ts';

const config = resolveEconomicBalancerConfig({
  daily_budget_limit: 65,
  max_bid_increase_pct: 6,
  max_bid_decrease_pct: 12,
  min_bid: 0.10,
  max_bid: 1,
});

assert.equal(config.maxBidIncreasePct, 0.06);
assert.equal(config.maxBidDecreasePct, 0.12);
assert.equal(calculateMaxSpendWithoutSale(config, 12), 15);

const overshare = classifyEconomicCampaign({
  campaignType: 'SP', isAuto: true, state: 'enabled', ageHours: 800, dataFresh: true,
  structurallyComplete: true, economicsAvailable: true, inStock: true,
  impressions: 500, clicks: 24, orders: 0, sales: 0,
  spendShare: 0.28, targetShare: 0.10, lowVolume: false,
  profitAfterAds: -16.69, acos: null, targetAcos: 25,
}, config);
assert.equal(overshare, 'OVERSHARE_NO_CONVERSION');

const reduction = proposeEconomicAdjustment({
  classification: overshare, ageHours: 800, isAuto: true, highlyRelevant: false,
  economicsAvailable: true, currentBid: 0.70, currentBudget: 15, safeMaxCpc: 0.75,
  impressions: 500, clicks: 24, orders: 0, sales: 0, spend: 16.69,
  spendShare: 0.28, targetShare: 0.10, maxSpendWithoutSale: 15,
  budgetExhausted: true, remainingAccountBudget: 0, budgetOptimizationEnabled: true,
}, config);
assert.equal(reduction.action, 'reduce_bid');
assert.equal(reduction.valueAfter, 0.62);
assert.match(reduction.reason, /sem pausar/i);

const learningHold = proposeEconomicAdjustment({
  classification: 'NEW_NO_IMPRESSIONS', ageHours: 3, isAuto: false, highlyRelevant: true,
  economicsAvailable: true, currentBid: 0.30, currentBudget: 5, safeMaxCpc: 0.60,
  impressions: 0, clicks: 0, orders: 0, sales: 0, spend: 0,
  spendShare: 0, targetShare: 0.05, maxSpendWithoutSale: 15,
  budgetExhausted: false, remainingAccountBudget: 65, budgetOptimizationEnabled: true,
}, config);
assert.equal(learningHold.action, 'observe');

const safeEntry = proposeEconomicAdjustment({
  classification: 'NEW_NO_IMPRESSIONS', ageHours: 8, isAuto: false, highlyRelevant: true,
  economicsAvailable: true, currentBid: 0.30, currentBudget: 5, safeMaxCpc: 0.60,
  impressions: 0, clicks: 0, orders: 0, sales: 0, spend: 0,
  spendShare: 0, targetShare: 0.05, maxSpendWithoutSale: 15,
  budgetExhausted: false, remainingAccountBudget: 65, budgetOptimizationEnabled: true,
}, config);
assert.equal(safeEntry.action, 'increase_bid');
assert.equal(safeEntry.valueAfter, 0.31);

const outOfBudgetClassification = classifyEconomicCampaign({
  campaignType: 'SP', isAuto: false, state: 'enabled', ageHours: 200, dataFresh: true,
  structurallyComplete: true, economicsAvailable: true, inStock: true,
  accountOutOfBudget: true,
  impressions: 0, clicks: 0, orders: 0, sales: 0,
  spendShare: 0, targetShare: 0.05, lowVolume: false,
  profitAfterAds: 0, acos: null, targetAcos: 25,
}, config);
assert.equal(outOfBudgetClassification, 'ACCOUNT_OUT_OF_BUDGET');

const outOfBudgetHold = proposeEconomicAdjustment({
  classification: outOfBudgetClassification, ageHours: 200, isAuto: false, highlyRelevant: true,
  economicsAvailable: true, currentBid: 0.30, currentBudget: 5, safeMaxCpc: 0.60,
  impressions: 0, clicks: 0, orders: 0, sales: 0, spend: 0,
  spendShare: 0, targetShare: 0.05, maxSpendWithoutSale: 15,
  budgetExhausted: true, remainingAccountBudget: 0, budgetOptimizationEnabled: true,
}, config);
assert.equal(outOfBudgetHold.action, 'observe');
assert.equal(outOfBudgetHold.rule, 'ACCOUNT_OUT_OF_BUDGET_HOLD');
assert.equal(outOfBudgetHold.blockedBy, 'ACCOUNT_OUT_OF_BUDGET');

const winnerWhileOutOfBudget = classifyEconomicCampaign({
  campaignType: 'SP', isAuto: false, state: 'enabled', ageHours: 500, dataFresh: true,
  structurallyComplete: true, economicsAvailable: true, inStock: true,
  accountOutOfBudget: true,
  impressions: 1000, clicks: 30, orders: 4, sales: 200,
  spendShare: 0.35, targetShare: 0.40, lowVolume: false,
  profitAfterAds: 40, acos: 15, targetAcos: 25,
}, config);
assert.equal(winnerWhileOutOfBudget, 'PROTECTED_WINNER');

const unsafe = proposeEconomicAdjustment({
  classification: 'ECONOMICALLY_UNSAFE', ageHours: 48, isAuto: false, highlyRelevant: true,
  economicsAvailable: false, currentBid: 0.30, currentBudget: 5, safeMaxCpc: 0,
  impressions: 0, clicks: 0, orders: 0, sales: 0, spend: 0,
  spendShare: 0, targetShare: 0.05, maxSpendWithoutSale: 0,
  budgetExhausted: false, remainingAccountBudget: 65, budgetOptimizationEnabled: true,
}, config);
assert.equal(unsafe.action, 'observe');
assert.equal(unsafe.blockedBy, 'ECONOMIC_DATA_MISSING');

const winner = proposeEconomicAdjustment({
  classification: 'PROTECTED_WINNER', ageHours: 500, isAuto: false, highlyRelevant: true,
  economicsAvailable: true, currentBid: 0.50, currentBudget: 10, safeMaxCpc: 0.75,
  impressions: 1000, clicks: 30, orders: 4, sales: 200, spend: 30,
  spendShare: 0.35, targetShare: 0.40, maxSpendWithoutSale: 15,
  budgetExhausted: false, remainingAccountBudget: 20, budgetOptimizationEnabled: true,
}, config);
assert.equal(winner.action, 'observe');
assert.equal(winner.rule, 'PROTECTED_WINNER_HOLD');

const allocations = allocateVirtualBudgets([
  { campaignId: 'auto', isAuto: true, ageHours: 200, classification: 'LEARNING_BALANCED', marginPercent: 25, economicConfidence: 90, stockCoverageDays: 30, profitAfterAds: 0 },
  { campaignId: 'manual-new', isAuto: false, ageHours: 12, classification: 'NEW_NO_IMPRESSIONS', marginPercent: 30, economicConfidence: 90, stockCoverageDays: 30, profitAfterAds: 0 },
  { campaignId: 'winner', isAuto: false, ageHours: 500, classification: 'PROTECTED_WINNER', marginPercent: 35, economicConfidence: 95, stockCoverageDays: 40, profitAfterAds: 50 },
], 65, config);
assert.equal(Math.round(allocations.reduce((sum, row) => sum + row.targetShare, 0) * 1000), 1000);
assert.equal(allocations.reduce((sum, row) => sum + row.virtualBudget, 0), 65);
assert.ok((allocations.find(row => row.campaignId === 'winner')?.targetShare || 0) >
  (allocations.find(row => row.campaignId === 'auto')?.targetShare || 0));

const autoOnly = allocateVirtualBudgets([
  { campaignId: 'auto-only', isAuto: true, ageHours: 200, classification: 'LEARNING_BALANCED', marginPercent: 25, economicConfidence: 90, stockCoverageDays: 30, profitAfterAds: 0 },
], 65, config);
assert.equal(autoOnly[0].targetShare, config.maxAutoDiscoveryShare);
assert.equal(autoOnly[0].virtualBudget, 19.5);

const lowBidRoundingGuard = proposeEconomicAdjustment({
  classification: 'NEW_NO_IMPRESSIONS', ageHours: 48, isAuto: false, highlyRelevant: true,
  economicsAvailable: true, currentBid: 0.10, currentBudget: 5, safeMaxCpc: 0.30,
  impressions: 0, clicks: 0, orders: 0, sales: 0, spend: 0,
  spendShare: 0, targetShare: 0.05, maxSpendWithoutSale: 15,
  budgetExhausted: false, remainingAccountBudget: 65, budgetOptimizationEnabled: true,
}, config);
assert.equal(lowBidRoundingGuard.action, 'observe');
