/**
 * Solicita Search Term Report fresco durante o dia. A Amazon atualiza a maior
 * parte das métricas a cada 3–6 horas; o poller existente baixa o job a cada
 * 10 minutos e o processador dispara a colheita same-SKU após o download.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

const BASE_COLUMNS = [
  'date', 'campaignId', 'campaignName', 'adGroupId', 'adGroupName',
  'keywordId', 'keyword', 'matchType', 'searchTerm',
  'impressions', 'clicks', 'cost',
];

const REPORT_VARIANTS = [
  {
    attribution_profile: 'total_only_fallback_no_auto_promotion',
    columns: [...BASE_COLUMNS,
      'purchases7d', 'purchases14d', 'purchases30d',
      'sales7d', 'sales14d', 'sales30d',
      'acosClicks14d', 'roasClicks14d'],
  },
];

const UNSUPPORTED_SAME_SKU_PROFILES = [
  'seller_7d_same_sku',
  'vendor_14d_same_sku',
];

function brazilDate(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function dateOffset(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00-03:00`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function unwrap(response: any): any {
  return response?.data || response || {};
}

Deno.serve(async (request) => {
  const startedAt = Date.now();
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    if (!body._service_role) {
      const authenticated = await base44.auth.isAuthenticated().catch(() => false);
      if (!authenticated) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    const accounts = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, undefined, 1)
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-updated_at', 50);
    if (!accounts.length) return Response.json({ ok: false, error: 'Nenhuma conta Amazon conectada' }, { status: 404 });

    const today = brazilDate();
    const reports: any[] = [];

    for (const account of accounts) {
      const recentTerms = await base44.asServiceRole.entities.SearchTerm.filter(
        { amazon_account_id: account.id }, '-synced_at', 200,
      ).catch(() => []);
      const hasSameSkuCapableReport = recentTerms.some((row: any) =>
        row.attribution_source && !['missing', 'total_only'].includes(String(row.attribution_source))
      );
      const requestedLookback = Number(body.lookback_days || 0);
      const lookbackDays = requestedLookback > 0
        ? Math.max(1, Math.min(65, requestedLookback))
        : body.full_backfill === true || !hasSameSkuCapableReport ? 65 : 15;
      const startDate = dateOffset(today, -(lookbackDays - 1));
      const attempts: any[] = [];
      let accepted: any = null;

      for (const attributionProfile of UNSUPPORTED_SAME_SKU_PROFILES) {
        attempts.push({
          attribution_profile: attributionProfile,
          ok: false,
          skipped: true,
          error: 'unsupported_columns_for_spSearchTerm',
          detail: 'A Amazon rejeita métricas promoted/same-SKU neste report type; nenhuma requisição inválida foi enviada.',
        });
      }

      for (const variant of REPORT_VARIANTS) {
        const response = await base44.asServiceRole.functions.invoke('requestAmazonAdsReportV3', {
          amazon_account_id: account.id,
          report_type_id: 'spSearchTerm',
          ad_product: 'SPONSORED_PRODUCTS',
          time_unit: 'DAILY',
          group_by: ['searchTerm'],
          columns: variant.columns,
          filters: null,
          start_date: startDate,
          end_date: today,
          report_name: `LivingFinds_searchTerms_${variant.attribution_profile}_${today}_${Date.now()}`,
          source_function: 'refreshSameSkuSearchTermReports',
          force_new: body.force_new !== false,
          _service_role: true,
        }).then(unwrap).catch((error: any) => ({ ok: false, error: error?.message || String(error) }));
        attempts.push({
          attribution_profile: variant.attribution_profile,
          ok: response?.ok !== false,
          job_id: response?.job_id || null,
          report_id: response?.report_id || null,
          status: response?.status || null,
          error: response?.error || null,
        });
        if (response?.ok !== false) {
          accepted = { ...response, attribution_profile: variant.attribution_profile };
          break;
        }
      }

      await base44.asServiceRole.functions.invoke('pollAmazonAdsReportJobs', {
        amazon_account_id: account.id,
        max_jobs: 20,
        _service_role: true,
      }).catch(() => null);

      const report = {
        amazon_account_id: account.id,
        start_date: startDate,
        end_date: today,
        lookback_days: lookbackDays,
        first_same_sku_backfill: !hasSameSkuCapableReport,
        accepted_profile: accepted?.attribution_profile || null,
        job_id: accepted?.job_id || null,
        report_id: accepted?.report_id || null,
        attempts,
      };
      reports.push(report);

      await base44.asServiceRole.entities.SyncExecutionLog.create({
        amazon_account_id: account.id,
        operation: 'refresh_same_sku_search_term_report_v1',
        trigger_type: body.trigger_type || 'scheduler',
        status: accepted ? 'success' : 'error',
        execution_date: today,
        started_at: new Date(startedAt).toISOString(),
        completed_at: new Date().toISOString(),
        duration_ms: Date.now() - startedAt,
        records_processed: accepted ? 1 : 0,
        result_summary: JSON.stringify(report),
        error_message: accepted ? null : attempts.map((attempt) => `${attempt.attribution_profile}: ${attempt.error || 'falha'}`).join('; ').slice(0, 1000),
      }).catch(() => null);
    }

    return Response.json({
      ok: reports.every((report) => Boolean(report.job_id || report.report_id)),
      accounts_processed: reports.length,
      reports,
      safety: 'Atribuição total não é presumida como same-SKU; promoção automática permanece bloqueada sem evidência explícita.',
      freshness_expectation: 'Amazon normalmente atualiza métricas em 3–6 horas; polling local a cada 10 minutos.',
      duration_ms: Date.now() - startedAt,
    });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || String(error), duration_ms: Date.now() - startedAt }, { status: 500 });
  }
});
