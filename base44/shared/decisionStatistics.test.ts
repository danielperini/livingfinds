import {
  calculateProfitWindow,
  decideProbabilisticIntervention,
  detectSequentialDeterioration,
  estimateBayesianConversion,
  estimateMatureClicks,
  maturityWeightForAgeHours,
} from './decisionStatistics.ts';

function assert(value: unknown, message = 'assertion failed'): asserts value {
  if (!value) throw new Error(message);
}

Deno.test('lucro sem pedidos contabiliza o gasto como prejuízo', () => {
  const result = calculateProfitWindow({
    contributionMarginPerOrder: 21.23,
    spend: 33.46,
    orders: 0,
  });
  assert(result.profit_after_ads_total === -33.46);
  assert(result.profit_after_ads_per_order === -33.46);
  assert(result.is_profitable === false);
});

Deno.test('lucro total usa contribuição multiplicada pelos pedidos', () => {
  const result = calculateProfitWindow({
    contributionMarginPerOrder: 21.23,
    spend: 30,
    orders: 2,
  });
  assert(result.total_contribution === 42.46);
  assert(result.profit_after_ads_total === 12.46);
  assert(result.profit_after_ads_per_order === 6.23);
});

Deno.test('posterior bayesiano regulariza amostra pequena', () => {
  const result = estimateBayesianConversion({
    clicks: 2,
    orders: 1,
    priorMean: 0.05,
    priorStrength: 20,
    sustainableRate: 0.04,
  });
  assert(result.posterior_mean < 0.20);
  assert(result.posterior_mean > 0.05);
});

Deno.test('ausência persistente de vendas aumenta probabilidade de CVR inviável', () => {
  const short = estimateBayesianConversion({
    clicks: 5,
    orders: 0,
    priorMean: 0.05,
    priorStrength: 20,
    sustainableRate: 0.04,
  });
  const long = estimateBayesianConversion({
    clicks: 60,
    orders: 0,
    priorMean: 0.05,
    priorStrength: 20,
    sustainableRate: 0.04,
  });
  assert((long.probability_below_sustainable || 0) > (short.probability_below_sustainable || 0));
});

Deno.test('maturidade de clique cresce com a idade', () => {
  assert(maturityWeightForAgeHours(4) < maturityWeightForAgeHours(24));
  assert(maturityWeightForAgeHours(24) < maturityWeightForAgeHours(80));
});

Deno.test('cliques recentes não contam como fracassos completos', () => {
  const now = new Date('2026-07-30T12:00:00Z');
  const result = estimateMatureClicks([
    { date: '2026-07-30', clicks: 10 },
    { date: '2026-07-26', clicks: 10 },
  ], now);
  assert(result.raw_clicks === 20);
  assert(result.mature_clicks < 20);
  assert(result.mature_clicks > 10);
});

Deno.test('CUSUM simplificado detecta inflação de CPC e queda de CVR', () => {
  const rows = [
    { date: '2026-07-20', clicks: 20, orders: 2, spend: 10 },
    { date: '2026-07-21', clicks: 20, orders: 2, spend: 10 },
    { date: '2026-07-22', clicks: 20, orders: 2, spend: 10 },
    { date: '2026-07-23', clicks: 20, orders: 2, spend: 10 },
    { date: '2026-07-24', clicks: 20, orders: 2, spend: 10 },
    { date: '2026-07-25', clicks: 20, orders: 0, spend: 18 },
    { date: '2026-07-26', clicks: 20, orders: 0, spend: 19 },
    { date: '2026-07-27', clicks: 20, orders: 0, spend: 20 },
  ];
  const result = detectSequentialDeterioration(rows);
  assert(result.level === 'change');
});

Deno.test('motor reduz antes do prejuízo integral com evidência antecipada', () => {
  const result = decideProbabilisticIntervention({
    clicks: 15,
    matureClicks: 15,
    spend: 13,
    orders: 0,
    expectedClicksPerOrder: 20,
    maximumAcquisitionSpend: 21.23,
    posteriorProbabilityBelowSustainable: 0.74,
    currentCpc: 0.87,
    safeCpc: 0.65,
    attributionConfidence: 'complete',
    ageDays: 7,
  });
  assert(result.state === 'reduce_soft');
});

Deno.test('pausa exige intervenção anterior e persistência', () => {
  const result = decideProbabilisticIntervention({
    clicks: 60,
    matureClicks: 60,
    spend: 45,
    orders: 0,
    expectedClicksPerOrder: 25,
    maximumAcquisitionSpend: 21.23,
    posteriorProbabilityBelowSustainable: 0.99,
    currentCpc: 0.75,
    safeCpc: 0.65,
    priorReduction: true,
    persistentLowRelevance: true,
    attributionConfidence: 'complete',
    ageDays: 16,
    isNewProduct: false,
    deteriorationLevel: 'change',
  });
  assert(result.state === 'pause_candidate');
});
