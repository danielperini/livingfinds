import { strict as assert } from 'node:assert';
import { resolveScheduledAdsDaypart, targetBidFromBaseline } from './scheduledAdsDaypartPolicy.ts';

const brt = (value: string) => new Date(`${value}-03:00`);

Deno.test('dia útil pausa todas entre 03h e 05h', () => {
  const policy = resolveScheduledAdsDaypart(brt('2026-08-05T03:30:00'));
  assert.equal(policy.window, 'PAUSE_ALL');
  assert.equal(policy.pauseAll, true);
  assert.equal(policy.bidMultiplier, 0.5);
});

Deno.test('dia útil retoma campanhas e bid-base às 05h', () => {
  const policy = resolveScheduledAdsDaypart(brt('2026-08-05T05:00:00'));
  assert.equal(policy.window, 'FULL');
  assert.equal(policy.restoreCampaigns, true);
  assert.equal(policy.bidMultiplier, 1);
});

Deno.test('dia útil reduz 60% e pausa automáticas das 15h às 17h', () => {
  const policy = resolveScheduledAdsDaypart(brt('2026-08-05T15:00:00'));
  assert.equal(policy.window, 'REDUCE_60_PAUSE_AUTO');
  assert.equal(policy.pauseAutomatic, true);
  assert.equal(policy.bidMultiplier, 0.4);
});

Deno.test('dia útil restaura 100% às 17h', () => {
  const policy = resolveScheduledAdsDaypart(brt('2026-08-05T17:00:00'));
  assert.equal(policy.window, 'FULL');
  assert.equal(policy.bidMultiplier, 1);
});

Deno.test('dia útil reduz para 50% às 23h59', () => {
  const policy = resolveScheduledAdsDaypart(brt('2026-08-05T23:59:00'));
  assert.equal(policy.window, 'HALF');
  assert.equal(policy.bidMultiplier, 0.5);
});

Deno.test('fim de semana não pausa campanhas nem aplica janela 15h-17h', () => {
  const policy = resolveScheduledAdsDaypart(brt('2026-08-08T15:30:00'));
  assert.equal(policy.window, 'FULL');
  assert.equal(policy.pauseAll, false);
  assert.equal(policy.pauseAutomatic, false);
  assert.equal(policy.bidMultiplier, 1);
});

Deno.test('feriado configurado segue regra de fim de semana', () => {
  const policy = resolveScheduledAdsDaypart(brt('2026-08-05T15:30:00'), new Set(['2026-08-05']));
  assert.equal(policy.isWeekendOrHoliday, true);
  assert.equal(policy.window, 'FULL');
  assert.equal(policy.pauseAutomatic, false);
});

Deno.test('restauração usa baseline exato e não inversão do bid reduzido', () => {
  assert.equal(targetBidFromBaseline(1, 0.4), 0.4);
  assert.equal(targetBidFromBaseline(1, 1), 1);
  assert.equal(targetBidFromBaseline(0.03, 0.5), 0.02);
});
