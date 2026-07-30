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

Deno.test('menos de uma venda esperada aguarda dados', () => {
  const evidence = assessNoConversionEvidence({
    clicks: 9,
    spend: 30,
    conversionRate: 0.10,
    maximumAcquisitionSpend: 20,
  });
  assert(evidence.level === 'wait_for_data');
});

Deno.test('uma a duas vendas esperadas reduz suavemente', () => {
  const evidence = assessNoConversionEvidence({
    clicks: 15,
    spend: 25,
    conversionRate: 0.10,
    maximumAcquisitionSpend: 20,
  });
  assert(evidence.level === 'reduce_soft');
  assert(evidence.recommended_reduction_pct === 0.12);
});

Deno.test('duas vendas esperadas com gasto relevante reduz fortemente', () => {
  const evidence = assessNoConversionEvidence({
    clicks: 40,
    spend: 25,
    conversionRate: 0.05,
    maximumAcquisitionSpend: 20,
  });
  assert(evidence.level === 'reduce_strong');
  assert(evidence.click_multiple === 2);
});

Deno.test('pausa é apenas candidata com baixa relevância persistente e gasto dobrado', () => {
  const evidence = assessNoConversionEvidence({
    clicks: 40,
    spend: 40,
    conversionRate: 0.05,
    maximumAcquisitionSpend: 20,
    persistentLowRelevance: true,
  });
  assert(evidence.level === 'pause_candidate');
});
