/**
 * syncAdsPerformanceMetricsV2 — Orquestrador leve de relatórios Amazon Ads v3
 *
 * Responsabilidade:
 * - Delegar criação/reutilização de relatório para requestAmazonAdsReportV3
 * - NÃO fazer polling longo — retorna pending se relatório ainda não está pronto
 * - NÃO baixar relatório diretamente — delegado para downloadAndProcessAmazonAdsReportJob
 * - O polling assíncrono é feito pela automação scheduledAmazonAdsReportPoll (a cada 10 min)
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function ymd(date: Date) {
  return date.toISOString().slice(0, 10);
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

    const end = body.end_date ? new Date(body.end_date) : new Date();
    const start = body.start_date ? new Date(body.start_date) : new Date(end.getTime() - 29 * 86400000);

    // Verificar se já existe job processed recente (últimas 23h)
    const twentyThreeHoursAgo = new Date(Date.now() - 23 * 3600000).toISOString();
    const recentProcessed = await base44.asServiceRole.entities.AmazonAdsReportJob.filter(
      { amazon_account_id: accountId, status: 'processed' },
      '-processed_at',
      1
    ).catch(() => []);

    if (recentProcessed[0] && recentProcessed[0].processed_at > twentyThreeHoursAgo) {
      return Response.json({
        ok: true,
        already_processed: true,
        job_id: recentProcessed[0].id,
        processed_at: recentProcessed[0].processed_at,
        message: 'Relatório já processado nas últimas 23h.',
      });
    }

    // Delegar para requestAmazonAdsReportV3
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
      ],
      start_date: ymd(start),
      end_date: ymd(end),
      report_name: `Living Finds SP campaigns ${ymd(start)} to ${ymd(end)}`,
      source_function: 'syncAdsPerformanceMetricsV2',
    });

    if (!reportRes?.ok && !reportRes?.status_425 && !reportRes?.rate_limited) {
      return Response.json({
        ok: false,
        error: reportRes?.error || 'Falha ao solicitar relatório',
        requires_reauthorization: reportRes?.requires_reauthorization,
      });
    }

    const status = reportRes?.status;

    // Se já estava processed ou completed e URL disponível, processar imediatamente
    if (status === 'completed' && reportRes?.job_id) {
      const downloadRes = await base44.asServiceRole.functions.invoke('downloadAndProcessAmazonAdsReportJob', {
        job_id: reportRes.job_id,
        _service_role: true,
      });
      if (downloadRes?.ok) {
        return Response.json({
          ok: true,
          processed: true,
          job_id: reportRes.job_id,
          records: downloadRes?.records,
          message: 'Relatório pronto e processado.',
        });
      }
    }

    if (status === 'processed') {
      return Response.json({
        ok: true,
        already_processed: true,
        reused: reportRes?.reused,
        job_id: reportRes?.job_id,
        message: 'Relatório já processado anteriormente.',
      });
    }

    // Pendente — retornar imediatamente, polling será feito pela automação
    return Response.json({
      ok: true,
      pending: true,
      reused: reportRes?.reused,
      status_425: reportRes?.status_425,
      rate_limited: reportRes?.rate_limited,
      job_id: reportRes?.job_id,
      report_id: reportRes?.report_id,
      status,
      next_poll_at: reportRes?.next_poll_at,
      message: reportRes?.message || 'Relatório solicitado à Amazon. A geração pode levar alguns minutos. Próxima checagem programada.',
    });

  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || 'Erro ao sincronizar métricas Amazon Ads' }, { status: 500 });
  }
});