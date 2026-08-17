import { assertEquals } from 'jsr:@std/assert';
import { canPromoteValidatingRule, evaluateAiRuleCandidate } from './aiRuleLifecyclePolicy.ts';

Deno.test('IA não cria regra de crescimento durante defesa', () => {
  assertEquals(evaluateAiRuleCandidate({ action: 'increase_bid_percent', confidence: .95, backtestPassed: true, holdoutPassed: true, centralMode: 'DEFEND', expectedProfitChangePct: 5, hasRollback: true }).eligible, false);
});
Deno.test('regra protetiva aprovada entra em validação, nunca ativa direto', () => {
  assertEquals(evaluateAiRuleCandidate({ action: 'decrease_bid_percent', confidence: .95, backtestPassed: true, holdoutPassed: true, centralMode: 'DEFEND', expectedProfitChangePct: 3, hasRollback: true }).nextStatus, 'validating');
});
Deno.test('promoção determinística exige sete dias, vinte amostras, lucro e ACoS não pior', () => {
  assertEquals(canPromoteValidatingRule({ ageDays: 7, shadowSamples: 20, shadowProfitDeltaPct: 2, shadowAcosDeltaPp: -1, centralMode: 'GROW', action: 'increase_bid_percent' }).status, 'active');
  assertEquals(canPromoteValidatingRule({ ageDays: 7, shadowSamples: 20, shadowProfitDeltaPct: -1, shadowAcosDeltaPp: -1, centralMode: 'GROW', action: 'increase_bid_percent' }).status, 'validating');
});
