import { calculateIntradayTargetBid, nextProfitableBid } from './intradayBidTargetPolicy.ts';

function equal(actual: unknown, expected: unknown, label: string) {
  if (actual !== expected) throw new Error(`${label}: esperado=${expected} recebido=${actual}`);
}

Deno.test('gasto acelerado vai direto ao bid alvo observado', () => {
  const result = calculateIntradayTargetBid({ currentBid: 1, observedCpc: 0.78, historicalCpc: 0.60, minBid: 0.20 });
  equal(result.targetBid, 0.60, 'bid alvo');
});

Deno.test('safe max CPC sempre limita o alvo', () => {
  const result = calculateIntradayTargetBid({ currentBid: 1, observedCpc: 0.90, historicalCpc: 0.70, safeMaxCpc: 0.45 });
  equal(result.targetBid, 0.45, 'teto econômico');
});

Deno.test('aumento lucrativo é gradual e nunca passa de dez por cento', () => {
  equal(nextProfitableBid(0.50, 0.70, 30), 0.55, 'aumento gradual');
});
