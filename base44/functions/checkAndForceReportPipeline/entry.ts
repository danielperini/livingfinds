/**
 * checkAndForceReportPipeline — Watchdog diário robusto
 *
 * Roda 2x ao dia (07h e 14h BRT via automação).
 * Lógica corrigida:
 *  1. Saudável = job com status processed/completed E processed_at nas últimas 26h (não apenas criado)
 *  2. Jobs travados = pending/processing com poll_attempts=0 criados há >30min OU start_date=hoje (BRT)
 *     → zerar next_poll_at e forçar poll imediatamente
 *  3. Nenhum job do dia atual (BRT) → disparar runDailyFullReportPipeline com force:true
 *  4. Após pipeline, aguardar 5min, forçar poll, e disparar SP-API + motor
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

    // Data atual em BRT (UTC-3)
    const todayBRT = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);

    // ── 1. Verificar se há relatório EFETIVAMENTE processado nas últimas 26h ──
    // Critério correto: processed_at dentro da janela (não apenas created_date).
    // Jobs "pending" criados recentemente NÃO contam como saudáveis.
    const hasProcessedRecent = recentJobs.some((j: any) => {
      const processedAt = j.processed_at || '';
      return ['processed', 'completed'].includes(j.status) && processedAt >= cutoffIso;
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
        result_summary: 'Skipped: relatório já processado (processed_at) nas últimas 26h',
      }).catch(() => {});
      return Response.json({ ok: true, action: 'skipped', reason: 'already_processed', duration_ms: Date.now() - t0 });
    }

    // ── 2. Detectar jobs orphaned/travados (poll_attempts=0) ──
    // Caso A: criados há mais de 30min sem nenhum poll
    const cutoffStuckIso = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const stuckByAge = recentJobs.filter((j: any) => {
      const createdAt = j.created_date || j.created_at || j.requested_at || '';
      return ['pending', 'processing', 'requested'].includes(j.status)
        && (j.poll_attempts || 0) === 0
        && createdAt <= cutoffStuckIso;
    });

    // Caso B: jobs do dia atual (start_date=hoje BRT) com poll_attempts=0
    const stuckByDate = recentJobs.filter((j: any) => {
      const startDate = j.start_date || j.end_date || '';
      return ['pending', 'processing', 'requested'].includes(j.status)
        && (j.poll_attempts || 0) === 0
        && startDate === todayBRT;
    });

    // Combinar sem duplicatas
    const allStuckJobs: any[] = [...new Map(
      [...stuckByAge, ...stuckByDate].map((j: any) => [j.id, j])
    ).values()];

    if (allStuckJobs.length > 0) {
      console.log(`[watchdog] ${allStuckJobs.length} jobs travados (poll_attempts=0) — forçando poll`);
      // Zerar next_poll_at e poll_in_progress para torná-los elegíveis imediatamente
      const nowIso = new Date().toISOString();
      await Promise.all(allStuckJobs.map((j: any) =>
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
        result_summary: `Forçado poll de ${allStuckJobs.length} jobs travados (poll_attempts=0)`,
      }).catch(() => {});

      return Response.json({
        ok: true,
        action: 'forced_poll',
        stuck_jobs: allStuckJobs.length,
        poll_result: (pollRes as any)?.data,
        duration_ms: Date.now() - t0,
      });
    }

    // ── 3. Nenhum job do dia atual → disparar pipeline do zero ──
    const todayJobsAny = recentJobs.filter((j: any) => {
      const startDate = j.start_date || j.end_date || '';
      return startDate === todayBRT;
    });

    if (todayJobsAny.length === 0) {
      console.log('[watchdog] Nenhum job do dia atual (BRT) — disparando pipeline com retry');
    } else {
      // Há jobs do dia mas nenhum processado e nenhum travado detectado acima — situação inesperada, logar e tentar poll
      console.log(`[watchdog] ${todayJobsAny.length} jobs do dia existem mas nenhum processado — forçando poll genérico`);
      const nowIso = new Date().toISOString();
      await Promise.all(todayJobsAny.map((j: any) =>
        db.entities.AmazonAdsReportJob.update(j.id, {
          next_poll_at: nowIso,
          poll_in_progress: false,
          updated_at: nowIso,
        }).catch(() => {})
      ));
      await db.functions.invoke('pollAmazonAdsReportJobs', { max_jobs: 20, _service_role: true }).catch(() => {});

      await db.entities.SyncExecutionLog.create({
        amazon_account_id: aid,
        operation: 'watchdog_report_pipeline',
        trigger_type: 'automatic',
        status: 'warning',
        started_at: startAt,
        completed_at: new Date().toISOString(),
        duration_ms: Date.now() - t0,
        result_summary: `Jobs do dia existem mas sem processed_at — forçado poll genérico de ${todayJobsAny.length} jobs`,
      }).catch(() => {});

      return Response.json({
        ok: true,
        action: 'forced_poll_fallback',
        today_jobs: todayJobsAny.length,
        duration_ms: Date.now() - t0,
      });
    }

    // ── 4. Pipeline do zero com retry ──
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
        pipelineData = (res as any)?.data || res || {};
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

    // ── 5. Pós-pipeline: poll + SP-API + motor ──
    if (pipelineOk) {
      console.log('[watchdog] Aguardando 5min para forçar poll dos novos jobs...');
      await sleep(5 * 60 * 1000);
      await db.functions.invoke('pollAmazonAdsReportJobs', {
        max_jobs: 20, _service_role: true,
      }).catch(() => {});

      console.log('[watchdog] Disparando sincronização SP-API (catálogo, estoque, vendas)...');
      await Promise.allSettled([
        db.functions.invoke('syncProductCatalogV2', { amazon_account_id: aid, _service_role: true }).catch(() => {}),
        db.functions.invoke('syncProductsFromInventory', { amazon_account_id: aid, _service_role: true }).catch(() => {}),
        db.functions.invoke('syncSalesDailyFromReports', { amazon_account_id: aid, _service_role: true }).catch(() => {}),
      ]);

      console.log('[watchdog] Disparando motor determinístico de decisão...');
      await db.functions.invoke('runDeterministicDecisionEngine', {
        amazon_account_id: aid, auto_approve: true, skip_approval: true, _service_role: true,
      }).catch(() => {});
      await db.functions.invoke('executeApprovedDecisionQueue', {
        amazon_account_id: aid, auto_execute: true, requires_approval: false, _service_role: true,
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
        ? 'Pipeline completa: ADS + SP-API + motor decisão disparados'
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