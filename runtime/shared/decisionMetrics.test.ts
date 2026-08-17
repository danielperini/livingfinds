import {
  calculateInventoryCoverage,
  calculateObservedWindowDays,
  calculateRealTacos,
} from './decisionMetrics.ts';

function assert(value: unknown, message = 'assertion failed'): asserts value {
  if (!value) throw new Error(message);
}

Deno.test('TACoS usa faturamento real e retorna percentual', () => {
  assert(calculateRealTacos(15, 100) === 15);
});

Deno.test('TACoS não inventa denominador quando SP-API está ausente', () => {
  assert(calculateRealTacos(15, 0) === null);
});

Deno.test('janela observada usa o intervalo real e limita a 30 dias', () => {
  assert(calculateObservedWindowDays(['2026-07-01', '2026-07-10']) === 10);
  assert(calculateObservedWindowDays(['2026-06-01', '2026-07-29']) === 30);
});

Deno.test('Days of Supply usa velocidade observada e estoque disponível', () => {
  const result = calculateInventoryCoverage({
    fbaInventory: 14,
    unitsSold: 30,
    observedDays: 30,
  });
  assert(result.days_of_supply === 14);
  assert(result.status === 'low');
  assert(result.actionable);
});

Deno.test('inbound é projetado mas não mascara estoque crítico atual', () => {
  const result = calculateInventoryCoverage({
    fbaInventory: 3,
    inboundInventory: 30,
    unitsSold: 30,
    observedDays: 30,
  });
  assert(result.days_of_supply === 3);
  assert(result.days_of_supply_with_inbound === 33);
  assert(result.status === 'critical');
});

Deno.test('histórico curto não autoriza redução automática por cobertura', () => {
  const result = calculateInventoryCoverage({
    availableQuantity: 4,
    unitsSold: 10,
    observedDays: 3,
  });
  assert(result.status === 'insufficient_history');
  assert(!result.actionable);
});

Deno.test('estoque zero continua sendo bloqueio mesmo sem histórico', () => {
  const result = calculateInventoryCoverage({
    fbaInventory: 0,
    unitsSold: 0,
    observedDays: 0,
  });
  assert(result.status === 'out_of_stock');
  assert(result.days_of_supply === 0);
  assert(result.actionable);
});
