import {
  decideProbabilisticIntervention,
  estimateBayesianConversion,
  type AttributionConfidence,
  type DeteriorationLevel,
} from './decisionStatistics.ts';

export type NoConversionEvidenceLevel =
  | 'wait_for_data'
  | 'reduce_soft'
  | 'reduce_strong'
  | 'pause_candidate';

type NoConversionEvidenceInput = {
  clicks: number;
  matureClicks?: number | null;
  spend: number;
  conversionRate?: number | null;
  fallbackConversionRate?: number | null;
  maximumAcquisitionSpend?: number | null;
  persistentLowRelevance?: boolean;
  priorReduction?: boolean;
  attributionConfidence?: AttributionConfidence;
  ageDays?: number | null;
  isNewProduct?: boolean;
  currentCpc?: number | null;
  safeCpc?: number | null;
  deteriorationLevel?: DeteriorationLevel;
  priorStrength?: number | null;
};

const positive = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

const round = (value: number, decimals = 2): number => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

/**
 * CPC econômico = preço médio × CVR × ACoS-alvo.
 * O fator de segurança mantém o teto abaixo do break-even quando configurado.
 */
export function calculateMaximumEconomicCpc(input: {
  averageSalePrice?: number | null;
  conversionRate?: number | null;
  targetAcosPercent?: number | null;
  safetyFactor?: number | null;
}): number | null {
  const price = positive(input.averageSalePrice);
  const cvr = positive(input.conversionRate);
  const targetAcos = positive(input.targetAcosPercent);
  const safetyFactor = positive(input.safetyFactor) || 1;
  if (price <= 0 || cvr <= 0 || targetAcos <= 0) return null;
  return round(price * cvr * (targetAcos / 100) * Math.min(1, safetyFactor), 2);
}

export function calculateExpectedClicksPerOrder(
  conversionRate?: number | null,
  fallbackConversionRate = 0.05,
): number {
  const fallback = positive(fallbackConversionRate) || 0.05;
  const cvr = Math.min(1, positive(conversionRate) || fallback);
  return Math.min(200, Math.max(5, Math.ceil(1 / cvr)));
}

/**
 * Classifica desperdício por probabilidade, maturidade e limite econômico.
 *
 * Compatibilidade: `level` conserva o contrato usado pelo motor v8. Cliques
 * ainda imaturos são devolvidos como `wait_for_data`, impedindo que o motor
 * antigo interprete uma espera de atribuição como autorização para reduzir.
 */
export function assessNoConversionEvidence(input: NoConversionEvidenceInput) {
  const clicks = positive(input.clicks);
  const matureClicks = positive(input.matureClicks) || clicks;
  const spend = positive(input.spend);
  const priorCvr = Math.min(
    1,
    positive(input.conversionRate)
      || positive(input.fallbackConversionRate)
      || 0.05,
  );
  const expectedClicks = calculateExpectedClicksPerOrder(priorCvr, priorCvr);
  const acquisitionLimit = positive(input.maximumAcquisitionSpend);
  const currentCpc = positive(input.currentCpc) || (clicks > 0 ? spend / clicks : 0);

  const posterior = estimateBayesianConversion({
    clicks: matureClicks,
    orders: 0,
    priorMean: priorCvr,
    priorStrength: positive(input.priorStrength) || 20,
    sustainableRate: Math.max(0.0025, priorCvr * 0.80),
  });

  const intervention = decideProbabilisticIntervention({
    clicks,
    matureClicks,
    spend,
    orders: 0,
    expectedClicksPerOrder: expectedClicks,
    maximumAcquisitionSpend: acquisitionLimit,
    posteriorProbabilityBelowSustainable: posterior.probability_below_sustainable,
    currentCpc,
    safeCpc: input.safeCpc,
    priorReduction: input.priorReduction,
    persistentLowRelevance: input.persistentLowRelevance,
    attributionConfidence: input.attributionConfidence,
    ageDays: input.ageDays,
    isNewProduct: input.isNewProduct,
    deteriorationLevel: input.deteriorationLevel,
  });

  const level: NoConversionEvidenceLevel = intervention.state === 'hold_for_attribution'
    ? 'wait_for_data'
    : intervention.state;

  return {
    level,
    internal_state: intervention.state,
    expected_clicks_per_order: expectedClicks,
    click_multiple: intervention.click_multiple,
    mature_clicks: round(matureClicks, 2),
    raw_clicks: round(clicks, 2),
    maximum_acquisition_spend: acquisitionLimit > 0 ? round(acquisitionLimit, 2) : null,
    spend_multiple: intervention.spend_multiple,
    financial_evidence: acquisitionLimit > 0 && spend >= acquisitionLimit,
    recommended_reduction_pct: intervention.recommended_reduction_pct,
    posterior_cvr: posterior.posterior_mean,
    posterior_cvr_low_95: posterior.credible_low_95,
    posterior_cvr_high_95: posterior.credible_high_95,
    probability_below_sustainable: posterior.probability_below_sustainable,
    attribution_confidence: input.attributionConfidence || 'unknown',
    deterioration_level: input.deteriorationLevel || 'stable',
    reason: intervention.reason,
  };
}
