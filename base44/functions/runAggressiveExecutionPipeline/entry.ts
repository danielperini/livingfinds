/**
 * runAggressiveExecutionPipeline — Pipeline de execução agressiva a cada hora
 *
 * Executa em sequência:
 *   1. runUnifiedDecisionEngine    → gera decisões de bids baseadas nas metas
 *   2. runDailyDayparting          → gera regras de dayparting por hora
 *   3. executeApprovedDecisionQueue → executa TODAS as decisões aprovadas imediatamente
 *   4. runHourlyAdsGuardrails      → proteções: estoque zero, locks travados, etc.
 *   5. runScheduledBidAdjustments  → aplica bids de dayparting do slot horário atual
 *
 * Roda a cada hora para garantir que bids e dayparting estejam sempre atualizados.
 * Sem janelas de cooldown — age imediatamente sempre que há decisões pendentes.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function invoke(base44: any, fn: string, payload: object = {}) {
  try {
    const res = await base44.asServiceRole.functions.invoke(fn, { _service_role: true, ...payload });
    return { fn, ok: res?.data?.ok !== false, data: res?.data };
  } catch (e: any) {
    return { fn, ok: false, error: e?.message };
  }
}

Deno.serve(async (req) => {
  const t0 = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    if (!authenticated && !body._service_role) {
      return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    // Resolver conta
    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter(
      { status: 'connected' }, null, 1
    );
    const account = accounts[0];
    if (!account) return Response.json({ ok: false, error: 'Nenhuma conta conectada' });

    const aid = account.id;
    const basePayload = { amazon_account_id: aid };
    const log: any[] = [];

    console.log(`[runAggressiveExecutionPipeline] Iniciando para conta ${aid}`);

    // ── PASSO 1: Gerar decisões de bids via motor estratégico ────────────
    log.push(await invoke(base44, 'runUnifiedDecisionEngine', basePayload));
    await sleep(2000);

    // ── PASSO 2: Gerar/atualizar regras de dayparting ────────────────────
    log.push(await invoke(base44, 'runDailyDayparting', basePayload));
    await sleep(2000);

    // ── PASSO 3: Executar TODAS as decisões aprovadas imediatamente ──────
    // Loop: continua executando enquanto houver decisões pendentes (max 3 rounds)
    let totalExecuted = 0;
    for (let round = 0; round < 3; round++) {
      const execResult = await invoke(base44, 'executeApprovedDecisionQueue', basePayload);
      log.push({ ...execResult, fn: `executeApprovedDecisionQueue_round_${round + 1}` });
      totalExecuted += execResult.data?.executed || 0;
      const remaining = execResult.data?.remaining || 0;
      if (remaining === 0 || !execResult.ok) break;
      await sleep(3000);
    }

    // ── PASSO 4: Guardrails horários (estoque, locks, alertas) ───────────
    log.push(await invoke(base44, 'runHourlyAdsGuardrails', basePayload));
    await sleep(1000);

    // ── PASSO 5: Aplicar bids de dayparting para hora atual ──────────────
    log.push(await invoke(base44, 'runScheduledBidAdjustments', basePayload));

    const errors = log.filter(l => !l.ok);
    const completed_at = new Date().toISOString();

    // Gravar log de execução
    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: aid,
      operation: 'aggressive_execution_pipeline',
      trigger_type: 'automatic',
      status: errors.length === 0 ? 'success' : totalExecuted > 0 ? 'warning' : 'error',
      execution_date: new Date().toISOString().slice(0, 10),
      started_at: new Date(t0).toISOString(),
      completed_at,
      duration_ms: Date.now() - t0,
      records_processed: totalExecuted,
      result_summary: `${totalExecuted} bids/ações executados. Etapas: ${log.length}. Erros: ${errors.length}.`,
    }).catch(() => {});

    return Response.json({
      ok: errors.length === 0,
      pipeline: 'aggressive_execution',
      account_id: aid,
      total_executed: totalExecuted,
      steps: log.length,
      errors: errors.map(e => ({ fn: e.fn, error: e.error || e.data?.error })),
      duration_ms: Date.now() - t0,
      log,
    });

  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message }, { status: 500 });
  }
});