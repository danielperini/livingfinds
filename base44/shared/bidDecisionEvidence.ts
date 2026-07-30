export type NoConversionEvidenceLevel =
  | 'wait_for_data'
  | 'reduce_soft'
  | 'reduce_strong'
  | 'pause_candidate';

type NoConversionEvidenceInput = {
  clicks: number;
  spend: number;
  conversionRate?: number | null;
  fallbackConversionRate?: number | null;
  maximumAcquisitionSpend?: number | null;
  persistentLowRelevance?: boolean;
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
  return Math.min(100, Math.max(5, Math.ceil(1 / cvr)));
}

/**
 * Classifica a força da evidência de desperdício sem usar um corte universal.
 * A pausa continua sendo apenas candidata: maturidade, atribuição, estoque,
 * relevância e proteção de vencedores permanecem sob responsabilidade do motor.
 */
export function assessNoConversionEvidence(input: NoConversionEvidenceInput) {
  const clicks = positive(input.clicks);
  const spend = positive(input.spend);
  const expectedClicks = calculateExpectedClicksPerOrder(
    input.conversionRate,
    positive(input.fallbackConversionRate) || 0.05,
  );
  const clickMultiple = clicks / expectedClicks;
  const acquisitionLimit = positive(input.maximumAcquisitionSpend);
  const spendMultiple = acquisitionLimit > 0 ? spend / acquisitionLimit : 0;
  const financialEvidence = acquisitionLimit > 0 && spend >= acquisitionLimit;

  let level: NoConversionEvidenceLevel = 'wait_for_data';
  let recommendedReductionPct = 0;

  if (clickMultiple >= 2 && financialEvidence) {
    level = input.persistentLowRelevance && spendMultiple >= 2
      ? 'pause_candidate'
      : 'reduce_strong';
    recommendedReductionPct = 0.25;
  } else if (clickMultiple >= 1 && financialEvidence) {
    level = 'reduce_soft';
    recommendedReductionPct = 0.12;
  }

  return {
    level,
    expected_clicks_per_order: expectedClicks,
    click_multiple: round(clickMultiple, 2),
    maximum_acquisition_spend: acquisitionLimit > 0 ? round(acquisitionLimit, 2) : null,
    spend_multiple: acquisitionLimit > 0 ? round(spendMultiple, 2) : null,
    financial_evidence: financialEvidence,
    recommended_reduction_pct: recommendedReductionPct,
  };
}
