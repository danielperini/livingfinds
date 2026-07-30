import { classifySkuEconomicState } from './economicDecisionState.ts';

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
