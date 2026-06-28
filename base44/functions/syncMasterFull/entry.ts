/**
 * syncMasterFull — Orquestra TODOS os syncs em sequência
 * Campanhas SP+SB+SD → Ad Groups + Keywords → Product Ads → Catálogo + Inventário → Relatório de Métricas
 * Payload: { amazon_account_id }
 * Retorna progressão passo a passo
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  const startTime = Date.now();
  let base44;

  try {
    base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const amazonAccountId = body.amazon_account_id;
    if (!amazonAccountId) return Response.json({ error: 'amazon_account_id required' }, { status: 400 });

    const steps = [];

    async function runStep(name, fnName, payload) {
      try {
        const res = await base44.functions.invoke(fnName, { amazon_account_id: amazonAccountId, ...payload });
        const data = res.data || res;
        steps.push({ step: name, ok: data.ok !== false, totalUpserted: data.totalUpserted || data.records_upserted || 0, errors: data.errors || [] });
        return data;
      } catch (e) {
        steps.push({ step: name, ok: false, error: e.message });
        return null;
      }
    }

    // 1. Campanhas SP + SB + SD
    await runStep('campaigns', 'syncCampaignsFull', {});

    // 2. Ad Groups + Keywords + Negative Keywords
    await runStep('adGroups_keywords', 'syncAdGroupsAndKeywords', {});

    // 3. Product Ads + Targets
    await runStep('product_ads', 'syncProductAds', {});

    // 4. Catálogo de Produtos + Inventário FBA
    await runStep('product_catalog', 'syncProductCatalog', {});

    // 5. Solicitar relatório de métricas (assíncrono — retorna reportId)
    await runStep('metrics_report_request', 'requestAdsReport', { days: 30 });

    const totalMs = Date.now() - startTime;
    const allOk = steps.every(s => s.ok);

    return Response.json({
      ok: true,
      allOk,
      duration_ms: totalMs,
      steps,
      note: allOk
        ? 'Sync completo! Métricas em processamento — use downloadAdsReport com o reportId em 2-5 minutos.'
        : 'Sync concluído com alguns erros — verifique o campo steps.',
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});