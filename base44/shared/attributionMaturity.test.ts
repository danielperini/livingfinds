import {
  ATTRIBUTION_MATURITY_DAYS,
  classifyAttributionMaturity,
} from './attributionMaturity.ts';

function equal(actual: unknown, expected: unknown, label: string) {
  if (actual !== expected) throw new Error(`${label}: esperado=${expected} recebido=${actual}`);
}

Deno.test('dia corrente permanece provisional', () => {
  equal(classifyAttributionMaturity('2026-08-01', '2026-08-01'), 'provisional', 'maturidade');
});

Deno.test('janela de atribuição aberta não alimenta dayparting', () => {
  equal(classifyAttributionMaturity('2026-07-31', '2026-08-01'), 'attribution', 'maturidade');
  equal(classifyAttributionMaturity('2026-07-19', '2026-08-01'), 'attribution', 'maturidade');
});

Deno.test('janela de 14 dias encerrada é madura', () => {
  equal(ATTRIBUTION_MATURITY_DAYS, 14, 'janela');
  equal(classifyAttributionMaturity('2026-07-18', '2026-08-01'), 'mature', 'maturidade');
});
