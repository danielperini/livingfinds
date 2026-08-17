/**
 * runDailyPipelineConsolidated
 *
 * Pipeline diário único consolidado — substitui todos os syncs redundantes.
 *
 * Ordem de execução:
 *  1. Token LWA (via lwaTokenManager)
 *  2. Sync estados de campanhas (syncAdsCampaignStatesV2)
 *  3. Repair de campanhas INCOMPLETE + filas de reparo AUTO/Keyword
 *  4. Fix de vínculos produto→campanha
 *  5. Solicitar relatórios Ads 30d (scheduledAdsReportSync)
 *  6. AI Engine full (bids, budget, harvest, mine, calibrate)
 *  7. Aplicar decisões aprovadas com confiança ≥ 90%
 *  8. Sync final de estados para confirmar aplicações
 *
 * Não duplica nenhuma lógica — delega para as funções especializadas.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function step(base44: any, name: string, payload: any): Promise<{ step: string; ok: boolean; duration_ms: number; summary?: any; error?: string }> {
  const t = Date.now();
  try {
    const res = await base44.asServiceRole.functions.invoke(name, { ...payload, _service_role: true });
    const d = res?.data || res || {};
    return { step: name, ok: d?.ok !== false && !d?.error, duration_ms: Date.now() - t, summary: d };
  } catch (e: any) {
    return { step: name, ok: false, duration_ms: Date.now() - t, error: e?.message || String(e) };
  }
}

Deno.serve(async (req) => {
  const startedAt = new Date().toISOString();
  const startMs = Date.now();

  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    // Aceitar chamadas diretas (scheduler) ou internas (_service_role)
    const isScheduled = !body._service_role;

    const accounts = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id })
      : await base44.asServiceRole.entities.AmazonAccount.list('-created_date', 10);

    if (!accounts.length) {
      return Response.json({ ok: false, error: 'Nenhuma conta Amazon conectada', started_at: startedAt }, { status: 409 });
    }

    const allResults: any[] = [];

    for (const account of accounts) {
      const aid = account.id;
      const basePayload = { amazon_account_id: aid };
      const steps: any[] = [];

      // ── 1. Validar token LWA (via getLWAAccessToken) ───────────────────
      const tokenStep = await step(base44, 'getLWAAccessToken', { service: 'ads' });
      steps.push({ ...tokenStep, step: 'lwa_token_validate' });
      // Token inválido é avisado mas não bloqueia — as chamadas individuais irão falhar com mensagem clara

      // ── 2. Sync estados de campanhas (rápido) ──────────────────────────
      steps.push(await step(base44, 'syncAdsCampaignStatesV2', basePayload));
      await wait(2000);

      // ── 3a. Reparar campanhas INCOMPLETE na Amazon ─────────────────────
      steps.push(await step(base44, 'repairIncompleteAutoCampaigns', { ...basePayload, asins: null }));
      await wait(3000);

      // ── 3b. Processar fila de reparo AUTO ─────────────────────────────
      steps.push(await step(base44, 'processAutoCampaignRepairQueueV2', basePayload));
      await wait(2000);

      // ── 3c. Processar fila de reparo Keywords EXACT ────────────────────
      steps.push(await step(base44, 'processKeywordRepairQueue', basePayload));
      await wait(2000);

      // ── 4. Corrigir vínculos produto → campanha ────────────────────────
      steps.push(await step(base44, 'fixProductCampaignLinksV2', basePayload));
      await wait(1000);

      // ── 5. Download de relatórios Ads (já solicitados às 06:00 BRT) ────
      // O request foi feito separadamente às 06:00 BRT; aqui apenas baixamos.
      // Se não houver reportIds no payload, tentamos solicitar + baixar inline.
      if (body.report_ids) {
        steps.push(await step(base44, 'scheduledAdsReportSync', { ...basePayload, action: 'download', reportIds: body.report_ids, syncRunId: body.sync_run_id }));
      } else {
        // Fallback: solicitar + aguardar + baixar numa só passagem (para execução manual)
        steps.push(await step(base44, 'scheduledAdsReportSync', { ...basePayload, action: 'request' }));
      }
      await wait(1000);

      // ── 6. AI Engine — análise e geração de decisões de bid/budget ─────
      // Apenas gera decisões (analysis_only); execução é feita no step 7
      steps.push(await step(base44, 'runDailyAdsOptimization', {
        ...basePayload,
        trigger: 'daily_pipeline',
        analysis_only: true,
        execute_actions: false,
      }));
      await wait(2000);

      // ── 6b. Calibrar bids sem impressão ───────────────────────────────
      steps.push(await step(base44, 'calibrateBidsNoImpressions', basePayload));
      await wait(1000);

      // ── 6c. Smart bid 50% CPC ─────────────────────────────────────────
      steps.push(await step(base44, 'smartBidFromCpc', basePayload));
      await wait(1000);

      // ── 6d. Harvest search terms convertidos → keywords manuais ───────
      steps.push(await step(base44, 'harvestConvertedSearchTerms', basePayload));
      await wait(1000);

      // ── 7. Executar decisões aprovadas com confiança ≥ 90% ─────────────
      // Busca decisões aprovadas não executadas
      const pendingDecisions = await base44.asServiceRole.entities.OptimizationDecision.filter({
        amazon_account_id: aid,
        status: 'approved',
      }, 'created_at', 20).catch(() => []);

      const highConfidence = pendingDecisions.filter((d: any) =>
        (d.confidence || 0) >= 90 && d.action !== 'pause_campaign'
      );

      let decisionsExecuted = 0;
      let decisionsFailed = 0;
      for (const decision of highConfidence) {
        try {
          const res = await base44.asServiceRole.functions.invoke('executeAutopilotDecision', {
            decision_id: decision.id,
            _service_role: true,
          });
          const d = res?.data || res || {};
          const ok = Number(d?.executed || 0) > 0 || d?.results?.some((r: any) => r.ok);
          ok ? decisionsExecuted++ : decisionsFailed++;
        } catch { decisionsFailed++; }
        await wait(8000); // respeitar rate limits Amazon
      }
      steps.push({
        step: 'execute_approved_decisions',
        ok: decisionsFailed === 0,
        duration_ms: 0,
        summary: { total: highConfidence.length, executed: decisionsExecuted, failed: decisionsFailed },
      });

      // ── 8. Sync final para confirmar estados aplicados ─────────────────
      steps.push(await step(base44, 'syncAdsCampaignStatesV2', { ...basePayload, _trigger: 'post_execution' }));

      // ── Registrar log de execução ──────────────────────────────────────
      const completedAt = new Date().toISOString();
      const requiredSteps = steps.filter((s: any) => !['lwa_token_validate'].includes(s.step));
      const ok = requiredSteps.filter((s: any) => !s.ok).length <= 2; // tolera até 2 steps opcionais falhando

      await base44.asServiceRole.entities.SyncExecutionLog.create({
        amazon_account_id: aid,
        operation: 'daily_pipeline_consolidated',
        status: ok ? 'success' : 'error',
        trigger_type: isScheduled ? 'automatic' : 'manual',
        started_at: startedAt,
        completed_at: completedAt,
        records_processed: steps.filter((s: any) => s.ok).length,
        result_summary: JSON.stringify({
          steps_ok: steps.filter((s: any) => s.ok).length,
          steps_failed: steps.filter((s: any) => !s.ok).length,
          decisions_executed: decisionsExecuted,
          duration_ms: Date.now() - startMs,
        }),
        error_message: ok ? null : steps
          .filter((s: any) => !s.ok)
          .map((s: any) => `${s.step}: ${s.error || 'falhou'}`)
          .join(' | ')
          .slice(0, 800),
      }).catch(() => {});

      await base44.asServiceRole.entities.AmazonAccount.update(aid, {
        last_sync_at: completedAt,
      }).catch(() => {});

      allResults.push({ amazon_account_id: aid, ok, steps, decisions_executed: decisionsExecuted });
    }

    return Response.json({
      ok: allResults.every((r: any) => r.ok),
      pipeline: 'daily_consolidated',
      accounts_processed: allResults.length,
      duration_ms: Date.now() - startMs,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      results: allResults,
    });
  } catch (error: any) {
    return Response.json({
      ok: false,
      error: error?.message || 'Erro no pipeline diário consolidado',
      started_at: startedAt,
      duration_ms: Date.now() - startMs,
    }, { status: 500 });
  }
});