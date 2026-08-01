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
    ageHours: 8 * 24,
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
    ageHours: 8 * 24,
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

Deno.test('cliques sem venda substituem termo ao atingir limite econômico', () => {
  const result = classifyDelivery({
    ageHours: 8 * 24,
    metricsFresh: true,
    impressions: 300,
    clicks: 7,
    orders: 0,
    sales: 0,
    spend: 12,
    isManualExact: true,
    isAuto: false,
    maximumProfitableSpend: 10,
    breakEvenAcos: 25,
    targetAcos: 15,
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

Deno.test('horário sem venda e acima do limite é pausado', () => {
  const result = classifyCurrentHour({
    sampleDays: 10,
    clicks: 12,
    orders: 0,
    sales: 0,
    spend: 8,
    maximumProfitableSpend: 10,
    breakEvenAcos: 25,
    targetAcos: 15,
  });
  equal(result.action, 'pause', 'ação');
});

Deno.test('horário rentável reativa apenas campanha pausada pelo governador', () => {
  const result = classifyCurrentHour({
    sampleDays: 10,
    clicks: 12,
    orders: 2,
    sales: 200,
    spend: 20,
    maximumProfitableSpend: 30,
    breakEvenAcos: 25,
    targetAcos: 15,
  });
  equal(result.action, 'enable', 'ação');
});
