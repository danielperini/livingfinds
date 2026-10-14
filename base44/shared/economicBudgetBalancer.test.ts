import { strict as assert } from 'node:assert';
import {
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

const campaignObserved = classifyEconomicCampaign({
  campaignType: 'SP', isAuto: true, state: 'enabled', ageHours: 800, dataFresh: true,
  structurallyComplete: true, economicsAvailable: true, inStock: true,
  impressions: 500, clicks: 24, orders: 0, sales: 0,
  spendShare: 0.28, lowVolume: false,
  profitAfterAds: -16.69, acos: null, targetAcos: 25,
}, config);
assert.equal(campaignObserved, 'LEARNING_BALANCED');

const reduction = proposeEconomicAdjustment({
  classification: campaignObserved, ageHours: 800, isAuto: true, highlyRelevant: false,
  economicsAvailable: true, currentBid: 0.70, currentBudget: 15, safeMaxCpc: 0.75,
  impressions: 500, clicks: 24, orders: 0, sales: 0, spend: 16.69,
  spendShare: 0.28, maxSpendWithoutSale: 15,
  budgetExhausted: true, budgetOptimizationEnabled: true,
}, config);
assert.equal(reduction.action, 'reduce_bid');
assert.equal(reduction.valueAfter, 0.62);
assert.match(reduction.reason, /sem pausar/i);

const learningHold = proposeEconomicAdjustment({
  classification: 'NEW_NO_IMPRESSIONS', ageHours: 3, isAuto: false, highlyRelevant: true,
  economicsAvailable: true, currentBid: 0.30, currentBudget: 5, safeMaxCpc: 0.60,
  impressions: 0, clicks: 0, orders: 0, sales: 0, spend: 0,
  spendShare: 0, maxSpendWithoutSale: 15,
  budgetExhausted: false, budgetOptimizationEnabled: true,
}, config);
assert.equal(learningHold.action, 'observe');

const safeEntry = proposeEconomicAdjustment({
  classification: 'NEW_NO_IMPRESSIONS', ageHours: 8, isAuto: false, highlyRelevant: true,
  economicsAvailable: true, currentBid: 0.30, currentBudget: 5, safeMaxCpc: 0.60,
  impressions: 0, clicks: 0, orders: 0, sales: 0, spend: 0,
  spendShare: 0, maxSpendWithoutSale: 15,
  budgetExhausted: false, budgetOptimizationEnabled: true,
}, config);
assert.equal(safeEntry.action, 'increase_bid');
assert.equal(safeEntry.valueAfter, 0.31);

const outOfBudgetClassification = classifyEconomicCampaign({
  campaignType: 'SP', isAuto: false, state: 'enabled', ageHours: 200, dataFresh: true,
  structurallyComplete: true, economicsAvailable: true, inStock: true,
  accountOutOfBudget: true,
  impressions: 0, clicks: 0, orders: 0, sales: 0,
  spendShare: 0, lowVolume: false,
  profitAfterAds: 0, acos: null, targetAcos: 25,
}, config);
assert.equal(outOfBudgetClassification, 'ACCOUNT_OUT_OF_BUDGET');

const outOfBudgetHold = proposeEconomicAdjustment({
  classification: outOfBudgetClassification, ageHours: 200, isAuto: false, highlyRelevant: true,
  economicsAvailable: true, currentBid: 0.30, currentBudget: 5, safeMaxCpc: 0.60,
  impressions: 0, clicks: 0, orders: 0, sales: 0, spend: 0,
  spendShare: 0, maxSpendWithoutSale: 15,
  budgetExhausted: true, budgetOptimizationEnabled: true,
}, config);
assert.equal(outOfBudgetHold.action, 'observe');
assert.equal(outOfBudgetHold.rule, 'ACCOUNT_OUT_OF_BUDGET_HOLD');
assert.equal(outOfBudgetHold.blockedBy, 'ACCOUNT_OUT_OF_BUDGET');

const winnerWhileOutOfBudget = classifyEconomicCampaign({
  campaignType: 'SP', isAuto: false, state: 'enabled', ageHours: 500, dataFresh: true,
  structurallyComplete: true, economicsAvailable: true, inStock: true,
  accountOutOfBudget: true,
  impressions: 1000, clicks: 30, orders: 4, sales: 200,
  spendShare: 0.35, lowVolume: false,
  profitAfterAds: 40, acos: 15, targetAcos: 25,
}, config);
assert.equal(winnerWhileOutOfBudget, 'PROTECTED_WINNER');

const unsafe = proposeEconomicAdjustment({
  classification: 'ECONOMICALLY_UNSAFE', ageHours: 48, isAuto: false, highlyRelevant: true,
  economicsAvailable: false, currentBid: 0.30, currentBudget: 5, safeMaxCpc: 0,
  impressions: 0, clicks: 0, orders: 0, sales: 0, spend: 0,
  spendShare: 0, maxSpendWithoutSale: 0,
  budgetExhausted: false, budgetOptimizationEnabled: true,
}, config);
assert.equal(unsafe.action, 'observe');
assert.equal(unsafe.blockedBy, 'ECONOMIC_DATA_MISSING');

const winner = proposeEconomicAdjustment({
  classification: 'PROTECTED_WINNER', ageHours: 500, isAuto: false, highlyRelevant: true,
  economicsAvailable: true, currentBid: 0.50, currentBudget: 10, safeMaxCpc: 0.75,
  impressions: 1000, clicks: 30, orders: 4, sales: 200, spend: 30,
  spendShare: 0.35, maxSpendWithoutSale: 15,
  budgetExhausted: false, budgetOptimizationEnabled: true,
}, config);
assert.equal(winner.action, 'observe');
assert.equal(winner.rule, 'PROTECTED_WINNER_HOLD');

const lowBidRoundingGuard = proposeEconomicAdjustment({
  classification: 'NEW_NO_IMPRESSIONS', ageHours: 48, isAuto: false, highlyRelevant: true,
  economicsAvailable: true, currentBid: 0.10, currentBudget: 5, safeMaxCpc: 0.30,
  impressions: 0, clicks: 0, orders: 0, sales: 0, spend: 0,
  spendShare: 0, maxSpendWithoutSale: 15,
  budgetExhausted: false, budgetOptimizationEnabled: true,
}, config);
assert.equal(lowBidRoundingGuard.action, 'observe');
