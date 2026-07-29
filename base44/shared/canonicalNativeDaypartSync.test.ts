import { resolveNativeScheduleAdjustment } from './canonicalNativeDaypartSync.ts';

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

Deno.test('regra PICO nasce limitada ao aumento máximo configurado', () => {
  const result = resolveNativeScheduleAdjustment({
    classification: 'PICO',
    baseBid: 0.60,
    bandRoas: 12,
    targetRoas: 5,
    maxBid: 2,
    absMinBid: 0.02,
    strictEnvelope: true,
    maxIncreasePct: 10,
    maxDecreasePct: 25,
  });

  assert(result.requestedPct === 50, `ajuste solicitado esperado 50%, recebido ${result.requestedPct}%`);
  assert(result.adjustmentPct === 10, `regra deveria nascer em +10%, recebido ${result.adjustmentPct}%`);
  assert(result.targetBid === 0.66, `bid-alvo esperado R$0,66, recebido R$${result.targetBid}`);
  assert(result.cappedBy.includes('max_bid_increase_pct'), 'deveria registrar limite configurado');
});

Deno.test('regra PICO respeita max_bid mesmo com limite percentual maior', () => {
  const result = resolveNativeScheduleAdjustment({
    classification: 'PICO',
    baseBid: 1.95,
    bandRoas: 12,
    targetRoas: 5,
    maxBid: 2,
    absMinBid: 0.02,
    strictEnvelope: true,
    maxIncreasePct: 20,
    maxDecreasePct: 25,
  });

  assert(result.adjustmentPct === 3, `ajuste esperado próximo de +3%, recebido ${result.adjustmentPct}%`);
  assert(result.targetBid === 2, `bid-alvo deveria respeitar R$2, recebido R$${result.targetBid}`);
  assert(result.cappedBy.includes('max_bid'), 'deveria registrar max_bid como limitador');
});

Deno.test('regra PISO nasce limitada à redução máxima configurada', () => {
  const result = resolveNativeScheduleAdjustment({
    classification: 'PISO',
    baseBid: 0.80,
    bandRoas: 0,
    targetRoas: 5,
    maxBid: 2,
    absMinBid: 0.02,
    strictEnvelope: true,
    maxIncreasePct: 10,
    maxDecreasePct: 25,
  });

  assert(result.requestedPct === -75, `redução técnica esperada -75%, recebida ${result.requestedPct}%`);
  assert(result.adjustmentPct === -25, `regra deveria nascer em -25%, recebida ${result.adjustmentPct}%`);
  assert(result.targetBid === 0.60, `bid-alvo esperado R$0,60, recebido R$${result.targetBid}`);
  assert(result.cappedBy.includes('max_bid_decrease_pct'), 'deveria registrar limite de redução');
});

Deno.test('aumento zero desativa criação de regra nativa positiva', () => {
  const result = resolveNativeScheduleAdjustment({
    classification: 'PICO',
    baseBid: 0.60,
    bandRoas: 12,
    targetRoas: 5,
    maxBid: 2,
    absMinBid: 0.02,
    strictEnvelope: true,
    maxIncreasePct: 0,
    maxDecreasePct: 25,
  });

  assert(result.adjustmentPct === 0, `ajuste deveria ser zero, recebido ${result.adjustmentPct}%`);
  assert(result.targetBid === 0.60, `bid deveria permanecer R$0,60, recebido R$${result.targetBid}`);
});
