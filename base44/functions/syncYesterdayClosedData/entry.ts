/**
 * syncYesterdayClosedData — ponto único do botão "Atualizar agora" do Dashboard.
 *
 * Atualiza estados/catálogo imediatamente e solicita os relatórios fechados de
 * ontem sem polling bloqueante. Dados persistidos anteriores nunca são zerados.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function yesterdaySaoPaulo() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const date = new Date(`${values.year}-${values.month}-${values.day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

async function invokeSafe(base44: any, fn: string, payload: any) {
  const started = Date.now();
  try {
    const response = await base44.asServiceRole.functions.invoke(fn, payload);
    const data = response?.data || response || {};
    return { function: fn, ok: data?.ok !== false, duration_ms: Date.now() - started, data };
  } catch (error: any) {
    return {
      function: fn,
      ok: false,
      duration_ms: Date.now() - started,
      error: String(error?.message || error).slice(0, 500),
    };
  }
}

Deno.serve(async (request) => {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    const auth = await base44.auth.isAuthenticated().catch(() => false);
    if (!auth && !body._service_role) {
      return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    const accountId = body.amazon_account_id;
    if (!accountId) {
      return Response.json({ ok: false, error: 'amazon_account_id obrigatório' }, { status: 400 });
    }

    const targetDate = String(body.date || yesterdaySaoPaulo()).slice(0, 10);
    const basePayload = {
      amazon_account_id: accountId,
      trigger_type: body.trigger_type || 'dashboard_update_now',
      _service_role: true,
    };

    // Estados Ads e catálogo/estoque são independentes e podem rodar juntos.
    const [adsStates, catalog] = await Promise.all([
      invokeSafe(base44, 'syncAds', basePayload),
      invokeSafe(base44, 'syncProductCatalogV2', basePayload),
    ]);

    // Report Ads DAILY fechado de ontem. O processamento continua pelo job
    // AmazonAdsReportJob/scheduled poll já existente.
    const adsMetrics = await invokeSafe(base44, 'syncAdsPerformanceMetricsV2', {
      ...basePayload,
      start_date: targetDate,
      end_date: targetDate,
      force: body.force === true,
      source_function: 'syncYesterdayClosedData',
    });

    // Mantém a solicitação SP-API existente no mesmo ciclo. A importação válida
    // atualiza SalesDaily sem apagar o último snapshot em caso de falha.
    const spReports = await invokeSafe(base44, 'requestProductReports', {
      ...basePayload,
      report_date: targetDate,
      force: body.force === true,
    });

    const completedAt = new Date().toISOString();
    const reportPending = adsMetrics.data?.pending === true
      || ['requested', 'pending', 'processing', 'pending_unknown', 'rate_limited'].includes(String(adsMetrics.data?.status || ''));
    const steps = [adsStates, catalog, adsMetrics, spReports];
    const hardFailures = steps.filter((step) => !step.ok && step.data?.rate_limited !== true);

    await base44.asServiceRole.entities.AmazonAccount.update(accountId, {
      last_sync_at: completedAt,
      error_message: hardFailures.length
        ? `Atualização de ontem com ${hardFailures.length} etapa(s) em erro; dados anteriores preservados.`
        : null,
    }).catch(() => {});

    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: accountId,
      operation: 'sync_yesterday_closed_data',
      status: hardFailures.length ? 'warning' : reportPending ? 'pending' : 'success',
      trigger_type: body.trigger_type || 'dashboard_update_now',
      started_at: startedAt,
      completed_at: completedAt,
      records_processed: steps.filter((step) => step.ok).length,
      result_summary: JSON.stringify({ target_date: targetDate, report_pending: reportPending, steps }).slice(0, 4000),
      error_message: hardFailures.length
        ? hardFailures.map((step) => `${step.function}: ${step.error || step.data?.error || 'falha'}`).join(' | ').slice(0, 1000)
        : null,
    }).catch(() => {});

    return Response.json({
      ok: hardFailures.length === 0,
      accepted: true,
      target_date: targetDate,
      report_pending: reportPending,
      job_id: adsMetrics.data?.job_id || null,
      report_id: adsMetrics.data?.report_id || null,
      next_poll_at: adsMetrics.data?.next_poll_at || null,
      previous_data_preserved: true,
      metrics_requested: [
        'spend', 'sales', 'orders', 'impressions', 'clicks',
        'acos', 'roas', 'cpc', 'ctr', 'units_sold',
      ],
      sp_api_requested: true,
      steps,
      duration_ms: Date.now() - startedMs,
      message: reportPending
        ? `Dados fechados de ${targetDate} solicitados. O relatório será persistido automaticamente quando a Amazon concluir.`
        : `Dados fechados de ${targetDate} atualizados.`,
    });
  } catch (error: any) {
    return Response.json({
      ok: false,
      error: String(error?.message || 'Falha ao atualizar dados fechados de ontem').slice(0, 500),
      previous_data_preserved: true,
      duration_ms: Date.now() - startedMs,
    }, { status: 500 });
  }
});
