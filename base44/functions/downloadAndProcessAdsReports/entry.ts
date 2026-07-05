/**
 * downloadAndProcessAdsReports
 *
 * Etapa 2 do pipeline diário de relatórios.
 * Roda às 06:30 BRT (09:30 UTC) — 30min após o request (06:00 BRT).
 *
 * 1. Encontra o SyncRun mais recente com reportIds pendentes
 * 2. Baixa os relatórios da Amazon (já deveriam estar prontos em ~15min)
 * 3. Processa e atualiza todas as entidades (CampaignMetricsDaily, SearchTerm, etc.)
 * 4. Invoca runDailyPipelineConsolidated passando os reportIds para evitar novo request
 *
 * Total de chamadas externas: 3 (1 check status + 3 downloads) — apenas 1x/dia.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  const startMs = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    // Resolver conta
    const accounts = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id })
      : await base44.asServiceRole.entities.AmazonAccount.list('-created_date', 1);
    const account = accounts[0];
    if (!account) return Response.json({ ok: false, error: 'Nenhuma conta encontrada' });

    const aid = account.id;

    // Buscar o SyncRun mais recente com relatórios pendentes
    const recentRuns = await base44.asServiceRole.entities.SyncRun.filter(
      { amazon_account_id: aid, status: 'running' }, '-started_at', 5
    );

    // Filtrar runs que contêm reportIds no campo operation
    const reportRun = recentRuns.find((r: any) => r.operation?.startsWith('scheduledReports:'));

    if (!reportRun) {
      return Response.json({
        ok: false,
        skipped: true,
        reason: 'Nenhum relatório pendente encontrado. O request das 06:00 pode não ter ocorrido ou já foi processado.',
      });
    }

    // Extrair reportIds do campo operation: "scheduledReports:YYYY-MM-DD:{...json...}"
    const opMatch = reportRun.operation.match(/scheduledReports:[^:]+:(.+)$/);
    if (!opMatch) return Response.json({ ok: false, error: 'Formato de SyncRun inválido' });

    let reportIds: Record<string, string>;
    try { reportIds = JSON.parse(opMatch[1]); } catch {
      return Response.json({ ok: false, error: 'Não foi possível parsear reportIds do SyncRun' });
    }

    console.log(`[downloadAndProcessAdsReports] Baixando ${Object.keys(reportIds).length} relatórios — SyncRun ${reportRun.id}`);

    // Invocar download via scheduledAdsReportSync
    const downloadRes = await base44.asServiceRole.functions.invoke('scheduledAdsReportSync', {
      amazon_account_id: aid,
      action: 'download',
      reportIds,
      syncRunId: reportRun.id,
      _service_role: true,
    });

    const dlData = downloadRes?.data || downloadRes || {};

    if (!dlData.ok) {
      // Relatórios ainda não prontos — registrar e sair (retry automático no próximo ciclo)
      if (dlData.ready === false) {
        return Response.json({
          ok: true,
          ready: false,
          pending: dlData.pending,
          message: 'Relatórios ainda em geração na Amazon. Serão baixados amanhã.',
        });
      }
      return Response.json({ ok: false, error: dlData.error || 'Falha no download' });
    }

    // Download concluído — disparar pipeline de otimização com flag para pular o request
    const pipelineRes = await base44.asServiceRole.functions.invoke('runDailyPipelineConsolidated', {
      amazon_account_id: aid,
      report_ids: reportIds,
      sync_run_id: reportRun.id,
      _service_role: true,
    });

    const plData = pipelineRes?.data || pipelineRes || {};

    return Response.json({
      ok: true,
      download: {
        search_terms: dlData.search_terms,
        campaign_metrics: dlData.campaign_metrics,
        campaigns: dlData.campaigns,
        products: dlData.products,
        duration_s: dlData.duration_s,
      },
      pipeline: {
        ok: plData.ok,
        accounts_processed: plData.accounts_processed,
        duration_ms: plData.duration_ms,
      },
      total_duration_ms: Date.now() - startMs,
    });

  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || 'Erro no download de relatórios' }, { status: 500 });
  }
});