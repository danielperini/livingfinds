import { assertEquals } from 'jsr:@std/assert@1';
import { collectUnconfirmedCycleStages, isConfirmedCycleStage, isDecisionExecutionConfirmed, shouldRecoverDailyCycle, shouldRepairSkuCoverage } from './canonicalCyclePolicy.ts';

Deno.test('etapa do motor só é sucesso com confirmação explícita', () => {
  assertEquals(isConfirmedCycleStage({ ok: true }), true);
  assertEquals(isConfirmedCycleStage({ ok: true, skipped: true }), true);
  assertEquals(isConfirmedCycleStage({}), false);
  assertEquals(isConfirmedCycleStage(undefined), false);
  assertEquals(isConfirmedCycleStage({ ok: false }), false);
});

Deno.test('ciclo exige confirmação de cada etapa obrigatória', () => {
  const stages = { evidence: { ok: true }, engine: { ok: true }, arbitration: { ok: false } };
  assertEquals(collectUnconfirmedCycleStages(stages, ['evidence', 'engine', 'arbitration', 'executor']), ['arbitration', 'executor']);
});

Deno.test('reparo de cobertura só roda com ASINs faltantes e tentativas disponíveis', () => {
  assertEquals(shouldRepairSkuCoverage(['B000000001'], 0), true);
  assertEquals(shouldRepairSkuCoverage([], 0), false);
  assertEquals(shouldRepairSkuCoverage(['B000000001'], 3), false);
});

Deno.test('recuperação diária evita repetição concorrente e respeita janela de retry', () => {
  assertEquals(shouldRecoverDailyCycle({ due: false, confirmedSuccess: false, latestAttemptAgeMinutes: 120, attemptsToday: 0 }), false);
  assertEquals(shouldRecoverDailyCycle({ due: true, confirmedSuccess: true, latestAttemptAgeMinutes: 120, attemptsToday: 0 }), false);
  assertEquals(shouldRecoverDailyCycle({ due: true, confirmedSuccess: false, latestAttemptAgeMinutes: 5, attemptsToday: 0 }), false);
  assertEquals(shouldRecoverDailyCycle({ due: true, confirmedSuccess: false, latestAttemptAgeMinutes: 25, attemptsToday: 3 }), false);
  assertEquals(shouldRecoverDailyCycle({ due: true, confirmedSuccess: false, latestAttemptAgeMinutes: 25, attemptsToday: 1 }), true);
});

Deno.test('E2E só confirma execução sem falhas, itens pendentes ou divergências remotas', () => {
  assertEquals(isDecisionExecutionConfirmed({ ok: true, failed: 0, remaining: 0 }, { ok: true, divergences: 0 }), true);
  assertEquals(isDecisionExecutionConfirmed({ ok: true, failed: 1, remaining: 0 }, { ok: true, divergences: 0 }), false);
  assertEquals(isDecisionExecutionConfirmed({ ok: true, failed: 0, remaining: 2 }, { ok: true, divergences: 0 }), false);
  assertEquals(isDecisionExecutionConfirmed({ ok: true, failed: 0, remaining: 0 }, { ok: true, divergences: 1 }), false);
  assertEquals(isDecisionExecutionConfirmed({ ok: true, skipped: true }, { ok: true, skipped: true }), false);
});
