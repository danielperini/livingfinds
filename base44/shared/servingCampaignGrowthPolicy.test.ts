import { strict as assert } from 'node:assert';
import {
  calculateEconomicPromotionCapacity,
  calculateServingGrowthGoal,
  calculateTrafficSufficiency,
  classifyTrafficState,
  evaluateAutoDiscoveryBudget,
  hasServingEvidence,
  shouldProtectServingManual,
} from './servingCampaignGrowthPolicy.ts';

Deno.test('meta de +40% usa SERVING e arredonda 14 para 20', () => {
  const goal = calculateServingGrowthGoal({ baselineServing: 14, currentServing: 14, targetGrowthPct: 40 });
  assert.equal(goal.target_serving_campaigns, 20);
  assert.equal(goal.growth_gap, 6);
  assert.equal(goal.goal_met, false);
  assert.equal(goal.metric, 'SERVING_CAMPAIGNS');
});

Deno.test('growth_gap zero não bloqueia Search Term comprador elegível', () => {
  const goal = calculateServingGrowthGoal({ baselineServing: 10, currentServing: 14, targetGrowthPct: 40 });
  assert.equal(goal.growth_gap, 0);
  assert.equal(calculateEconomicPromotionCapacity({ maxNewExactPerRun: 6, economicEligibleConvertedTerms: 4 }), 4);
});

Deno.test('MANUAL in-flight não reduz a capacidade econômica de EXACT', () => {
  assert.equal(calculateEconomicPromotionCapacity({ maxNewExactPerRun: 6, economicEligibleConvertedTerms: 20 }), 6);
});

Deno.test('EXISTS sem entrega não conta como SERVING', () => {
  assert.equal(hasServingEvidence({ impressions: 0, clicks: 0, spend: 0 }), false);
  assert.equal(hasServingEvidence({ impressions: 1, clicks: 0, spend: 0 }), true);
  assert.equal(hasServingEvidence({ impressions: 0, clicks: 1, spend: 0 }), true);
});

Deno.test('23 cliques a CVR 5% ainda têm cerca de 30,7% de chance de zero pedido', () => {
  const traffic = calculateTrafficSufficiency({ clicks: 23, conservativeCvr: 0.05, evaluationConfidence: 0.80 });
  assert.equal(traffic.required_clicks, 32);
  assert.equal(traffic.statistically_sufficient, false);
  assert.ok(Math.abs(traffic.zero_order_probability - 0.3074) < 0.0002);
});

Deno.test('manual com entrega e amostra insuficiente fica protegida dentro do loss budget', () => {
  const classified = classifyTrafficState({ impressions: 40, clicks: 3, spend: 1.35, orders: 0, conservativeCvr: 0.08 });
  assert.equal(classified.state, 'SERVING_LEARNING');
  assert.equal(shouldProtectServingManual({
    manual: true, impressions: 40, clicks: 3, spend: 1.35, orders: 0,
    conservativeCvr: 0.08, loss: 1.35, lossBudget: 5,
  }), true);
  assert.equal(shouldProtectServingManual({
    manual: true, impressions: 40, clicks: 3, spend: 5, orders: 0,
    conservativeCvr: 0.08, loss: 5, lossBudget: 5,
  }), false);
});

const safeAuto = {
  automatic: true,
  enabled: true,
  inStock: true,
  budgetLimited: true,
  growthGap: 6,
  currentBudget: 5,
  impressions: 178,
  clicks: 5,
  spend: 4.65,
  orders: 0,
  sales: 0,
  currentCpc: 0.93,
  safeMaxCpc: 1,
  loss: 4.65,
  lossBudget: 7,
  accountTacos: 4,
  maximumTacos: 10,
  accountSpend: 16.23,
  accountBudgetCap: 80,
  spendAvailableNow: 63.77,
  maximumCampaignBudget: 20,
};

Deno.test('AUTO saudável limitada recebe expansão de discovery máxima de 10%', () => {
  const decision = evaluateAutoDiscoveryBudget(safeAuto);
  assert.equal(decision.eligible, true);
  assert.equal(decision.target_budget, 5.5);
  assert.equal(decision.increase_amount, 0.5);
});

Deno.test('discovery AUTO bloqueia CPC, loss budget, TACoS e orçamento global inseguros', () => {
  assert.equal(evaluateAutoDiscoveryBudget({ ...safeAuto, currentCpc: 1.01 }).reason, 'CPC_ABOVE_SAFE_MAX');
  assert.equal(evaluateAutoDiscoveryBudget({ ...safeAuto, loss: 7 }).reason, 'LOSS_BUDGET_EXHAUSTED');
  assert.equal(evaluateAutoDiscoveryBudget({ ...safeAuto, accountTacos: null }).reason, 'TACOS_MER_UNAVAILABLE');
  assert.equal(evaluateAutoDiscoveryBudget({ ...safeAuto, accountTacos: 11 }).reason, 'TACOS_MER_ABOVE_LIMIT');
  assert.equal(evaluateAutoDiscoveryBudget({ ...safeAuto, accountSpend: 80, spendAvailableNow: 0 }).reason, 'GLOBAL_BUDGET_EXHAUSTED');
});

Deno.test('discovery bloqueia safe CPC, estoque e ACoS econômico inseguros', () => {
  assert.equal(evaluateAutoDiscoveryBudget({ ...safeAuto, safeMaxCpc: 0 }).reason, 'MISSING_SAFE_MAX_CPC');
  assert.equal(evaluateAutoDiscoveryBudget({ ...safeAuto, inStock: false }).reason, 'OUT_OF_STOCK');
  assert.equal(evaluateAutoDiscoveryBudget({ ...safeAuto, orders: 1, sales: 5, currentAcos: 50, maximumAcos: 40 }).reason, 'ACOS_ABOVE_ECONOMIC_LIMIT');
});

Deno.test('winner limitado cresce 5%, mas conta sem headroom bloqueia expansão', () => {
  const winner = evaluateAutoDiscoveryBudget({ ...safeAuto, currentBudget: 10, orders: 2, sales: 30, currentAcos: 15, maximumAcos: 40, maximumIncreasePct: 5 });
  assert.equal(winner.eligible, true);
  assert.equal(winner.increase_pct, 5);
  assert.equal(evaluateAutoDiscoveryBudget({ ...safeAuto, accountSpend: 80, spendAvailableNow: 0 }).eligible, false);
});
