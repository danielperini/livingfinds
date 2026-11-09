export type DailyAdsCandidate = {
  entity_id: string;
  entity_type: 'campaign' | 'keyword' | 'search_term';
  campaign_id?: string;
  keyword_id?: string;
  asin?: string;
  sku?: string;
  term?: string;
  state?: string;
  spend: number;
  sales: number;
  orders: number;
  clicks: number;
  impressions: number;
  acos: number | null;
  current_bid?: number;
  daily_budget?: number;
  stock?: number;
  safe_max_cpc?: number;
  target_acos?: number;
  margin_rate?: number;
  profit_after_ads?: number;
  evidence_days?: number;
};

export type DailyAdsSettings = {
  minBid: number;
  maxBid: number;
  maxAcos: number;
  targetAcos: number;
  dailyBudgetCap: number;
  maxBidStepPct: number;
  maxBudgetStepPct: number;
  maxProposals: number;
  aiConfidenceThreshold: number;
  minReductionEvidenceDays: number;
};

/** Política fixa no backend; a IA pode sugerir, mas não pode alterá-la. */
export const AUTONOMOUS_ADS_RISK_POLICY = Object.freeze({
  version: '2026-11-09-br-v1',
  marketplace: 'BR',
  currency: 'BRL',
  mode: 'autonomous',
  minCalibratedConfidence: 0.80,
  requireHumanApproval: false,
  maxBidIncreasePct24h: 10,
  maxBidDecreasePct24h: 20,
  maxBudgetIncreasePct: 0,
  maxNewCampaignsPerDay: 5,
  // Exceção operacional autorizada pelo gestor para 09/11/2026; expira
  // automaticamente e não altera o limite padrão dos demais dias.
  exceptionalDailyMaxNewCampaigns: 15,
  exceptionalDateBrt: '2026-11-09',
  maxNewCampaignBudget: 20,
  allowBulkCreation: false,
  allowCampaignPause: false,
  // Exceção determinística de ciclo de catálogo: campanhas de produto
  // inativo não participam da gestão econômica e são pausadas com confirmação
  // da Amazon. Isso não libera a IA a pausar campanhas por desempenho.
  inactiveProductCampaignPause: true,
  requireAccountSpendCap: true,
  requireSkuMarginForScaling: true,
  stopOnStaleData: true,
  requireExecutionConfirmation: true,
  enableAuditLog: true,
  enableKillSwitch: true,
});

export type AiAdsRecommendation = {
  entity_id: string;
  action: string;
  proposed_value?: number;
  confidence: number;
  rationale?: string;
  evidence?: string[];
  last_resort?: boolean;
};

export const DEFAULT_DAILY_AI_SETTINGS: DailyAdsSettings = {
  minBid: 0.20,
  maxBid: 1.00,
  maxAcos: 40,
  targetAcos: 15,
  dailyBudgetCap: 100,
  maxBidStepPct: 15,
  maxBudgetStepPct: 10,
  maxProposals: 25,
  aiConfidenceThreshold: 0.80,
  minReductionEvidenceDays: 2,
};

function n(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function normalizeConfidence(value: unknown): number {
  const parsed = n(value);
  if (parsed > 1) return Math.max(0, Math.min(1, parsed / 100));
  return Math.max(0, Math.min(1, parsed));
}

export function clampBid(value: unknown, settings = DEFAULT_DAILY_AI_SETTINGS): number {
  const rounded = Math.round(n(value, settings.minBid) * 100) / 100;
  return Math.max(settings.minBid, Math.min(settings.maxBid, rounded));
}

export function clampBidChange(
  currentValue: unknown,
  proposedValue: unknown,
  settings = DEFAULT_DAILY_AI_SETTINGS,
): number {
  const current = clampBid(currentValue, settings);
  const raw = clampBid(proposedValue, settings);
  const directionLimit = raw >= current
    ? AUTONOMOUS_ADS_RISK_POLICY.maxBidIncreasePct24h
    : AUTONOMOUS_ADS_RISK_POLICY.maxBidDecreasePct24h;
  const maxStep = Math.min(settings.maxBidStepPct, directionLimit) / 100;
  return clampBid(Math.min(current * (1 + maxStep), Math.max(current * (1 - maxStep), raw)), settings);
}

export function calculateAcos(spend: unknown, sales: unknown): number | null {
  const spendValue = n(spend);
  const salesValue = n(sales);
  if (salesValue <= 0) return spendValue > 0 ? Infinity : null;
  return (spendValue / salesValue) * 100;
}

function candidateScore(candidate: DailyAdsCandidate, settings: DailyAdsSettings): number {
  const acos = candidate.acos ?? calculateAcos(candidate.spend, candidate.sales) ?? 0;
  const noSalesWaste = candidate.sales <= 0 ? candidate.spend * 3 : 0;
  const highAcosWaste = Number.isFinite(acos) ? Math.max(0, acos - settings.maxAcos) : 0;
  const winner = candidate.orders * 20 + candidate.sales / 100;
  const opportunity = candidate.sales <= 0 && candidate.impressions > 0
    ? Math.min(candidate.impressions / 1000, 10)
    : 0;
  return noSalesWaste + highAcosWaste + winner + opportunity;
}

/**
 * Selects a compact, deterministic evidence set for the one daily AI call.
 * It intentionally excludes archived/paused entities and protects profitable winners.
 */
export function buildDailyAdsCandidates(
  candidates: DailyAdsCandidate[],
  settings = DEFAULT_DAILY_AI_SETTINGS,
): DailyAdsCandidate[] {
  const active = candidates.filter((candidate) => {
    const state = String(candidate.state || '').toLowerCase();
    return !['archived', 'paused', 'inactive'].includes(state) && candidate.stock !== 0;
  });

  return [...active]
    .sort((a, b) => candidateScore(b, settings) - candidateScore(a, settings))
    .slice(0, Math.max(1, settings.maxProposals * 4));
}

function validAction(action: string): boolean {
  return new Set([
    'increase_bid', 'reduce_bid', 'update_bid', 'increase_budget', 'reduce_budget',
    'update_budget', 'negative_keyword', 'create_manual_campaign', 'pause_campaign',
  ]).has(action);
}

/**
 * Validates AI output before it can enter the decision queue.
 * Campaign pauses and campaign creation always remain manual-review proposals.
 */
export function validateRecommendation(
  recommendation: AiAdsRecommendation,
  candidate: DailyAdsCandidate | undefined,
  settings = DEFAULT_DAILY_AI_SETTINGS,
): { valid: boolean; autoApprove: boolean; reason?: string; normalized?: AiAdsRecommendation } {
  if (!candidate) return { valid: false, autoApprove: false, reason: 'ENTITY_NOT_IN_EVIDENCE_SET' };
  const action = String(recommendation.action || '').toLowerCase();
  if (!validAction(action)) return { valid: false, autoApprove: false, reason: 'ACTION_NOT_ALLOWED' };

  const confidence = normalizeConfidence(recommendation.confidence);
  if (confidence < settings.aiConfidenceThreshold) {
    return { valid: false, autoApprove: false, reason: `CONFIDENCE_BELOW_${Math.round(settings.aiConfidenceThreshold * 100)}` };
  }

  const normalized: AiAdsRecommendation = {
    ...recommendation,
    action,
    confidence,
  };

  const currentBid = clampBid(candidate.current_bid, settings);
  if (['increase_bid', 'reduce_bid', 'update_bid'].includes(action)) {
    const proposed = clampBidChange(currentBid, recommendation.proposed_value, settings);
    if (action === 'increase_bid' && proposed <= currentBid) {
      return { valid: false, autoApprove: false, reason: 'NO_POSITIVE_BID_CHANGE' };
    }
    if (action === 'reduce_bid' && proposed >= currentBid) {
      return { valid: false, autoApprove: false, reason: 'NO_REDUCTION' };
    }
    const isReduction = proposed < currentBid;
    if (isReduction && (candidate.evidence_days || 0) < settings.minReductionEvidenceDays) {
      return { valid: false, autoApprove: false, reason: 'REDUCTION_REQUIRES_MULTI_DAY_EVIDENCE' };
    }
    if (!isReduction && candidate.sales <= 0) {
      return { valid: false, autoApprove: false, reason: 'SCALING_REQUIRES_CONVERSION' };
    }
    if (!isReduction && (candidate.margin_rate == null || candidate.margin_rate <= 0) &&
      (candidate.profit_after_ads == null || candidate.profit_after_ads <= 0)) {
      return { valid: false, autoApprove: false, reason: 'SCALING_REQUIRES_SKU_MARGIN' };
    }
    normalized.proposed_value = proposed;
  }

  if (['increase_budget', 'update_budget'].includes(action)) {
    const current = Math.max(0, n(candidate.daily_budget));
    const proposed = Math.max(0, n(recommendation.proposed_value));
    if (!current || proposed > current * (1 + settings.maxBudgetStepPct / 100)) {
      return { valid: false, autoApprove: false, reason: 'BUDGET_INCREASE_OUTSIDE_GUARDRAIL' };
    }
    if (proposed > current && AUTONOMOUS_ADS_RISK_POLICY.maxBudgetIncreasePct <= 0) {
      return { valid: false, autoApprove: false, reason: 'BUDGET_INCREASE_DISABLED_BY_POLICY' };
    }
    normalized.proposed_value = Math.round(proposed * 100) / 100;
  }

  if (action === 'pause_campaign' && !AUTONOMOUS_ADS_RISK_POLICY.allowCampaignPause) {
    return { valid: false, autoApprove: false, reason: 'CAMPAIGN_PAUSE_DISABLED_BY_POLICY' };
  }

  if (action === 'create_manual_campaign') {
    if (candidate.entity_type !== 'search_term' || candidate.orders <= 0 || !candidate.sku || !candidate.asin) {
      return { valid: false, autoApprove: false, reason: 'CAMPAIGN_CREATION_REQUIRES_SAME_SKU_CONVERSION' };
    }
    const proposedBudget = n(recommendation.proposed_value, 0);
    if (proposedBudget > AUTONOMOUS_ADS_RISK_POLICY.maxNewCampaignBudget) {
      return { valid: false, autoApprove: false, reason: 'NEW_CAMPAIGN_BUDGET_LIMIT' };
    }
    normalized.proposed_value = proposedBudget;
  }

  const budgetIncrease = ['increase_budget', 'update_budget'].includes(action)
    && n(recommendation.proposed_value) > n(candidate.daily_budget);
  const budgetIncreaseEligible = budgetIncrease
    && candidate.orders > 0
    && candidate.sales > 0
    && (candidate.stock || 0) > 0
    && (candidate.acos == null || candidate.acos <= settings.targetAcos);
  const manualReview = action === 'pause_campaign'
    || action === 'create_manual_campaign'
    || (budgetIncrease && !budgetIncreaseEligible);
  return { valid: true, autoApprove: !manualReview, normalized };
}

export function rebalanceBudgetPlan(
  candidates: DailyAdsCandidate[],
  settings = DEFAULT_DAILY_AI_SETTINGS,
): {
  totalBudget: number;
  winners: string[];
  underperformers: string[];
  headroom: number;
  activeCampaigns: number;
  zeroSpendCampaigns: string[];
  allocations: Array<{ entity_id: string; daily_budget: number; share_pct: number; spend: number; sales: number; acos: number | null }>;
} {
  const totalBudget = candidates.reduce((sum, candidate) => sum + Math.max(0, n(candidate.daily_budget)), 0);
  const winners = candidates
    .filter((candidate) => candidate.orders > 0 && (candidate.acos ?? calculateAcos(candidate.spend, candidate.sales) ?? Infinity) <= settings.targetAcos)
    .map((candidate) => candidate.entity_id);
  const underperformers = candidates
    .filter((candidate) => candidate.sales <= 0 && candidate.spend > 0 || (candidate.acos ?? 0) > settings.maxAcos)
    .map((candidate) => candidate.entity_id);
  const zeroSpendCampaigns = candidates
    .filter((candidate) => candidate.spend <= 0)
    .map((candidate) => candidate.entity_id);
  const allocations = candidates
    .map((candidate) => ({
      entity_id: candidate.entity_id,
      daily_budget: Math.round(Math.max(0, n(candidate.daily_budget)) * 100) / 100,
      share_pct: totalBudget > 0
        ? Math.round((Math.max(0, n(candidate.daily_budget)) / totalBudget) * 10000) / 100
        : 0,
      spend: Math.round(Math.max(0, n(candidate.spend)) * 100) / 100,
      sales: Math.round(Math.max(0, n(candidate.sales)) * 100) / 100,
      acos: candidate.acos == null || !Number.isFinite(candidate.acos)
        ? candidate.acos ?? null
        : Math.round(candidate.acos * 100) / 100,
    }))
    .sort((a, b) => b.daily_budget - a.daily_budget);
  return {
    totalBudget,
    winners,
    underperformers,
    headroom: Math.max(0, settings.dailyBudgetCap - totalBudget),
    activeCampaigns: candidates.length,
    zeroSpendCampaigns,
    allocations,
  };
}
