export type EconomicCircuitState =
  | 'NORMAL'
  | 'VIGILANT'
  | 'DEFENSIVE'
  | 'LOSS_CONFIRMED'
  | 'NOT_BUYABLE';

const round = (value: number, digits = 4) => {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
};

export function calculateSmoothedSameSkuCvr(params: {
  sameSkuOrders?: number | null;
  totalOrders?: number | null;
  clicks?: number | null;
  asinPriorCvr?: number | null;
  priorWeight?: number | null;
  fallbackCvr?: number | null;
}) {
  const clicks = Math.max(0, Number(params.clicks || 0));
  const sameSkuOrders = Math.max(0, Number(params.sameSkuOrders || 0));
  const totalOrders = Math.max(0, Number(params.totalOrders || 0));
  const prior = Math.max(0, Number(params.asinPriorCvr || 0));
  const priorWeight = Math.max(0, Number(params.priorWeight ?? 20));
  const fallback = Math.max(0, Number(params.fallbackCvr || 0.05));

  if (clicks > 0 && sameSkuOrders > 0) {
    if (prior > 0 && priorWeight > 0) {
      return {
        cvr: round((sameSkuOrders + prior * priorWeight) / (clicks + priorWeight)),
        source: 'same_sku_bayesian',
      };
    }
    return { cvr: round(sameSkuOrders / clicks), source: 'same_sku_observed' };
  }
  if (clicks > 0 && totalOrders > 0) {
    return { cvr: round(totalOrders / clicks), source: 'total_orders_fallback' };
  }
  if (prior > 0) return { cvr: round(prior), source: 'asin_prior' };
  return { cvr: round(fallback), source: 'account_fallback' };
}

export function calculateSkuWindowEconomics(params: {
  sameSkuOrders?: number | null;
  sameSkuSales?: number | null;
  totalAttributedSales?: number | null;
  spend?: number | null;
  clicks?: number | null;
  contributionMarginPerOrder?: number | null;
  targetAcos?: number | null;
  realSkuRevenue?: number | null;
  realContributionMargin?: number | null;
}) {
  const sameSkuOrders = Math.max(0, Number(params.sameSkuOrders || 0));
  const sameSkuSales = Math.max(0, Number(params.sameSkuSales || 0));
  const totalAttributedSales = Math.max(0, Number(params.totalAttributedSales || 0));
  const spend = Math.max(0, Number(params.spend || 0));
  const clicks = Math.max(0, Number(params.clicks || 0));
  const marginPerOrder = Math.max(0, Number(params.contributionMarginPerOrder || 0));
  const targetAcos = Math.max(0, Number(params.targetAcos || 0));
  const realSkuRevenue = Math.max(0, Number(params.realSkuRevenue || 0));
  const realContributionMargin = Math.max(0, Number(params.realContributionMargin || 0));

  const profitAfterAdsTotal = sameSkuOrders * marginPerOrder - spend;
  const profitAfterAdsPerOrder = sameSkuOrders > 0
    ? profitAfterAdsTotal / sameSkuOrders
    : -spend;
  const sameSkuAcos = sameSkuSales > 0 ? spend / sameSkuSales : null;
  const cpc = clicks > 0 ? spend / clicks : 0;
  const cpa = sameSkuOrders > 0 ? spend / sameSkuOrders : null;
  const excessSpend = Math.max(0, spend - sameSkuSales * targetAcos);
  const haloSales = Math.max(0, totalAttributedSales - sameSkuSales);
  const realAdCostRatio = realSkuRevenue > 0 ? spend / realSkuRevenue : null;
  const realProfitAfterAds = realContributionMargin - spend;
  const attributionGapAmount = totalAttributedSales - realSkuRevenue;
  const attributionGapPercent = realSkuRevenue > 0 ? attributionGapAmount / realSkuRevenue : null;
  const economicAttributionStatus = realSkuRevenue > 0 && totalAttributedSales > realSkuRevenue * 1.25
    ? 'HALO_OR_PERIOD_MISMATCH'
    : 'ALIGNED';

  return {
    same_sku_acos: sameSkuAcos == null ? null : round(sameSkuAcos),
    cpc: round(cpc),
    cpa: cpa == null ? null : round(cpa),
    profit_after_ads_total: round(profitAfterAdsTotal, 2),
    profit_after_ads_per_order: round(profitAfterAdsPerOrder, 2),
    excess_spend: round(excessSpend, 2),
    halo_sales: round(haloSales, 2),
    real_ad_cost_ratio: realAdCostRatio == null ? null : round(realAdCostRatio),
    real_profit_after_ads: round(realProfitAfterAds, 2),
    attribution_gap_amount: round(attributionGapAmount, 2),
    attribution_gap_percent: attributionGapPercent == null ? null : round(attributionGapPercent),
    economic_attribution_status: economicAttributionStatus,
  };
}

export function calculateEconomicCpc(params: {
  contributionMarginPerOrder?: number | null;
  sameSkuCvr?: number | null;
  safetyFactor?: number | null;
}) {
  const maximum = Math.max(0, Number(params.contributionMarginPerOrder || 0))
    * Math.max(0, Number(params.sameSkuCvr || 0));
  return {
    maximum_economic_cpc: round(maximum, 2),
    safe_max_cpc: round(maximum * Math.max(0, Number(params.safetyFactor ?? 0.8)), 2),
  };
}

export function classifyEconomicCircuit(params: {
  listingBuyable?: boolean | null;
  offerActive?: boolean | null;
  listingSuppressed?: boolean | null;
  realAdCostRatio?: number | null;
  targetAcos?: number | null;
  breakEvenAcos?: number | null;
  realProfitAfterAds?: number | null;
}): EconomicCircuitState {
  if (params.listingBuyable !== true || params.offerActive !== true || params.listingSuppressed === true) {
    return 'NOT_BUYABLE';
  }
  const ratio = Number(params.realAdCostRatio || 0);
  const target = Number(params.targetAcos || 0);
  const breakEven = Number(params.breakEvenAcos || 0);
  if (params.realProfitAfterAds != null && Number(params.realProfitAfterAds) <= 0) return 'LOSS_CONFIRMED';
  if (breakEven > 0 && ratio > breakEven) return 'DEFENSIVE';
  if (target > 0 && ratio > target) return 'VIGILANT';
  return 'NORMAL';
}

export function classifyEntityIntervention(params: {
  sameSkuOrders?: number | null;
  sameSkuSales?: number | null;
  spend?: number | null;
  clicks?: number | null;
  cpc?: number | null;
  contributionMarginPerOrder?: number | null;
  expectedClicksPerOrder?: number | null;
  safeMaxCpc?: number | null;
  sameSkuAcos?: number | null;
  breakEvenAcos?: number | null;
  priorReductionCount?: number | null;
  winnerConfirmed?: boolean | null;
}) {
  if (params.winnerConfirmed === true) return { action: 'PRESERVE', reduction_pct: 0, reason: 'same_sku_winner' };
  const orders = Math.max(0, Number(params.sameSkuOrders || 0));
  const spend = Math.max(0, Number(params.spend || 0));
  const clicks = Math.max(0, Number(params.clicks || 0));
  const cpc = Math.max(0, Number(params.cpc || 0));
  const margin = Math.max(0, Number(params.contributionMarginPerOrder || 0));
  const expectedClicks = Math.max(1, Number(params.expectedClicksPerOrder || 20));
  const safeCpc = Math.max(0, Number(params.safeMaxCpc || 0));
  const sameSkuAcos = params.sameSkuAcos == null ? null : Number(params.sameSkuAcos);
  const breakEvenAcos = Math.max(0, Number(params.breakEvenAcos || 0));
  const priorReductions = Math.max(0, Number(params.priorReductionCount || 0));

  const strong = orders === 0 && (
    (margin > 0 && spend >= margin)
    || clicks >= expectedClicks
  ) || (sameSkuAcos != null && breakEvenAcos > 0 && sameSkuAcos > breakEvenAcos);
  const pause = priorReductions > 0 && orders === 0
    && ((margin > 0 && spend >= margin * 1.5) || clicks >= expectedClicks * 2);
  if (pause) return { action: 'PAUSE_CANDIDATE', reduction_pct: 0, reason: 'persistent_loss_after_bid_reduction' };
  if (strong) return { action: 'REDUCE_STRONG', reduction_pct: 0.2, reason: 'above_economic_break_even' };

  const soft = orders === 0 && (
    (margin > 0 && spend >= margin * 0.6)
    || clicks >= expectedClicks * 0.75
    || (safeCpc > 0 && cpc > safeCpc * 1.15)
  );
  if (soft) return { action: 'REDUCE_SOFT', reduction_pct: 0.11, reason: 'approaching_economic_limit' };
  return { action: 'MONITOR', reduction_pct: 0, reason: 'insufficient_loss_evidence' };
}

export function capBidChange(currentBid: number, proposedBid: number, maxChangePct = 0.2) {
  const current = Math.max(0, Number(currentBid || 0));
  const maxChange = Math.min(0.2, Math.max(0, Number(maxChangePct || 0)));
  return round(Math.max(current * (1 - maxChange), Math.min(current * (1 + maxChange), proposedBid)), 2);
}
