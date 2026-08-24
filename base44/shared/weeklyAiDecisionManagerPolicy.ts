export type PortfolioClass = 'WINNER' | 'EFFICIENT' | 'LEARNING' | 'UNDEREXPOSED' | 'INEFFICIENT';

const n = (v: unknown) => Number.isFinite(Number(v)) ? Number(v) : 0;
export const HARD_GUARDS = new Set(['safeMaxCpc', 'kill_switch', 'account_financial_cap', 'stock_hard_guard', 'buyability', 'amazon_eligibility', 'listing_offer_active', 'authentication', 'canonical_gateway', 'deduplication', 'idempotency', 'rollback_safety', 'absolute_financial_limits', 'execution_safety', 'daily_exact_limit', 'daily_pause_limit']);
export const AI_TUNABLE_RULES = new Set(['winner_bid_step', 'zero_delivery_bid_step', 'cooldown_hours', 'observation_window', 'confidence_threshold', 'minimum_evidence', 'harvesting_threshold', 'winner_score_weights', 'waste_score_weights', 'budget_allocation_weights', 'evaluation_frequency', 'pause_progression', 'reactivation_threshold', 'underexposure_threshold']);

export function classifyPortfolioCampaign(row: any): PortfolioClass {
  const impressions = n(row.impressions), clicks = n(row.clicks), spend = n(row.spend), sales = n(row.sales), orders = n(row.orders);
  const mature = Boolean(row.mature) || clicks >= 8 || spend >= n(row.minimum_economic_spend || 8);
  const profit = n(row.profit_after_ads);
  if (orders > 0 && profit > 0 && (n(row.acos) <= n(row.target_acos) || !n(row.target_acos))) return orders >= 2 ? 'WINNER' : 'EFFICIENT';
  if (!mature && impressions <= 0) return 'UNDEREXPOSED';
  if (!mature || (impressions > 0 && clicks === 0 && impressions < 500)) return 'LEARNING';
  if (orders <= 0 || profit < 0 || (sales > 0 && n(row.acos) > n(row.break_even_acos))) return 'INEFFICIENT';
  return 'LEARNING';
}

export function portfolioEfficiency(rows: any[]) {
  const evaluated = (rows || []).filter((row) => ['WINNER', 'EFFICIENT', 'INEFFICIENT'].includes(row.classification || classifyPortfolioCampaign(row)));
  const efficient = evaluated.filter((row) => ['WINNER', 'EFFICIENT'].includes(row.classification || classifyPortfolioCampaign(row)));
  const spend = evaluated.reduce((sum, row) => sum + n(row.spend), 0);
  const efficientSpend = efficient.reduce((sum, row) => sum + n(row.spend), 0);
  return { efficient_campaign_rate: evaluated.length ? efficient.length / evaluated.length : 0, inefficient_campaign_rate: evaluated.length ? 1 - efficient.length / evaluated.length : 0, efficient_spend_share: spend ? efficientSpend / spend : 0, waste_spend_share: spend ? (spend - efficientSpend) / spend : 0 };
}

export function boundedSoftRuleChange(ruleKey: string, before: number, requested: number) {
  if (!AI_TUNABLE_RULES.has(ruleKey) || HARD_GUARDS.has(ruleKey) || !Number.isFinite(before) || !Number.isFinite(requested)) return { allowed: false, value: before, reason: 'immutable_or_invalid_rule' };
  const limit = Math.abs(before) * 0.25;
  return { allowed: true, value: Math.max(before - limit, Math.min(before + limit, requested)), reason: 'bounded_weekly_change' };
}
