/**
 * checkAndForceReportPipeline — Watchdog da pipeline de relatórios Amazon Ads
 *
 * Verifica se existe algum AmazonAdsReportJob recente (< 26h).
 * Se NÃO existir: dispara runDailyFullReportPipeline com force=true.
 * Se JÁ existir: registra 'skipped' e sai.
 * Registra resultado em SyncExecutionLog com operation='watchdog_report_pipeline'.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

const WINDOW_HOURS = 26;

Deno.serve(async (req) => {
  const t0      = Date.now();
  const startAt = new Date().toISOString();

  try {
    const base44 = createClientFromRequest(req);
    const body   = await req.json().catch(() => ({}));

    if (!body._service_role) {
      const user = await base44.auth.me().catch(() => null);
      if (!user) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 403 });
    }

    const db = base44.asServiceRole;

    // Resolver conta
    const accounts = await db.entities.AmazonAccount.filter({ status: 'connected' }, '-updated_date', 1).catch(() => [] as any[]);
    const account  = accounts[0];
    if (!account) return Response.json({ ok: false, error: 'Nenhuma conta conectada' });
    const aid = account.id;

    // Verificar se existe job recente (< 26h)
    const cutoffMs  = Date.now() - WINDOW_HOURS * 3600 * 1000;
    const cutoffIso = new Date(cutoffMs).toISOString();

    const recentJobs = await db.entities.AmazonAdsReportJob.filter(
      { amazon_account_id: aid }, '-created_date', 30
    ).catch(() => [] as any[]);

    const hasRecentJob = recentJobs.some((j: any) => {
      const validStatus = ['pending', 'processing', 'completed', 'processed'].includes(j.status);
      const createdAt   = j.created_date || j.created_at || j.requested_at || '';
      return validStatus && createdAt >= cutoffIso;
    });

    if (hasRecentJob) {
      const latest = recentJobs[0];
      await db.entities.SyncExecutionLog.create({
        amazon_account_id: aid,
        operation: 'watchdog_report_pipeline',
        trigger_type: 'automatic',
        status: 'skipped',
        started_at: startAt,
        completed_at: new Date().toISOString(),
        duration_ms: Date.now() - t0,
        result_summary: `Skipped: job recente encontrado (${latest?.status} em ${(latest?.created_date || '').slice(0, 16)})`,
      }).catch(() => {});

      return Response.json({
        ok: true,
        action: 'skipped',
        reason: 'recent_job_found',
        latest_job_status: latest?.status,
        latest_job_date: latest?.created_date,
        duration_ms: Date.now() - t0,
      });
    }

    // Nenhum job recente → disparar pipeline
    const pipelineRes = await db.functions.invoke('runDailyFullReportPipeline', {
      amazon_account_id: aid,
      force: true,
      _service_role: true,
    }).catch((e: any) => ({ data: { ok: false, error: e?.message } }));

    const pipelineData = pipelineRes?.data || pipelineRes || {};
    const pipelineOk   = pipelineData?.ok !== false && !pipelineData?.error;

    await db.entities.SyncExecutionLog.create({
      amazon_account_id: aid,
      operation: 'watchdog_report_pipeline',
      trigger_type: 'automatic',
      status: pipelineOk ? 'success' : 'error',
      started_at: startAt,
      completed_at: new Date().toISOString(),
      duration_ms: Date.now() - t0,
      result_summary: pipelineOk
        ? `Pipeline disparada: ${JSON.stringify(pipelineData).slice(0, 200)}`
        : `Erro ao disparar pipeline: ${pipelineData?.error || 'desconhecido'}`,
    }).catch(() => {});

    return Response.json({
      ok: true,
      action: 'pipeline_triggered',
      pipeline_ok: pipelineOk,
      pipeline_response: pipelineData,
      duration_ms: Date.now() - t0,
    });

  } catch (err: any) {
    return Response.json({ ok: false, error: err?.message, duration_ms: Date.now() - t0 }, { status: 500 });
  }
});