/**
 * runFullAutoPipeline — Orquestrador ponta a ponta (v1)
 *
 * Fases:
 *  1. Relatórios ADS (solicitar 3 relatórios)
 *  2. SP-API catálogo (produtos + estoque + vendas) — em paralelo com fase 1
 *  3. Motor determinístico de decisão (roda após dados frescos)
 *  4. Execução imediata das decisões sem aprovação manual
 *
 * Encadeamento via SyncExecutionLog (operation='full_auto_pipeline_*')
 * Idempotente: não roda se já houve pipeline bem-sucedida nas últimas 20h
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

const WINDOW_HOURS = 20;
const MAX_RETRIES = 3;
const RETRY_WAIT_MS = 4 * 60 * 1000;

async function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

async function invokeWithRetry(db: any, fnName: string, payload: any, label: string): Promise<any> {
  let lastErr = '';
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      const res = await db.functions.invoke(fnName, { ...payload, _service_role: true });
      const data = res?.data || res || {};
      if (data?.error && !data?.ok) {
        lastErr = data.error;
        console.warn(`[pipeline] ${label} tentativa ${i + 1} erro: ${lastErr}`);
      } else {
        console.log(`[pipeline] ${label} OK tentativa ${i + 1}`);
        return data;
      }
    } catch (e: any) {
      lastErr = e?.message || String(e);
      console.warn(`[pipeline] ${label} tentativa ${i + 1} exception: ${lastErr}`);
    }
    if (i < MAX_RETRIES - 1) await sleep(RETRY_WAIT_MS);
  }
  console.error(`[pipeline] ${label} falhou após ${MAX_RETRIES} tentativas: ${lastErr}`);
  return { ok: false, error: lastErr, retries: MAX_RETRIES };
}

Deno.serve(async (req) => {
  const t0 = Date.now();
  const startAt = new Date().toISOString();

  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const db = base44.asServiceRole;

    // Auth check (permite _service_role e force para watchdog e manual)
    if (!body._service_role && !body.force) {
      const user = await base44.auth.me().catch(() => null);
      if (!user) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 403 });
    }

    // Obter conta conectada
    const accounts = await db.entities.AmazonAccount.filter(
      { status: 'connected' }, '-updated_date', 1
    ).catch(() => [] as any[]);
    const account = accounts[0];
    if (!account) return Response.json({ ok: false, error: 'Nenhuma conta Amazon conectada' });
    const aid = account.id;

    // --- Idempotência: evitar dupla execução em menos de 20h ---
    if (!body.force) {
      const cutoff = new Date(Date.now() - WINDOW_HOURS * 3600000).toISOString();
      const recentLogs = await db.entities.SyncExecutionLog.filter(
        { amazon_account_id: aid, operation: 'full_auto_pipeline_complete', status: 'success' },
        '-started_at', 1
      ).catch(() => [] as any[]);
      if (recentLogs[0]?.started_at >= cutoff) {
        return Response.json({
          ok: true,
          action: 'skipped',
          reason: `Pipeline já executada com sucesso nas últimas ${WINDOW_HOURS}h`,
          last_run: recentLogs[0].started_at,
        });
      }
    }

    // Log de início
    await db.entities.SyncExecutionLog.create({
      amazon_account_id: aid,
      operation: 'full_auto_pipeline_start',
      trigger_type: body._service_role ? 'automatic' : 'manual',
      status: 'started',
      started_at: startAt,
    }).catch(() => {});

    const results: Record<string, any> = {};

    // ── FASE 1: Relatórios ADS (fire-and-forget imediato) ──────────────────
    console.log('[pipeline] FASE 1: Solicitando relatórios ADS...');
    results.ads_reports = await invokeWithRetry(db, 'runDailyFullReportPipeline', {
      amazon_account_id: aid,
      force: true,
    }, 'runDailyFullReportPipeline');

    // ── FASE 2: Catálogo SP-API (em paralelo, não bloqueia fase 1) ──────────
    console.log('[pipeline] FASE 2: Sincronizando catálogo SP-API...');
    const [catalogResult, inventoryResult, salesResult] = await Promise.allSettled([
      invokeWithRetry(db, 'syncProductCatalogV2', { amazon_account_id: aid }, 'syncProductCatalogV2'),
      invokeWithRetry(db, 'syncProductsFromInventory', { amazon_account_id: aid }, 'syncProductsFromInventory'),
      invokeWithRetry(db, 'syncSalesDailyFromReports', { amazon_account_id: aid }, 'syncSalesDailyFromReports'),
    ]);

    results.catalog = catalogResult.status === 'fulfilled' ? catalogResult.value : { error: (catalogResult as any).reason?.message };
    results.inventory = inventoryResult.status === 'fulfilled' ? inventoryResult.value : { error: (inventoryResult as any).reason?.message };
    results.sales = salesResult.status === 'fulfilled' ? salesResult.value : { error: (salesResult as any).reason?.message };

    // Log fim fase 2
    await db.entities.SyncExecutionLog.create({
      amazon_account_id: aid,
      operation: 'full_auto_pipeline_catalog_done',
      trigger_type: 'automatic',
      status: 'success',
      started_at: startAt,
      completed_at: new Date().toISOString(),
      result_summary: `catalog:${results.catalog?.ok !== false ? 'ok' : 'err'} inventory:${results.inventory?.ok !== false ? 'ok' : 'err'} sales:${results.sales?.ok !== false ? 'ok' : 'err'}`,
    }).catch(() => {});

    // ── FASE 3: Motor determinístico de decisão ────────────────────────────
    // Aguarda 3 min para dar tempo ao pollAmazonAdsReportJobs processar pelo menos 1 relatório
    console.log('[pipeline] Aguardando 3min para os relatórios ADS iniciarem processamento...');
    await sleep(3 * 60 * 1000);

    console.log('[pipeline] FASE 3: Executando motor determinístico...');
    results.decision_engine = await invokeWithRetry(db, 'runDeterministicDecisionEngine', {
      amazon_account_id: aid,
      auto_approve: true,
      skip_approval: true,
    }, 'runDeterministicDecisionEngine');

    // ── FASE 4: Executar decisões aprovadas sem intervenção ────────────────
    console.log('[pipeline] FASE 4: Executando fila de decisões aprovadas...');
    results.execute_queue = await invokeWithRetry(db, 'executeApprovedDecisionQueue', {
      amazon_account_id: aid,
      auto_execute: true,
      requires_approval: false,
    }, 'executeApprovedDecisionQueue');

    // Log de conclusão
    const duration = Date.now() - t0;
    await db.entities.SyncExecutionLog.create({
      amazon_account_id: aid,
      operation: 'full_auto_pipeline_complete',
      trigger_type: body._service_role ? 'automatic' : 'manual',
      status: 'success',
      started_at: startAt,
      completed_at: new Date().toISOString(),
      duration_ms: duration,
      result_summary: JSON.stringify({
        ads_reports: results.ads_reports?.ok !== false ? 'ok' : 'partial',
        catalog: results.catalog?.ok !== false ? 'ok' : 'err',
        inventory: results.inventory?.ok !== false ? 'ok' : 'err',
        sales: results.sales?.ok !== false ? 'ok' : 'err',
        decisions: results.decision_engine?.ok !== false ? 'ok' : 'err',
        executed: results.execute_queue?.ok !== false ? 'ok' : 'err',
      }),
    }).catch(() => {});

    console.log(`[pipeline] Completo em ${duration}ms`);
    return Response.json({
      ok: true,
      duration_ms: duration,
      amazon_account_id: aid,
      results,
    });

  } catch (err: any) {
    console.error('[pipeline] Erro fatal:', err?.message);
    return Response.json({ ok: false, error: err?.message, duration_ms: Date.now() - t0 }, { status: 500 });
  }
});