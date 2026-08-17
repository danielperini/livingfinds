/**
 * runCommandAuditPipeline — Auditoria Central de Comandos Amazon
 *
 * Pipeline horário que garante que NENHUM comando do motor fique para trás:
 *
 *   1. executeApprovedDecisionQueue  — executa decisões aprovadas pendentes (bids, pausa, budget)
 *   2. reconcileAndRetryDecisions    — verifica se cada comando chegou na Amazon; retry se não
 *   3. auditCampaignStateSync        — compara estado local vs Amazon; corrige divergências
 *   4. calibrateBidsNoImpressions    — calibra bids de keywords novas sem dados (evita bid 0.50 travado)
 *   5. fixProductCampaignLinks       — reconecta produtos às campanhas certas
 *   6. syncAdsCampaignStatesV2       — sincroniza estados de campanhas (incompleta → ativa etc)
 *
 * Cada etapa é executada em sequência com fire-and-forget nos logs.
 * Resposta retorna sumário de cada etapa para diagnóstico.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const STEP_TIMEOUT_MS = 40000; // 40s por etapa — reconcile pode ser mais lento
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function runStep(base44: any, name: string, fn: string, payload: any): Promise<{ name: string; ok: boolean; summary: any; duration_ms: number }> {
  const t0 = Date.now();
  try {
    const res = await Promise.race([
      base44.asServiceRole.functions.invoke(fn, payload),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), STEP_TIMEOUT_MS)),
    ]);
    const data = (res as any)?.data || res || {};
    return {
      name,
      ok: data?.ok !== false,
      summary: {
        executed: data?.executed,
        divergences: data?.divergences,
        corrections: data?.corrections,
        verified: data?.summary?.verified,
        retry_success: data?.summary?.retry_success,
        retry_failed: data?.summary?.retry_failed,
        updated: data?.updated,
        repairs: data?.repairs_needed,
        calibrated: data?.calibrated,
        remote_total: data?.remote_total,
      },
      duration_ms: Date.now() - t0,
    };
  } catch (e: any) {
    return { name, ok: false, summary: { error: e.message }, duration_ms: Date.now() - t0 };
  }
}

Deno.serve(async (req) => {
  const t0 = Date.now();
  const now = new Date().toISOString();

  try {
    const base44 = createClientFromRequest(req);
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    const body = await req.json().catch(() => ({}));
    if (!authenticated && !body._service_role) {
      return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    // Resolver conta
    let account: any = null;
    if (body.amazon_account_id) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1);
      account = accs[0] || null;
    }
    if (!account) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, null, 1);
      account = accs[0] || null;
    }
    if (!account) return Response.json({ ok: false, error: 'Nenhuma conta conectada' });

    const aid = account.id;
    const basePayload = { amazon_account_id: aid, _service_role: true };

    // Pipeline sequencial — cada etapa depende da anterior para consistência
    const steps: any[] = [];

    // Etapa 1: Executar decisões aprovadas (bids, pausas, budgets pendentes)
    const step1 = await runStep(base44, 'execute_approved_decisions', 'executeApprovedDecisionQueue', basePayload);
    steps.push(step1);
    await sleep(1500);

    // Etapa 2: Verificar e retry de decisões que não chegaram na Amazon
    const step2 = await runStep(base44, 'reconcile_retry_decisions', 'reconcileAndRetryDecisions', basePayload);
    steps.push(step2);
    await sleep(1500);

    // Etapa 3: Auditar divergências de estado (ENABLED/PAUSED) e budget entre banco e Amazon
    const step3 = await runStep(base44, 'audit_campaign_state_sync', 'auditCampaignStateSync', basePayload);
    steps.push(step3);
    await sleep(1000);

    // Etapa 4: Calibrar bids de keywords novas sem impressões (evita ficar travado em 0.50)
    const step4 = await runStep(base44, 'calibrate_bids_no_impressions', 'calibrateBidsNoImpressions', basePayload);
    steps.push(step4);
    await sleep(1000);

    // Etapa 5: Reconectar produtos às campanhas (links product↔campaign)
    const step5 = await runStep(base44, 'fix_product_campaign_links', 'fixProductCampaignLinks', basePayload);
    steps.push(step5);
    await sleep(1000);

    // Etapa 6: Sincronizar estados de campanhas (incompleta → ativa quando Amazon confirmar)
    const step6 = await runStep(base44, 'sync_campaign_states', 'syncAdsCampaignStatesV2', basePayload);
    steps.push(step6);

    const failed_steps = steps.filter(s => !s.ok).map(s => s.name);
    const total_duration = Date.now() - t0;

    // Log consolidado
    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: aid,
      operation: 'command_audit_pipeline',
      trigger_type: body._service_role ? 'automatic' : 'manual',
      status: failed_steps.length === 0 ? 'success' : failed_steps.length < 3 ? 'warning' : 'error',
      execution_date: now.slice(0, 10),
      started_at: new Date(t0).toISOString(),
      completed_at: new Date().toISOString(),
      duration_ms: total_duration,
      records_processed: steps.length,
      result_summary: `etapas=${steps.length} falhas=${failed_steps.length} duracao=${Math.round(total_duration / 1000)}s`,
      error_message: failed_steps.length > 0 ? `Etapas com falha: ${failed_steps.join(', ')}` : null,
    }).catch(() => {});

    return Response.json({
      ok: failed_steps.length === 0,
      pipeline: 'command_audit_pipeline_v1',
      duration_ms: total_duration,
      steps_ok: steps.filter(s => s.ok).length,
      steps_failed: failed_steps.length,
      failed_steps,
      steps,
      note: 'Pipeline horário: execute→reconcile→audit→calibrate→links→states. Garante que nenhum comando fique para trás.',
    });

  } catch (error: any) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});