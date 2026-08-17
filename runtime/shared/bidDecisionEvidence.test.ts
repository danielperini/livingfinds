import {
  assessNoConversionEvidence,
  calculateExpectedClicksPerOrder,
  calculateMaximumEconomicCpc,
} from './bidDecisionEvidence.ts';

function assert(value: unknown, message = 'assertion failed'): asserts value {
  if (!value) throw new Error(message);
}

Deno.test('calcula CPC máximo econômico com fator de segurança', () => {
  assert(calculateMaximumEconomicCpc({
    averageSalePrice: 120,
    conversionRate: 0.10,
    targetAcosPercent: 25,
    safetyFactor: 0.8,
  }) === 2.4);
});

Deno.test('não inventa CPC econômico sem dados essenciais', () => {
  assert(calculateMaximumEconomicCpc({
    averageSalePrice: 120,
    conversionRate: 0,
    targetAcosPercent: 25,
  }) === null);
});

Deno.test('cliques esperados acompanham a conversão histórica', () => {
  assert(calculateExpectedClicksPerOrder(0.10) === 10);
  assert(calculateExpectedClicksPerOrder(0, 0.05) === 20);
});

Deno.test('pouca exposição econômica aguarda dados', () => {
  const evidence = assessNoConversionEvidence({
    clicks: 5,
    matureClicks: 5,
    spend: 8,
    conversionRate: 0.10,
    maximumAcquisitionSpend: 20,
    attributionConfidence: 'complete',
    ageDays: 7,
  });
  assert(evidence.level === 'wait_for_data');
});

Deno.test('alerta antecipado reduz suavemente antes do prejuízo integral', () => {
  const evidence = assessNoConversionEvidence({
    clicks: 8,
    matureClicks: 8,
    spend: 12,
    conversionRate: 0.10,
    maximumAcquisitionSpend: 20,
    attributionConfidence: 'complete',
    ageDays: 7,
  });
  assert(evidence.level === 'reduce_soft');
  assert(evidence.recommended_reduction_pct === 0.10);
});

Deno.test('um ciclo econômico completo sem venda reduz fortemente', () => {
  const evidence = assessNoConversionEvidence({
    clicks: 10,
    matureClicks: 10,
    spend: 20,
    conversionRate: 0.10,
    maximumAcquisitionSpend: 20,
    attributionConfidence: 'complete',
    ageDays: 7,
  });
  assert(evidence.level === 'reduce_strong');
  assert(evidence.recommended_reduction_pct === 0.20);
});

Deno.test('atribuição parcial recente é tratada como espera', () => {
  const evidence = assessNoConversionEvidence({
    clicks: 15,
    matureClicks: 7,
    spend: 15,
    conversionRate: 0.10,
    maximumAcquisitionSpend: 20,
    attributionConfidence: 'partial',
    ageDays: 1,
  });
  assert(evidence.level === 'wait_for_data');
  assert(evidence.internal_state === 'hold_for_attribution');
});

Deno.test('pausa exige redução anterior, maturidade e evidência probabilística forte', () => {
  const evidence = assessNoConversionEvidence({
    clicks: 40,
    matureClicks: 40,
    spend: 40,
    conversionRate: 0.10,
    maximumAcquisitionSpend: 20,
    persistentLowRelevance: true,
    priorReduction: true,
    attributionConfidence: 'complete',
    ageDays: 14,
    isNewProduct: false,
    deteriorationLevel: 'change',
  });
  assert(evidence.level === 'pause_candidate');
  assert((evidence.probability_below_sustainable || 0) >= 0.95);
});

Deno.test('sem redução anterior nunca pausa diretamente', () => {
  const evidence = assessNoConversionEvidence({
    clicks: 60,
    matureClicks: 60,
    spend: 60,
    conversionRate: 0.10,
    maximumAcquisitionSpend: 20,
    persistentLowRelevance: true,
    priorReduction: false,
    attributionConfidence: 'complete',
    ageDays: 30,
    deteriorationLevel: 'change',
  });
  assert(evidence.level === 'reduce_strong');
});
