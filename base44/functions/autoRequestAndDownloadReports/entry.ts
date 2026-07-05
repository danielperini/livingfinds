/**
 * autoRequestAndDownloadReports
 * Pipeline completo: solicita relatórios Amazon Ads → espera → baixa → grava no banco.
 * Chamado por automação agendada. NÃO usa rate-limit do frontend.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  const startTime = Date.now();
  try {
    const base44 = createClientFromRequest(req);

    // Resolver conta (sem auth de usuário — é chamada de serviço)
    const accounts = await base44.asServiceRole.entities.AmazonAccount.list('-created_date', 1);
    const account = accounts[0];
    if (!account) return Response.json({ ok: false, error: 'Nenhuma conta Amazon encontrada' });

    const aid = account.id;

    // 1. Solicitar relatórios
    console.log('[autoReports] Solicitando relatórios...');
    const reqRes = await base44.asServiceRole.functions.invoke('scheduledAdsReportSync', {
      amazon_account_id: aid,
      action: 'request',
    });
    const reqData = reqRes?.data || reqRes || {};

    if (!reqData.ok || !reqData.reportIds) {
      return Response.json({ ok: false, error: reqData.error || 'Falha ao solicitar relatórios', phase: 'request' });
    }

    const { reportIds, syncRunId } = reqData;
    console.log('[autoReports] Relatórios solicitados:', JSON.stringify(reportIds));

    // 2. Aguardar + tentar baixar (poll até 20 min, intervalo 3 min)
    const POLL_INTERVAL_MS = 3 * 60 * 1000;
    const MAX_WAIT_MS = 20 * 60 * 1000;
    const pollStart = Date.now();

    while (Date.now() - pollStart < MAX_WAIT_MS) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

      console.log(`[autoReports] Tentando download (${Math.round((Date.now() - pollStart) / 60000)} min)...`);

      const dlRes = await base44.asServiceRole.functions.invoke('scheduledAdsReportSync', {
        amazon_account_id: aid,
        action: 'download',
        reportIds,
        syncRunId,
      });
      const dlData = dlRes?.data || dlRes || {};

      if (dlData.ok && dlData.ready !== false) {
        const durationS = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[autoReports] ✅ Concluído em ${durationS}s — ${dlData.campaign_metrics} métricas`);
        return Response.json({
          ok: true,
          duration_s: durationS,
          campaign_metrics: dlData.campaign_metrics,
          search_terms: dlData.search_terms,
          campaigns: dlData.campaigns,
          products: dlData.products,
        });
      }

      if (dlData.ready === false) {
        console.log('[autoReports] Relatórios ainda em geração, aguardando...');
        continue;
      }

      // Erro real
      return Response.json({ ok: false, error: dlData.error || 'Falha no download', phase: 'download' });
    }

    return Response.json({ ok: false, error: 'Timeout: relatórios não ficaram prontos em 20 min' });

  } catch (err) {
    console.error('[autoReports] Erro:', err.message);
    return Response.json({ ok: false, error: err.message });
  }
});