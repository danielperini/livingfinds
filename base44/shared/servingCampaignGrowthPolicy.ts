export type DeliveryEvidence = {
  impressions?: unknown;
  clicks?: unknown;
  spend?: unknown;
  sales?: unknown;
  orders?: unknown;
};

export type TrafficState =
  | 'ZERO_DELIVERY'
  | 'SERVING_LEARNING'
  | 'SERVING_EVALUABLE'
  | 'CONVERTING';

const finite = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const positive = (value: unknown): number => Math.max(0, finite(value));
const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));
const money = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;
const ratio = (value: number): number => Math.round((value + Number.EPSILON) * 10_000) / 10_000;

/**
 * SERVING significa entrega observada. Uma campanha meramente ENABLED/EXISTS
 * nunca entra na meta de crescimento sem impressão, clique ou gasto real.
 */
export function hasServingEvidence(input: DeliveryEvidence): boolean {
  return positive(input.impressions) > 0 || positive(input.clicks) > 0 || positive(input.spend) > 0;
}

export function calculateServingGrowthGoal(input: {
  baselineServing: unknown;
  currentServing: unknown;
  targetGrowthPct?: unknown;
}) {
  const baselineServing = Math.max(0, Math.floor(finite(input.baselineServing)));
  const currentServing = Math.max(0, Math.floor(finite(input.currentServing)));
  const targetGrowthPct = clamp(finite(input.targetGrowthPct, 40), 0, 100);
  const targetServing = baselineServing > 0
    ? Math.ceil(baselineServing * (1 + targetGrowthPct / 100))
    : 1;
  const growthGap = Math.max(0, targetServing - currentServing);

  return {
    baseline_serving_campaigns: baselineServing,
    current_serving_campaigns: currentServing,
    target_serving_campaigns: targetServing,
    target_growth_pct: targetGrowthPct,
    growth_gap: growthGap,
    goal_met: currentServing >= targetServing,
    metric: 'SERVING_CAMPAIGNS' as const,
  };
}

/**
 * Cliques necessários para que a chance de observar ao menos uma compra alcance
 * a confiança escolhida, assumindo a CVR conservadora do ASIN.
 * TS = cliques observados / cliques necessários.
 */
export function calculateTrafficSufficiency(input: {
  clicks?: unknown;
  conservativeCvr?: unknown;
  evaluationConfidence?: unknown;
}) {
  const clicks = positive(input.clicks);
  const conservativeCvr = clamp(finite(input.conservativeCvr, 0.05), 0.005, 0.50);
  const evaluationConfidence = clamp(finite(input.evaluationConfidence, 0.80), 0.50, 0.99);
  const requiredClicks = Math.max(1, Math.ceil(
    Math.log(1 - evaluationConfidence) / Math.log(1 - conservativeCvr),
  ));
  const sufficiency = clicks / requiredClicks;
  const zeroOrderProbability = (1 - conservativeCvr) ** clicks;

  return {
    observed_clicks: clicks,
    required_clicks: requiredClicks,
    traffic_sufficiency: ratio(sufficiency),
    statistically_sufficient: sufficiency >= 1,
    conservative_cvr: ratio(conservativeCvr),
    evaluation_confidence: ratio(evaluationConfidence),
    zero_order_probability: ratio(zeroOrderProbability),
  };
}

export function classifyTrafficState(input: DeliveryEvidence & {
  conservativeCvr?: unknown;
  evaluationConfidence?: unknown;
}): { state: TrafficState; serving: boolean; traffic: ReturnType<typeof calculateTrafficSufficiency> } {
  const serving = hasServingEvidence(input);
  const traffic = calculateTrafficSufficiency(input);
  const orders = positive(input.orders);
  const state: TrafficState = orders > 0
    ? 'CONVERTING'
    : !serving
      ? 'ZERO_DELIVERY'
      : traffic.statistically_sufficient
        ? 'SERVING_EVALUABLE'
        : 'SERVING_LEARNING';
  return { state, serving, traffic };
}

/**
 * Uma MANUAL que entrou no leilão continua aprendendo enquanto a amostra é
 * insuficiente e o loss budget não foi consumido. Idade isolada não autoriza corte.
 */
export function shouldProtectServingManual(input: {
  manual: boolean;
  impressions: unknown;
  clicks: unknown;
  spend: unknown;
  orders: unknown;
  conservativeCvr?: unknown;
  evaluationConfidence?: unknown;
  loss: unknown;
  lossBudget: unknown;
}): boolean {
  if (!input.manual || !hasServingEvidence(input) || positive(input.orders) > 0) return false;
  const traffic = calculateTrafficSufficiency(input);
  const lossBudget = positive(input.lossBudget);
  return !traffic.statistically_sufficient && lossBudget > 0 && positive(input.loss) < lossBudget;
}

export type AutoDiscoveryBudgetInput = DeliveryEvidence & {
  automatic: boolean;
  enabled: boolean;
  inStock: boolean;
  budgetLimited: boolean;
  growthGap: unknown;
  currentBudget: unknown;
  currentCpc: unknown;
  safeMaxCpc: unknown;
  loss: unknown;
  lossBudget: unknown;
  currentAcos?: unknown;
  maximumAcos?: unknown;
  accountTacos?: unknown;
  maximumTacos?: unknown;
  accountSpend: unknown;
  accountBudgetCap: unknown;
  spendAvailableNow?: unknown;
  maximumCampaignBudget?: unknown;
  maximumIncreasePct?: unknown;
  maximumIncreaseAmount?: unknown;
  minimumIncreaseAmount?: unknown;
  hardStop?: boolean;
};

export type AutoDiscoveryBudgetDecision = {
  eligible: boolean;
  reason: string;
  current_budget: number;
  target_budget: number;
  increase_amount: number;
  increase_pct: number;
  remaining_loss_budget: number;
  remaining_account_budget: number;
};

export function evaluateAutoDiscoveryBudget(input: AutoDiscoveryBudgetInput): AutoDiscoveryBudgetDecision {
  const currentBudget = positive(input.currentBudget);
  const currentSpend = positive(input.spend);
  const currentCpc = positive(input.currentCpc);
  const safeMaxCpc = positive(input.safeMaxCpc);
  const loss = positive(input.loss);
  const lossBudget = positive(input.lossBudget);
  const accountSpend = positive(input.accountSpend);
  const accountBudgetCap = positive(input.accountBudgetCap);
  const configuredAvailable = finite(input.spendAvailableNow, Number.NaN);
  const remainingAccountBudget = money(Math.max(0,
    Number.isFinite(configuredAvailable)
      ? Math.min(configuredAvailable, Math.max(0, accountBudgetCap - accountSpend))
      : accountBudgetCap - accountSpend,
  ));
  const remainingLossBudget = money(Math.max(0, lossBudget - loss));

  const result = (eligible: boolean, reason: string, targetBudget = currentBudget): AutoDiscoveryBudgetDecision => {
    const target = money(targetBudget);
    const increase = money(Math.max(0, target - currentBudget));
    return {
      eligible,
      reason,
      current_budget: money(currentBudget),
      target_budget: target,
      increase_amount: increase,
      increase_pct: currentBudget > 0 ? ratio(increase / currentBudget * 100) : 0,
      remaining_loss_budget: remainingLossBudget,
      remaining_account_budget: remainingAccountBudget,
    };
  };

  if (Math.floor(finite(input.growthGap)) <= 0) return result(false, 'SERVING_GROWTH_GOAL_ALREADY_MET');
  if (!input.automatic) return result(false, 'NOT_AUTOMATIC');
  if (!input.enabled) return result(false, 'CAMPAIGN_NOT_ENABLED');
  if (!input.inStock) return result(false, 'OUT_OF_STOCK');
  if (!input.budgetLimited) return result(false, 'NOT_BUDGET_LIMITED');
  if (!hasServingEvidence(input)) return result(false, 'NO_SERVING_EVIDENCE');
  if (input.hardStop === true) return result(false, 'ACCOUNT_HARD_STOP');
  if (currentBudget <= 0) return result(false, 'MISSING_CURRENT_BUDGET');
  if (safeMaxCpc <= 0) return result(false, 'MISSING_SAFE_MAX_CPC');
  if (currentCpc <= 0 || currentCpc > safeMaxCpc + 0.0001) return result(false, 'CPC_ABOVE_SAFE_MAX');
  if (lossBudget <= 0) return result(false, 'MISSING_LOSS_BUDGET');
  if (remainingLossBudget <= 0) return result(false, 'LOSS_BUDGET_EXHAUSTED');
  if (accountBudgetCap <= 0 || remainingAccountBudget <= 0) return result(false, 'GLOBAL_BUDGET_EXHAUSTED');

  const orders = positive(input.orders);
  const sales = positive(input.sales);
  const currentAcos = positive(input.currentAcos);
  const maximumAcos = positive(input.maximumAcos);
  if (orders > 0 && sales > 0 && (maximumAcos <= 0 || currentAcos > maximumAcos)) {
    return result(false, 'ACOS_ABOVE_ECONOMIC_LIMIT');
  }

  const accountTacos = input.accountTacos === null || input.accountTacos === undefined || input.accountTacos === ''
    ? Number.NaN
    : Number(input.accountTacos);
  const maximumTacos = positive(input.maximumTacos);
  if (!Number.isFinite(accountTacos) || maximumTacos <= 0) return result(false, 'TACOS_MER_UNAVAILABLE');
  if (accountTacos > maximumTacos) return result(false, 'TACOS_MER_ABOVE_LIMIT');

  const maximumIncreasePct = clamp(finite(input.maximumIncreasePct, 10), 1, 10);
  const maximumIncreaseAmount = clamp(finite(input.maximumIncreaseAmount, 1), 0.50, 5);
  const minimumIncreaseAmount = clamp(finite(input.minimumIncreaseAmount, 0.50), 0.10, maximumIncreaseAmount);
  const maximumCampaignBudget = Math.max(currentBudget, positive(input.maximumCampaignBudget) || currentBudget * 1.10);
  const requestedDelta = Math.min(
    currentBudget * (maximumIncreasePct / 100),
    maximumIncreaseAmount,
    remainingLossBudget,
    remainingAccountBudget,
    Math.max(0, maximumCampaignBudget - currentBudget),
  );
  if (requestedDelta + 0.0001 < minimumIncreaseAmount) return result(false, 'INSUFFICIENT_SAFE_HEADROOM');

  return result(true, 'AUTO_DISCOVERY_BUDGET_SAFE', currentBudget + requestedDelta);
}
