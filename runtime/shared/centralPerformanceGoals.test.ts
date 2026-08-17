import { assertEquals } from 'jsr:@std/assert';
import { evaluateCentralGoals } from './centralPerformanceGoals.ts';

Deno.test('cenário informado entra em defesa apesar de ROAS e TACoS aparentarem bons', () => {
  const result = evaluateCentralGoals({ targetAcos: 10, maximumAcos: 15, targetRoas: 5, targetTacos: 5, maximumCpc: 0.7, dailyBudget: 115, acos: 17.9, roas: 5.59, tacos: 4.7, cpc: 0.68, spend: 61.6, profitPositive: true, dataComplete: true });
  assertEquals(result.mode, 'DEFEND');
  assertEquals(result.effective.targetRoas, 10);
  assertEquals(result.permissions.topOfSearch, false);
  assertEquals(result.permissions.createCampaign, false);
  assertEquals(result.permissions.minimumSafePresence, true);
});

Deno.test('crescimento exige todas as metas econômicas simultaneamente', () => {
  assertEquals(evaluateCentralGoals({ targetAcos: 10, maximumAcos: 15, targetRoas: 5, targetTacos: 5, maximumCpc: 0.7, dailyBudget: 115, acos: 9, roas: 11.11, tacos: 4, cpc: 0.6, spend: 70, profitPositive: true, dataComplete: true }).mode, 'GROW');
});

Deno.test('prejuízo ou dados incompletos bloqueiam tudo exceto repricing de margem', () => {
  const result = evaluateCentralGoals({ targetAcos: 10, maximumAcos: 15, targetRoas: 10, targetTacos: 5, maximumCpc: 0.7, dailyBudget: 115, acos: 8, roas: 12, tacos: 4, cpc: 0.5, spend: 10, profitPositive: false, dataComplete: true });
  assertEquals(result.mode, 'BLOCKED');
  assertEquals(result.permissions.minimumSafePresence, false);
  assertEquals(result.permissions.repriceForMargin, true);
});
