import {
  classifyCurrentHour,
  classifyDelivery,
  structuralLoss,
} from './campaignDeliveryGovernor.ts';

function equal(actual: unknown, expected: unknown, label: string) {
  if (actual !== expected) throw new Error(`${label}: esperado=${expected} recebido=${actual}`);
}

Deno.test('não age quando economia não está validada', () => {
  const result = classifyDelivery({
    ageHours: 240,
    metricsFresh: true,
    impressions: 0,
    clicks: 0,
    orders: 0,
    sales: 0,
    spend: 0,
    isManualExact: true,
    isAuto: false,
    maximumProfitableSpend: 0,
    breakEvenAcos: null,
    targetAcos: 15,
  });
  equal(result.action, 'monitor', 'ação');
  equal(result.code, 'MOTOR_MONITORING_ECONOMICS_MISSING', 'código');
});

Deno.test('zero impressão permite apenas bootstrap controlado', () => {
  const result = classifyDelivery({
    ageHours: 15 * 24,
    metricsFresh: true,
    impressions: 0,
    clicks: 0,
    orders: 0,
    sales: 0,
    spend: 0,
    isManualExact: true,
    isAuto: false,
    maximumProfitableSpend: 20,
    breakEvenAcos: 25,
    targetAcos: 15,
  });
  equal(result.action, 'bootstrap_bid', 'ação');
  equal(result.code, 'ZERO_IMPRESSION_BID_BOOTSTRAP', 'código');
});

Deno.test('impressões sem clique substituem termo e nunca aumentam bid', () => {
  const result = classifyDelivery({
    ageHours: 15 * 24,
    metricsFresh: true,
    impressions: 150,
    clicks: 0,
    orders: 0,
    sales: 0,
    spend: 0,
    isManualExact: true,
    isAuto: false,
    maximumProfitableSpend: 20,
    breakEvenAcos: 25,
    targetAcos: 15,
  });
  equal(result.action, 'replace_term', 'ação');
  equal(result.code, 'IMPRESSIONS_NO_CLICK_REPLACE_TERM', 'código');
});

Deno.test('cliques sem venda só substituem após redução e evidência madura', () => {
  const result = classifyDelivery({
    ageHours: 20 * 24,
    metricsFresh: true,
    impressions: 300,
    clicks: 45,
    orders: 0,
    sales: 0,
    spend: 18,
    isManualExact: true,
    isAuto: false,
    maximumProfitableSpend: 10,
    breakEvenAcos: 25,
    targetAcos: 15,
    matureClicks: 45,
    conversionRate: 0.10,
    safeCpc: 0.30,
    currentCpc: 0.40,
    priorReduction: true,
    persistentLowRelevance: true,
    attributionConfidence: 'complete',
  });
  equal(result.action, 'replace_term', 'ação');
  equal(result.code, 'CLICKS_NO_SALE_REPLACE_TERM', 'código');
});

Deno.test('economia ausente não é interpretada como perda estrutural', () => {
  const result = structuralLoss(null, 0.2);
  equal(result.blocked, false, 'bloqueio');
});

Deno.test('margem negativa validada pausa todos os ads', () => {
  const result = structuralLoss({
    economics_status: 'complete',
    final_economic_confidence: 95,
    profit_before_ads: -2,
    break_even_acos: 0,
    safe_max_cpc: 0,
  }, 0.2);
  equal(result.blocked, true, 'bloqueio');
});

Deno.test('horário sem venda e acima do limite é pausado com atribuição completa', () => {
  const result = classifyCurrentHour({
    sampleDays: 14,
    clicks: 12,
    orders: 0,
    sales: 0,
    spend: 10,
    maximumProfitableSpend: 10,
    breakEvenAcos: 25,
    targetAcos: 15,
    attributionConfidence: 'complete',
  });
  equal(result.action, 'pause', 'ação');
});

Deno.test('horário rentável reativa apenas campanha pausada pelo governador', () => {
  const result = classifyCurrentHour({
    sampleDays: 14,
    clicks: 12,
    orders: 2,
    sales: 200,
    spend: 20,
    maximumProfitableSpend: 30,
    breakEvenAcos: 25,
    targetAcos: 15,
    attributionConfidence: 'complete',
  });
  equal(result.action, 'enable', 'ação');
});

Deno.test('dez cliques não são sentença fixa de pausa', () => {
  const result = classifyDelivery({
    ageHours: 20 * 24,
    metricsFresh: true,
    impressions: 500,
    clicks: 10,
    orders: 0,
    sales: 0,
    spend: 4,
    isManualExact: false,
    isAuto: true,
    maximumProfitableSpend: 20,
    breakEvenAcos: 25,
    targetAcos: 15,
    matureClicks: 10,
    conversionRate: 0.05,
    safeCpc: 0.50,
    currentCpc: 0.40,
    attributionConfidence: 'complete',
  });
  equal(result.action, 'monitor', 'ação');
});

Deno.test('atribuição aberta bloqueia decisão horária', () => {
  const result = classifyCurrentHour({
    sampleDays: 20,
    clicks: 30,
    orders: 0,
    sales: 0,
    spend: 20,
    maximumProfitableSpend: 10,
    breakEvenAcos: 25,
    targetAcos: 15,
    attributionConfidence: 'partial',
  });
  equal(result.action, 'hold', 'ação');
  equal(result.code, 'HOUR_ATTRIBUTION_OPEN', 'código');
});

Deno.test('janela mínima reativa com economia válida e respeita teto diário', () => {
  const enabledWindow = classifyCurrentHour({
    sampleDays: 0, clicks: 0, orders: 0, sales: 0, spend: 0,
    maximumProfitableSpend: 20, breakEvenAcos: 25, targetAcos: 15,
    attributionConfidence: 'partial', minimumPresenceHour: true,
    minimumPresenceDailySpend: 1, minimumPresenceDailyCap: 2.8,
  });
  equal(enabledWindow.action, 'enable', 'janela mínima');
  const capped = classifyCurrentHour({
    sampleDays: 0, clicks: 0, orders: 0, sales: 0, spend: 0,
    maximumProfitableSpend: 20, breakEvenAcos: 25, targetAcos: 15,
    attributionConfidence: 'partial', minimumPresenceHour: true,
    minimumPresenceDailySpend: 2.8, minimumPresenceDailyCap: 2.8,
  });
  equal(capped.action, 'pause', 'teto diário');
  equal(capped.code, 'MINIMUM_PRESENCE_CAP_REACHED', 'código do teto');
});
