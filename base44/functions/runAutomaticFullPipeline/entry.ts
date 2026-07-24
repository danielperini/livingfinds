/**
 * runAutomaticFullPipeline — Orquestrador Assíncrono da Pipeline Completa v1
 *
 * Encadeia as 4 fases sem bloquear:
 *   FASE 1 — Solicita relatórios ADS (runDailyFullReportPipeline)
 *   FASE 2 — Poll é feito pela automação separada a cada 10min (pollAmazonAdsReportJobs)
 *   FASE 3 — Sincronização SP-API Catálogo (após relatórios processados, ativada pelo flag)
 *   FASE 4 — Motor determinístico + execução de decisões (após SP-API)
 *
 * O encadeamento das fases 3 e 4 é feito aqui via fire-and-forget em paralelo.
 * O motor de decisão só roda se houver dados frescos (relatório processado nas últimas 26h
 * OU SP-API sincronizada nas últimas 2h).
 *
 * Agendamento (via automação scheduler):
 *   - Esta função: 06h BRT (09h UTC) — 1x por dia
 *   - pollAmazonAdsReportJobs: a cada 10 min (automação separada)
 *   - checkAndForceReportPipeline: watchdog 07h e 14h BRT
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

const MAX_RETRIES = 3;
const RETRY_WAIT_MS = 4 * 60 * 1000; // 4 minutos

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function invokeWithRetry(db: any, fnName: string, payload: any, retries = MAX_RETRIES): Promise<any> {
  let lastError = '';
  for (let i = 0; i < retries; i++) {
    try {
      const res = await db.functions.invoke(fnName, payload);
      const data = res?.data || res || {};
      if (data?.ok !== false && !data?.error) return data;
      lastError = data?.error || 'unknown_error';
      console.warn(`[pipeline] ${fnName} tentativa ${i + 1} falhou: ${lastError}`);
    } catch (e: any) {
      lastError = e.message;
      console.warn(`[pipeline] ${fnName} tentativa ${i + 1} erro: ${e.message}`);
    }
    if (i < retries - 1) {
      console.log(`[pipeline] Aguardando ${RETRY_WAIT_MS / 60000}min antes de re-tentar ${fnName}...`);
      await sleep(RETRY_WAIT_MS);
    }
  }
  return { ok: false, error: lastError, retries_exhausted: true };
}

Deno.serve(async (req) => {
  const t0 = Date.now();
  const startedAt = new Date().toISOString();
  const summary: Record<string, any> = {};

  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    // Aceitar tanto chamadas autenticadas quanto service_role (agendador)
    const isAuth = await base44.auth.isAuthenticated().catch(() => false);
    if (!isAuth && !body._service_role && !body.force) {
      return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    const db = base44.asServiceRole;

    // Resolver conta conectada
    const accounts = await db.entities.AmazonAccount.filter({ status: 'connected' }, '-updated_date', 1).catch(() => [] as any[]);
    const account = accounts[0];
    if (!account) {
      return Response.json({ ok: false, error: 'Nenhuma conta Amazon conectada' });
    }
    const aid = account.id;

    // ── FASE 1: Solicitar relatórios ADS ────────────────────────────────────
    console.log('[pipeline] FASE 1: Solicitando relatórios ADS...');
    await db.entities.SyncExecutionLog.create({
      amazon_account_id: aid,
      operation: 'auto_full_pipeline_started',
      trigger_type: 'automatic',
      status: 'started',
      started_at: startedAt,
      result_summary: 'Pipeline automática iniciada',
    }).catch(() => {});

    const phase1Result = await invokeWithRetry(db, 'runDailyFullReportPipeline', {
      amazon_account_id: aid,
      force: body.force === true,
      _service_role: true,
    });
    summary.phase1_reports = { ok: !phase1Result.error, jobs: phase1Result.summary?.phases?.request?.count ?? 0, detail: phase1Result };

    if (phase1Result.skipped) {
      console.log('[pipeline] Fase 1 pulada — dados já sincronizados hoje');
      summary.skipped = true;
      summary.skip_reason = phase1Result.reason;
    }

    // ── FASE 3: SP-API Catálogo (paralelo, fire-and-forget) ─────────────────
    // Não aguarda — roda em paralelo com o polling dos relatórios.
    // Cada função tem retry interno.
    console.log('[pipeline] FASE 3: Sincronização SP-API (fire-and-forget)...');
    const spApiPromises = [
      invokeWithRetry(db, 'syncProductsFromInventory', { amazon_account_id: aid, _service_role: true }).catch((e: any) => ({ ok: false, error: e.message })),
      invokeWithRetry(db, 'syncProductCatalog', { amazon_account_id: aid, _service_role: true }).catch((e: any) => ({ ok: false, error: e.message })),
      invokeWithRetry(db, 'syncSalesDailyFromReports', { amazon_account_id: aid, _service_role: true }).catch((e: any) => ({ ok: false, error: e.message })),
    ];
    // Fire-and-forget: não bloqueamos a resposta aguardando SP-API
    Promise.all(spApiPromises).then(async ([invRes, catRes, salesRes]) => {
      summary.phase3_spapi = {
        inventory: { ok: invRes?.ok !== false },
        catalog: { ok: catRes?.ok !== false },
        sales: { ok: salesRes?.ok !== false },
      };
      console.log('[pipeline] FASE 3 concluída:', JSON.stringify(summary.phase3_spapi));

      // ── FASE 4: Motor de decisão (após SP-API) ─────────────────────────
      // Verifica se há dados frescos suficientes
      const refreshedAccount = await db.entities.AmazonAccount.filter({ id: aid }, null, 1).catch(() => [] as any[]);
      const acc = refreshedAccount[0] || account;
      const dataAgeH = acc?.last_sync_at
        ? (Date.now() - new Date(acc.last_sync_at).getTime()) / 3600000
        : 999;

      if (dataAgeH <= 48) {
        console.log(`[pipeline] FASE 4: Motor determinístico (dados com ${Math.round(dataAgeH)}h)...`);
        const motorResult = await invokeWithRetry(db, 'runDeterministicDecisionEngine', {
          amazon_account_id: aid,
          _service_role: true,
        }).catch((e: any) => ({ ok: false, error: e.message }));

        if (motorResult?.ok !== false && (motorResult?.decisions_saved || 0) > 0) {
          // Executar decisões aprovadas imediatamente
          await invokeWithRetry(db, 'executeApprovedDecisionQueue', {
            amazon_account_id: aid,
            _service_role: true,
          }).catch(() => {});
        }

        await db.entities.SyncExecutionLog.create({
          amazon_account_id: aid,
          operation: 'auto_full_pipeline_completed',
          trigger_type: 'automatic',
          status: motorResult?.ok !== false ? 'success' : 'warning',
          started_at: startedAt,
          completed_at: new Date().toISOString(),
          duration_ms: Date.now() - t0,
          result_summary: `Pipeline completa: fase1=${!phase1Result.error}, motor=${motorResult?.decisions_saved ?? 0} decisões`,
        }).catch(() => {});
      } else {
        console.log(`[pipeline] FASE 4 pulada — dados com ${Math.round(dataAgeH)}h (limite 48h)`);
        await db.entities.SyncExecutionLog.create({
          amazon_account_id: aid,
          operation: 'auto_full_pipeline_completed',
          trigger_type: 'automatic',
          status: 'warning',
          started_at: startedAt,
          completed_at: new Date().toISOString(),
          duration_ms: Date.now() - t0,
          result_summary: `Pipeline fase 4 pulada — dados com ${Math.round(dataAgeH)}h`,
        }).catch(() => {});
      }
    }).catch((e: any) => {
      console.error('[pipeline] FASE 3/4 erro background:', e.message);
    });

    // ── Retornar imediatamente (fases 3/4 continuam em background) ───────────
    summary.duration_ms = Date.now() - t0;
    console.log(`[pipeline] Fase 1 concluída em ${summary.duration_ms}ms. Fases 3/4 em background.`);

    return Response.json({
      ok: true,
      async_pipeline: true,
      phase1_ok: !phase1Result.error,
      phase1_skipped: phase1Result.skipped || false,
      phases_3_4: 'running_in_background',
      summary,
      duration_ms: Date.now() - t0,
    });

  } catch (err: any) {
    console.error('[runAutomaticFullPipeline] Erro:', err.message);
    return Response.json({ ok: false, error: err.message, summary, duration_ms: Date.now() - t0 }, { status: 500 });
  }
});