export type AttributionConfidence = 'complete' | 'partial' | 'unknown';
export type DeteriorationLevel = 'stable' | 'warning' | 'change';
export type InterventionState =
  | 'wait_for_data'
  | 'hold_for_attribution'
  | 'reduce_soft'
  | 'reduce_strong'
  | 'pause_candidate';

const finite = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const positive = (value: unknown): number => Math.max(0, finite(value));
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const round = (value: number, decimals = 4): number => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

// Aproximação de Abramowitz-Stegun. Evita dependência estatística externa no runtime Deno.
function erf(value: number): number {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}

function normalCdf(value: number): number {
  return 0.5 * (1 + erf(value / Math.sqrt(2)));
}

export function estimateBayesianConversion(input: {
  clicks?: number | null;
  orders?: number | null;
  priorMean?: number | null;
  priorStrength?: number | null;
  sustainableRate?: number | null;
}) {
  const clicks = positive(input.clicks);
  const orders = clamp(positive(input.orders), 0, clicks);
  const priorMean = clamp(positive(input.priorMean) || 0.05, 0.001, 0.95);
  const priorStrength = clamp(positive(input.priorStrength) || 20, 2, 500);
  const alphaPrior = priorMean * priorStrength;
  const betaPrior = (1 - priorMean) * priorStrength;
  const alpha = alphaPrior + orders;
  const beta = betaPrior + Math.max(0, clicks - orders);
  const total = alpha + beta;
  const mean = alpha / total;
  const variance = (alpha * beta) / ((total ** 2) * (total + 1));
  const standardDeviation = Math.sqrt(Math.max(0, variance));
  const credibleLow = clamp(mean - 1.96 * standardDeviation, 0, 1);
  const credibleHigh = clamp(mean + 1.96 * standardDeviation, 0, 1);
  const sustainableRate = positive(input.sustainableRate);
  const probabilityBelowSustainable = sustainableRate > 0
    ? clamp(normalCdf((sustainableRate - mean) / Math.max(standardDeviation, 0.000001)), 0, 1)
    : null;

  return {
    alpha: round(alpha),
    beta: round(beta),
    posterior_mean: round(mean, 6),
    posterior_standard_deviation: round(standardDeviation, 6),
    credible_low_95: round(credibleLow, 6),
    credible_high_95: round(credibleHigh, 6),
    probability_below_sustainable: probabilityBelowSustainable == null
      ? null
      : round(probabilityBelowSustainable, 6),
    prior_mean: round(priorMean, 6),
    prior_strength: priorStrength,
    observed_clicks: clicks,
    observed_orders: orders,
  };
}

/**
 * Peso conservador de maturidade de conversão. Os pontos devem ser recalibrados
 * por marketplace a partir da distribuição real click -> order armazenada no app.
 */
export function maturityWeightForAgeHours(ageHours: number): number {
  if (!Number.isFinite(ageHours) || ageHours < 0) return 0;
  if (ageHours < 6) return 0.10;
  if (ageHours < 12) return 0.20;
  if (ageHours < 24) return 0.45;
  if (ageHours < 48) return 0.75;
  if (ageHours < 72) return 0.90;
  return 1;
}

export function estimateMatureClicks(
  rows: Array<{ date?: string | null; clicks?: number | null }>,
  now = new Date(),
) {
  let rawClicks = 0;
  let matureClicks = 0;
  for (const row of rows || []) {
    const clicks = positive(row.clicks);
    rawClicks += clicks;
    if (!row.date) {
      matureClicks += clicks;
      continue;
    }
    const timestamp = new Date(`${String(row.date).slice(0, 10)}T12:00:00Z`).getTime();
    const ageHours = (now.getTime() - timestamp) / 3600000;
    matureClicks += clicks * maturityWeightForAgeHours(ageHours);
  }
  const maturityRatio = rawClicks > 0 ? matureClicks / rawClicks : 1;
  return {
    raw_clicks: round(rawClicks, 2),
    mature_clicks: round(matureClicks, 2),
    maturity_ratio: round(clamp(maturityRatio, 0, 1), 4),
  };
}

export function calculateProfitWindow(input: {
  contributionMarginPerOrder?: number | null;
  spend?: number | null;
  orders?: number | null;
  minimumProfitPerOrder?: number | null;
}) {
  const margin = finite(input.contributionMarginPerOrder);
  const spend = positive(input.spend);
  const orders = positive(input.orders);
  const minimumProfit = positive(input.minimumProfitPerOrder);
  const maximumProfitableCpa = Math.max(0, margin - minimumProfit);
  const totalContribution = orders * margin;
  const totalProfitAfterAds = totalContribution - spend;
  const adSpendPerOrder = orders > 0 ? spend / orders : spend;
  const profitAfterAdsPerOrder = orders > 0 ? totalProfitAfterAds / orders : -spend;

  return {
    contribution_margin_per_order: round(margin, 2),
    total_contribution: round(totalContribution, 2),
    spend: round(spend, 2),
    orders: round(orders, 2),
    maximum_profitable_cpa: round(maximumProfitableCpa, 2),
    ad_spend_per_order: round(adSpendPerOrder, 2),
    profit_after_ads_total: round(totalProfitAfterAds, 2),
    profit_after_ads_per_order: round(profitAfterAdsPerOrder, 2),
    is_profitable: totalProfitAfterAds > 0,
  };
}

export function detectSequentialDeterioration(rows: Array<{
  date?: string | null;
  clicks?: number | null;
  orders?: number | null;
  spend?: number | null;
}>) {
  const daily = (rows || [])
    .filter(row => row.date)
    .map(row => {
      const clicks = positive(row.clicks);
      const orders = positive(row.orders);
      const spend = positive(row.spend);
      return {
        date: String(row.date).slice(0, 10),
        cpc: clicks > 0 ? spend / clicks : 0,
        cvr: clicks > 0 ? orders / clicks : 0,
        clicks,
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));

  if (daily.length < 5) {
    return {
      level: 'stable' as DeteriorationLevel,
      cpc_ratio: 1,
      cvr_ratio: 1,
      cusum_score: 0,
      reason: 'insufficient_daily_history',
    };
  }

  const recent = daily.slice(-3);
  const baseline = daily.slice(0, -3).slice(-11);
  const weightedAverage = (items: typeof daily, field: 'cpc' | 'cvr') => {
    const weight = items.reduce((sum, item) => sum + Math.max(1, item.clicks), 0);
    return weight > 0
      ? items.reduce((sum, item) => sum + item[field] * Math.max(1, item.clicks), 0) / weight
      : 0;
  };

  const baselineCpc = weightedAverage(baseline, 'cpc');
  const baselineCvr = weightedAverage(baseline, 'cvr');
  const recentCpc = weightedAverage(recent, 'cpc');
  const recentCvr = weightedAverage(recent, 'cvr');
  const cpcRatio = baselineCpc > 0 ? recentCpc / baselineCpc : 1;
  const cvrRatio = baselineCvr > 0 ? recentCvr / baselineCvr : 1;

  // CUSUM simplificado: acumula inflação de CPC e queda de CVR acima de tolerâncias pequenas.
  let cusum = 0;
  for (const item of recent) {
    const cpcDeviation = baselineCpc > 0 ? (item.cpc / baselineCpc) - 1.05 : 0;
    const cvrDeviation = baselineCvr > 0 ? 0.95 - (item.cvr / baselineCvr) : 0;
    cusum = Math.max(0, cusum + cpcDeviation + cvrDeviation);
  }

  const level: DeteriorationLevel =
    (cpcRatio >= 1.30 && cvrRatio <= 0.70) || cusum >= 1.0
      ? 'change'
      : cpcRatio >= 1.15 || cvrRatio <= 0.85 || cusum >= 0.45
        ? 'warning'
        : 'stable';

  return {
    level,
    cpc_ratio: round(cpcRatio, 3),
    cvr_ratio: round(cvrRatio, 3),
    cusum_score: round(cusum, 3),
    reason: level === 'change'
      ? 'persistent_cpc_inflation_and_or_cvr_drop'
      : level === 'warning'
        ? 'early_deterioration_signal'
        : 'stable_process',
  };
}

export function decideProbabilisticIntervention(input: {
  clicks?: number | null;
  matureClicks?: number | null;
  spend?: number | null;
  orders?: number | null;
  expectedClicksPerOrder?: number | null;
  maximumAcquisitionSpend?: number | null;
  posteriorProbabilityBelowSustainable?: number | null;
  currentCpc?: number | null;
  safeCpc?: number | null;
  priorReduction?: boolean;
  persistentLowRelevance?: boolean;
  attributionConfidence?: AttributionConfidence;
  ageDays?: number | null;
  isNewProduct?: boolean;
  deteriorationLevel?: DeteriorationLevel;
}) {
  const clicks = positive(input.clicks);
  const matureClicks = positive(input.matureClicks) || clicks;
  const spend = positive(input.spend);
  const orders = positive(input.orders);
  const expectedClicks = Math.max(1, positive(input.expectedClicksPerOrder) || 20);
  const maximumAcquisitionSpend = positive(input.maximumAcquisitionSpend);
  const probability = clamp(positive(input.posteriorProbabilityBelowSustainable), 0, 1);
  const currentCpc = positive(input.currentCpc);
  const safeCpc = positive(input.safeCpc);
  const ageDays = positive(input.ageDays);
  const clickMultiple = matureClicks / expectedClicks;
  const spendMultiple = maximumAcquisitionSpend > 0 ? spend / maximumAcquisitionSpend : 0;
  const cpcMultiple = safeCpc > 0 ? currentCpc / safeCpc : 0;
  const attributionConfidence = input.attributionConfidence || 'unknown';
  const deterioration = input.deteriorationLevel || 'stable';

  if (orders > 0) {
    return {
      state: 'wait_for_data' as InterventionState,
      recommended_reduction_pct: 0,
      click_multiple: round(clickMultiple, 2),
      spend_multiple: maximumAcquisitionSpend > 0 ? round(spendMultiple, 2) : null,
      cpc_multiple: safeCpc > 0 ? round(cpcMultiple, 2) : null,
      reason: 'has_conversions_use_profit_and_acos_rules',
    };
  }

  const immatureAttribution = attributionConfidence !== 'complete' && ageDays < 3;
  if (immatureAttribution && spendMultiple < 1.5 && clickMultiple < 1.5) {
    return {
      state: 'hold_for_attribution' as InterventionState,
      recommended_reduction_pct: 0,
      click_multiple: round(clickMultiple, 2),
      spend_multiple: maximumAcquisitionSpend > 0 ? round(spendMultiple, 2) : null,
      cpc_multiple: safeCpc > 0 ? round(cpcMultiple, 2) : null,
      reason: 'recent_clicks_or_partial_attribution',
    };
  }

  const softEvidence = probability >= 0.70
    || spendMultiple >= 0.60
    || clickMultiple >= 0.75
    || cpcMultiple >= 1.15
    || deterioration === 'warning';
  const strongEvidence = probability >= 0.85
    || spendMultiple >= 1
    || clickMultiple >= 1
    || cpcMultiple >= 1.35
    || deterioration === 'change';
  const pauseEvidence = input.priorReduction === true
    && input.isNewProduct !== true
    && ageDays >= 14
    && attributionConfidence === 'complete'
    && probability >= 0.95
    && spendMultiple >= 1.5
    && clickMultiple >= 1.5
    && (input.persistentLowRelevance === true || clickMultiple >= 2 || deterioration === 'change');

  const state: InterventionState = pauseEvidence
    ? 'pause_candidate'
    : strongEvidence
      ? 'reduce_strong'
      : softEvidence
        ? 'reduce_soft'
        : 'wait_for_data';

  return {
    state,
    recommended_reduction_pct: state === 'reduce_soft' ? 0.10 : state === 'reduce_strong' || state === 'pause_candidate' ? 0.20 : 0,
    click_multiple: round(clickMultiple, 2),
    spend_multiple: maximumAcquisitionSpend > 0 ? round(spendMultiple, 2) : null,
    cpc_multiple: safeCpc > 0 ? round(cpcMultiple, 2) : null,
    reason: state === 'pause_candidate'
      ? 'persistent_loss_after_prior_reduction'
      : state === 'reduce_strong'
        ? 'strong_probabilistic_or_financial_evidence'
        : state === 'reduce_soft'
          ? 'early_warning_before_confirmed_loss'
          : 'insufficient_evidence',
  };
}
