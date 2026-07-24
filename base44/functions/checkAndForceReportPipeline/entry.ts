/**
 * checkAndForceReportPipeline — Watchdog diário robusto
 *
 * Roda 2x ao dia (07h e 14h BRT via automação).
 * Lógica:
 *  1. Se há job "processed" nas últimas 26h → OK, pular
 *  2. Se há jobs "pending/processing" NUNCA polled (poll_attempts=0) → forçar poll imediatamente
 *  3. Se não há nenhum job recente → disparar runDailyFullReportPipeline com até 3 tentativas
 *  4. Após disparar pipeline, aguardar 5min e forçar poll para não deixar jobs orfãos
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

const WINDOW_HOURS = 26;
const MAX_RETRIES = 3;
const RETRY_WAIT_MS = 4 * 60 * 1000; // 4 minutos

async function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

Deno.serve(async (req) => {
  const t0 = Date.now();
  const startAt = new Date().toISOString();

  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    if (!body._service_role && !body.force) {
      const user = await base44.auth.me().catch(() => null);
      if (!user) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 403 });
    }

    const db = base44.asServiceRole;

    const accounts = await db.entities.AmazonAccount.filter({ status: 'connected' }, '-updated_date', 1).catch(() => [] as any[]);
    const account = accounts[0];
    if (!account) return Response.json({ ok: false, error: 'Nenhuma conta conectada' });
    const aid = account.id;

    const cutoffIso = new Date(Date.now() - WINDOW_HOURS * 3600000).toISOString();

    const recentJobs = await db.entities.AmazonAdsReportJob.filter(
      { amazon_account_id: aid }, '-created_date', 50
    ).catch(() => [] as any[]);

    // 1. Verificar se já há relatório processado recente
    const hasProcessedRecent = recentJobs.some((j: any) => {
      const createdAt = j.created_date || j.created_at || j.requested_at || '';
      return ['processed', 'completed', 'downloaded'].includes(j.status) && createdAt >= cutoffIso;
    });

    if (hasProcessedRecent) {
      await db.entities.SyncExecutionLog.create({
        amazon_account_id: aid,
        operation: 'watchdog_report_pipeline',
        trigger_type: 'automatic',
        status: 'skipped',
        started_at: startAt,
        completed_at: new Date().toISOString(),
        duration_ms: Date.now() - t0,
        result_summary: 'Skipped: relatório já processado nas últimas 26h',
      }).catch(() => {});
      return Response.json({ ok: true, action: 'skipped', reason: 'already_processed', duration_ms: Date.now() - t0 });
    }

    // 2. Verificar se há jobs pendentes nunca polled → forçar poll imediatamente
    const stuckJobs = recentJobs.filter((j: any) => {
      const createdAt = j.created_date || j.created_at || j.requested_at || '';
      return ['pending', 'processing', 'requested'].includes(j.status)
        && createdAt >= cutoffIso
        && (j.poll_attempts || 0) === 0;
    });

    if (stuckJobs.length > 0) {
      console.log(`[watchdog] ${stuckJobs.length} jobs nunca polled — forçando poll`);
      // Zerar next_poll_at para que sejam elegíveis imediatamente
      const nowIso = new Date().toISOString();
      await Promise.all(stuckJobs.map((j: any) =>
        db.entities.AmazonAdsReportJob.update(j.id, {
          next_poll_at: nowIso,
          poll_in_progress: false,
          updated_at: nowIso,
        }).catch(() => {})
      ));
      const pollRes = await db.functions.invoke('pollAmazonAdsReportJobs', {
        max_jobs: 20, _service_role: true,
      }).catch((e: any) => ({ data: { ok: false, error: e?.message } }));

      await db.entities.SyncExecutionLog.create({
        amazon_account_id: aid,
        operation: 'watchdog_report_pipeline',
        trigger_type: 'automatic',
        status: 'success',
        started_at: startAt,
        completed_at: new Date().toISOString(),
        duration_ms: Date.now() - t0,
        result_summary: `Forçado poll de ${stuckJobs.length} jobs orfãos`,
      }).catch(() => {});

      return Response.json({
        ok: true, action: 'forced_poll',
        stuck_jobs: stuckJobs.length,
        poll_result: pollRes?.data,
        duration_ms: Date.now() - t0,
      });
    }

    // 3. Sem jobs recentes → disparar pipeline com retry
    console.log('[watchdog] Nenhum job recente — disparando pipeline com retry');
    let pipelineOk = false;
    let lastError = '';
    let pipelineData: any = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const res = await db.functions.invoke('runDailyFullReportPipeline', {
          amazon_account_id: aid,
          force: true,
          _service_role: true,
        });
        pipelineData = res?.data || res || {};
        if (pipelineData?.ok !== false && !pipelineData?.error) {
          pipelineOk = true;
          console.log(`[watchdog] Pipeline disparada com sucesso tentativa ${attempt + 1}`);
          break;
        }
        lastError = pipelineData?.error || 'Resposta inválida';
        console.warn(`[watchdog] Pipeline tentativa ${attempt + 1} falhou: ${lastError}`);
      } catch (e: any) {
        lastError = e.message;
        console.warn(`[watchdog] Pipeline tentativa ${attempt + 1} erro: ${e.message}`);
      }
      if (attempt < MAX_RETRIES - 1) {
        console.log(`[watchdog] Aguardando ${RETRY_WAIT_MS / 60000}min antes de re-tentar...`);
        await sleep(RETRY_WAIT_MS);
      }
    }

    // 4. Aguardar 5min e forçar poll para não deixar jobs orfãos
    if (pipelineOk) {
      console.log('[watchdog] Aguardando 5min para forçar poll dos novos jobs...');
      await sleep(5 * 60 * 1000);
      await db.functions.invoke('pollAmazonAdsReportJobs', {
        max_jobs: 20, _service_role: true,
      }).catch(() => {});
    }

    await db.entities.SyncExecutionLog.create({
      amazon_account_id: aid,
      operation: 'watchdog_report_pipeline',
      trigger_type: 'automatic',
      status: pipelineOk ? 'success' : 'error',
      started_at: startAt,
      completed_at: new Date().toISOString(),
      duration_ms: Date.now() - t0,
      result_summary: pipelineOk
        ? `Pipeline disparada OK após ${MAX_RETRIES} tentativa(s)`
        : `Falhou após ${MAX_RETRIES} tentativas: ${lastError}`,
    }).catch(() => {});

    return Response.json({
      ok: pipelineOk,
      action: 'pipeline_triggered',
      pipeline_ok: pipelineOk,
      error: pipelineOk ? undefined : lastError,
      duration_ms: Date.now() - t0,
    });

  } catch (err: any) {
    return Response.json({ ok: false, error: err?.message, duration_ms: Date.now() - t0 }, { status: 500 });
  }
});