/**
 * dailyReportScheduler — Executa automaticamente toda a manhã:
 *   1. Solicita os 3 relatórios de 30 dias (requestAdsReport)
 *   2. Aguarda 15 minutos e tenta baixar (downloadAdsReport) — repete até completar ou falhar
 * Chamado pela automação agendada diária.
 * Payload: {} (sem payload — usa o primeiro AmazonAccount activo)
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);

    // Encontrar conta Amazon activa (service role)
    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
    if (accounts.length === 0) {
      return Response.json({ ok: false, message: 'Nenhuma conta Amazon conectada.' });
    }
    const amazonAccountId = accounts[0].id;

    // 1. Solicitar relatórios
    const reqRes = await base44.asServiceRole.functions.invoke('requestAdsReport', { amazon_account_id: amazonAccountId });
    const reqData = reqRes?.data || reqRes;
    if (!reqData?.ok) {
      return Response.json({ ok: false, step: 'request', error: reqData?.error || 'requestAdsReport falhou' });
    }

    const reportIds = reqData.reportIds;

    // 2. Polling — tenta até 6x com 5 minutos de intervalo (máx 30 min total)
    let downloadResult = null;
    for (let attempt = 1; attempt <= 6; attempt++) {
      // Aguardar 5 minutos entre tentativas (primeira tentativa: 5 min após solicitar)
      await new Promise(r => setTimeout(r, 5 * 60 * 1000));

      const dlRes = await base44.asServiceRole.functions.invoke('downloadAdsReport', {
        amazon_account_id: amazonAccountId,
        report_ids: reportIds,
      });
      const dlData = dlRes?.data || dlRes;

      if (dlData?.ready === true) {
        downloadResult = dlData;
        break;
      }
      if (dlData?.ready === false && Object.keys(dlData.pending || {}).length > 0) {
        // ainda a processar — continuar polling
        continue;
      }
      // erro — parar
      break;
    }

    // Actualizar last_sync_at na conta
    await base44.asServiceRole.entities.AmazonAccount.update(amazonAccountId, {
      last_sync_at: new Date().toISOString(),
    });

    return Response.json({
      ok: true,
      amazon_account_id: amazonAccountId,
      report_ids: reportIds,
      download: downloadResult,
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});