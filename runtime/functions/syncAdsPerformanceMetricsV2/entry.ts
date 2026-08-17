/**
 * syncAdsPerformanceMetricsV2 — orquestrador assíncrono de métricas Amazon Ads v3.
 *
 * Regras:
 * - por padrão solicita somente o dia fechado de ontem em America/Sao_Paulo;
 * - não faz polling bloqueante;
 * - reutiliza somente job do mesmo período/configuração;
 * - delega download/persistência ao pipeline AmazonAdsReportJob;
 * - preserva dados anteriores enquanto o novo report estiver pendente.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function ymd(value: Date) {
  return value.toISOString().slice(0, 10);
}

function saoPauloDate(offsetDays = 0) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const base = new Date(`${map.year}-${map.month}-${map.day}T12:00:00Z`);
  base.setUTCDate(base.getUTCDate() + offsetDays);
  return ymd(base);
}

Deno.serve(async (request) => {
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

    const yesterday = saoPauloDate(-1);
    const startDate = String(body.start_date || yesterday).slice(0, 10);
    const endDate = String(body.end_date || yesterday).slice(0, 10);
    const force = body.force === true;

    if (startDate > endDate) {
      return Response.json({ ok: false, error: 'start_date não pode ser posterior a end_date' }, { status: 400 });
    }

    // Reutilizar somente relatório processado do mesmo período.
    if (!force) {
      const recentProcessed = await base44.asServiceRole.entities.AmazonAdsReportJob.filter(
        {
          amazon_account_id: accountId,
          report_type_id: 'spCampaigns',
          time_unit: 'DAILY',
          start_date: startDate,
          end_date: endDate,
          status: 'processed',
        },
        '-processed_at',
        1,
      ).catch(() => []);

      if (recentProcessed[0]) {
        return Response.json({
          ok: true,
          already_processed: true,
          job_id: recentProcessed[0].id,
          processed_at: recentProcessed[0].processed_at,
          period: { start_date: startDate, end_date: endDate },
          message: `Métricas fechadas de ${startDate} a ${endDate} já foram processadas.`,
        });
      }
    }

    const reportRes = await base44.asServiceRole.functions.invoke('requestAmazonAdsReportV3', {
      amazon_account_id: accountId,
      report_type_id: 'spCampaigns',
      ad_product: 'SPONSORED_PRODUCTS',
      time_unit: 'DAILY',
      group_by: ['campaign'],
      columns: [
        'date',
        'campaignId',
        'campaignName',
        'campaignStatus',
        'campaignBudgetAmount',
        'impressions',
        'clicks',
        'cost',
        'purchases7d',
        'purchases14d',
        'purchases30d',
        'sales7d',
        'sales14d',
        'sales30d',
        'unitsSoldClicks7d',
        'unitsSoldClicks14d',
        'unitsSoldClicks30d',
      ],
      start_date: startDate,
      end_date: endDate,
      report_name: `Living Finds SP campaigns CLOSED ${startDate} to ${endDate}`,
      source_function: body.source_function || 'syncAdsPerformanceMetricsV2',
    });

    const data = reportRes?.data || reportRes || {};
    if (!data?.ok && !data?.status_425 && !data?.rate_limited) {
      return Response.json({
        ok: false,
        error: data?.error || 'Falha ao solicitar relatório',
        requires_reauthorization: data?.requires_reauthorization,
        period: { start_date: startDate, end_date: endDate },
      });
    }

    if (data?.status === 'completed' && data?.job_id) {
      const downloadResponse = await base44.asServiceRole.functions.invoke('downloadAndProcessAmazonAdsReportJob', {
        job_id: data.job_id,
        _service_role: true,
      });
      const download = downloadResponse?.data || downloadResponse || {};
      if (download?.ok) {
        return Response.json({
          ok: true,
          processed: true,
          job_id: data.job_id,
          records: download.records || 0,
          period: { start_date: startDate, end_date: endDate },
          message: 'Relatório fechado pronto e persistido.',
        });
      }
    }

    if (data?.status === 'processed') {
      return Response.json({
        ok: true,
        already_processed: true,
        reused: data?.reused,
        job_id: data?.job_id,
        period: { start_date: startDate, end_date: endDate },
        message: 'Relatório fechado já processado anteriormente.',
      });
    }

    return Response.json({
      ok: true,
      pending: true,
      reused: data?.reused,
      status_425: data?.status_425,
      rate_limited: data?.rate_limited,
      job_id: data?.job_id,
      report_id: data?.report_id,
      status: data?.status,
      next_poll_at: data?.next_poll_at,
      period: { start_date: startDate, end_date: endDate },
      message: data?.message || 'Relatório fechado solicitado. O polling assíncrono fará o download e a persistência.',
    });
  } catch (error: any) {
    return Response.json({
      ok: false,
      error: error?.message || 'Erro ao sincronizar métricas Amazon Ads',
    }, { status: 500 });
  }
});
