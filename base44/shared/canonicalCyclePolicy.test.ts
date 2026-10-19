import { assertEquals } from 'jsr:@std/assert@1';
import { campaignCoverageAsin, campaignCoverageProductEligible } from './campaignCoverageEligibility.ts';
import { collectUnconfirmedCycleStages, collectDetailedStageFailures, describeUnconfirmedCycleStage, isConfirmedCycleStage, resolveCanonicalCycleOutcome, isDecisionExecutionConfirmed, shouldRecoverDailyCycle, shouldRepairSkuCoverage } from './canonicalCyclePolicy.ts';

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

Deno.test('detalha a subetapa do motor e remove credenciais de mensagens de erro', () => {
  assertEquals(describeUnconfirmedCycleStage('unified_engine', {
    ok: false,
    failed_stages: [{ stage: 'deterministic', error: 'HTTP 400 Bearer abc123 access_token=secret' }],
  }), {
    stage: 'unified_engine',
    ok: false,
    error: '1 child stage(s) failed',
    details: [{ stage: 'deterministic', error: 'HTTP 400 Bearer [REDACTED] access_token=[REDACTED]' }],
  });
  assertEquals(describeUnconfirmedCycleStage('evidence', { ok: false, error: 'timeout' }).error, 'timeout');
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

Deno.test('auditoria reconhece identidade de campanha em campos diretos ou nome', () => {
  assertEquals(campaignCoverageAsin({ asin: 'b0dj3rghk6', name: 'AUTO | B0OTHER1234' }), 'B0DJ3RGHK6');
  assertEquals(campaignCoverageAsin({ campaign_name: 'AUTO | B0HLMF8PPD | 2026-10-07' }), 'B0HLMF8PPD');
  assertEquals(campaignCoverageAsin({ campaign_name: 'AUTO | nome sem ASIN' }), '');
});

Deno.test('auditoria de estoque ignora catálogo arquivado e duplicado, mas mantém ofertas ativas elegíveis', () => {
  const base = { asin: 'B0HLMF8PPD', sku: 'FBA-0122', fba_inventory: null, offer_active: true };
  assertEquals(campaignCoverageProductEligible({ ...base, status: 'archived' }), false);
  assertEquals(campaignCoverageProductEligible({ ...base, catalog_sync_status: 'duplicate' }), false);
  assertEquals(campaignCoverageProductEligible(base), true);
  assertEquals(campaignCoverageProductEligible({ ...base, offer_active: false }), false);
});

Deno.test('E2E só confirma execução sem falhas, itens pendentes ou divergências remotas', () => {
  assertEquals(isDecisionExecutionConfirmed({ ok: true, failed: 0, remaining: 0 }, { ok: true, divergences: 0 }), true);
  assertEquals(isDecisionExecutionConfirmed({ ok: true, failed: 1, remaining: 0 }, { ok: true, divergences: 0 }), false);
  assertEquals(isDecisionExecutionConfirmed({ ok: true, failed: 0, remaining: 2 }, { ok: true, divergences: 0 }), false);
  assertEquals(isDecisionExecutionConfirmed({ ok: true, failed: 0, remaining: 0 }, { ok: true, divergences: 1 }), false);
  assertEquals(isDecisionExecutionConfirmed({ ok: true, skipped: true }, { ok: true, skipped: true }), false);
});


Deno.test('falha da supervisão IA fica parcial e não bloqueia etapas centrais confirmadas', () => {
  assertEquals(resolveCanonicalCycleOutcome([], true, { ok: false, error: 'AI unavailable' }), {
    ok: true, core_ok: true, supervision_ok: false, partial: true,
  });
  assertEquals(resolveCanonicalCycleOutcome([], true, { ok: true }), {
    ok: true, core_ok: true, supervision_ok: true, partial: false,
  });
});

Deno.test('falha de etapa central continua bloqueando o ciclo, mesmo com supervisão confirmada', () => {
  assertEquals(resolveCanonicalCycleOutcome(['unified_engine'], true, { ok: true }), {
    ok: false, core_ok: false, supervision_ok: true, partial: false,
  });
  assertEquals(resolveCanonicalCycleOutcome([], false, null), {
    ok: true, core_ok: true, supervision_ok: true, partial: false,
  });
});

Deno.test("preserves nested lifecycle stage failures and redacts credentials", () => {
  const failures = collectDetailedStageFailures({ campaignLifecycle: {
    ok: false,
    results: [{ amazon_account_id: "account-7", stages: {
      kickoff: { ok: true },
      harvesting: { ok: false, error: "Amazon HTTP 429: Bearer abc123" },
      budget: { ok: false, error: "access_token=secret" },
    } }],
  } });
  assertEquals(failures, [
    { stage: "campaignLifecycle.harvesting", error: "Amazon HTTP 429: Bearer [REDACTED]", account_id: "account-7" },
    { stage: "campaignLifecycle.budget", error: "access_token=[REDACTED]", account_id: "account-7" },
  ]);
  assertEquals(describeUnconfirmedCycleStage("unified_engine", {
    ok: false, failed_stages: failures,
  }).details, failures.map(({ stage, error }) => ({ stage, error })));
});
