import { classifySkuEconomicState, classifyUnifiedEconomicStatus } from './economicDecisionState.ts';

function assert(value: unknown, message = 'assertion failed'): asserts value {
  if (!value) throw new Error(message);
}

Deno.test('prejuízo material classifica SKU como LOSS_CONFIRMED', () => {
  const result = classifySkuEconomicState({
    realRevenue: 1700,
    contributionBeforeAds: 424.57,
    adSpend: 635.46,
    targetAcosPercent: 15,
    breakEvenAcosPercent: 24.97,
  });
  assert(result.state === 'LOSS_CONFIRMED');
  assert(result.pause_all_campaigns === false);
});

Deno.test('ACoS acima da meta mas abaixo do equilíbrio fica VIGILANT', () => {
  const result = classifySkuEconomicState({
    realRevenue: 1358.70,
    contributionBeforeAds: 331.31,
    adSpend: 277.16,
    targetAcosPercent: 15,
    breakEvenAcosPercent: 24.38,
  });
  assert(result.state === 'VIGILANT');
});

Deno.test('produto não comprável é o único estado que pausa todo o SKU', () => {
  const result = classifySkuEconomicState({ buyable: false, adSpend: 0 });
  assert(result.state === 'NOT_BUYABLE');
  assert(result.pause_all_campaigns === true);
});

const verifiedEconomics = {
  costs_confirmed_by_user: true,
  unit_cost: 50,
  current_price: 120,
  price_source: 'sp_api_listings_items',
  fba_fee: 10,
  amazon_fixed_fee: 0,
  amazon_fee_percent: 15,
  fees_source: 'sp_api_product_fees',
  fees_verified_at: '2026-08-01T10:00:00Z',
  estimated_ads_cost_per_order: 8,
  ads_cost_source: 'daily_product_ads_assessment_30d',
  ads_cost_verified_at: '2026-08-01T10:00:00Z',
  economic_data_complete: true,
  economics_status: 'complete',
  current_margin_pct: 20,
  minimum_margin_pct: 15,
  contribution_margin_amount: 32,
  profit_protection_mode: 'normal',
};

Deno.test('Ads bloqueia crescimento sem custo, preço, tarifas ou histórico confiável', () => {
  const now = new Date('2026-08-01T12:00:00Z').getTime();
  for (const economics of [
    { ...verifiedEconomics, unit_cost: 0 },
    { ...verifiedEconomics, current_price: 0 },
    { ...verifiedEconomics, fees_verified_at: null },
    { ...verifiedEconomics, ads_cost_verified_at: null },
  ]) {
    const result = classifyUnifiedEconomicStatus(economics, now);
    assert(result.block_expansion === true);
    assert(result.allow_conservative_growth === false);
  }
});

Deno.test('Ads bloqueia crescimento quando margem líquida fica abaixo de 15%', () => {
  const result = classifyUnifiedEconomicStatus(
    { ...verifiedEconomics, current_margin_pct: 14.99 },
    new Date('2026-08-01T12:00:00Z').getTime(),
  );
  assert(result.status === 'negative_margin');
  assert(result.block_expansion === true);
});

Deno.test('Ads só libera economia completa e recente', () => {
  const result = classifyUnifiedEconomicStatus(
    verifiedEconomics,
    new Date('2026-08-01T12:00:00Z').getTime(),
  );
  assert(result.status === 'complete');
  assert(result.block_expansion === false);
  assert(result.economic_confidence === 'complete');
});
