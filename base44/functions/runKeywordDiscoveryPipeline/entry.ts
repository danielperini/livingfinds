/**
 * runKeywordDiscoveryPipeline
 *
 * Pipeline completo de descoberta de keywords via Amazon Ads API.
 * Roda na madrugada (00h–05h BRT) antes da janela de criação de campanhas (13h).
 *
 * Etapas:
 * 1. replaceCurrentAiSuggestions — arquiva sugestões IA antigas
 * 2. syncAmazonKeywordSuggestionsByAsin — busca sugestões oficiais Amazon por ASIN
 * 3. rankAmazonKeywordSuggestions — IA rankeia entre as sugestões Amazon
 * 4. archiveManualCampaignsWithoutSpend — arquiva campanhas manuais sem performance
 * 5. createExactCampaignsFromAmazonSuggestions — cria até 4 campanhas EXACT por produto
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  const startedAt = new Date().toISOString();
  const results: Record<string, any> = {};
  const errors: string[] = [];

  try {
    const base44 = createClientFromRequest(req);
    const auth = await base44.auth.isAuthenticated().catch(() => false);
    const body = await req.json().catch(() => ({}));
    if (!auth && !body._service_role) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

    // Resolver conta
    let account: any = null;
    if (body.amazon_account_id) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id });
      account = accs[0];
    }
    if (!account) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      account = accs[0];
    }
    if (!account) return Response.json({ ok: false, error: 'Nenhuma conta conectada' });

    const aid = account.id;

    // ── ETAPA 1: Arquivar sugestões IA antigas ────────────────────────────
    console.log('[KeywordDiscovery] Etapa 1: replaceCurrentAiSuggestions');
    try {
      const r = await base44.asServiceRole.functions.invoke('replaceCurrentAiSuggestions', {
        amazon_account_id: aid, _service_role: true,
      });
      results.replace_ai = { archived: r?.data?.archived || 0 };
    } catch (e: any) {
      errors.push(`replaceCurrentAiSuggestions: ${e.message}`);
    }

    // ── ETAPA 2: Buscar sugestões Amazon por ASIN ─────────────────────────
    console.log('[KeywordDiscovery] Etapa 2: syncAmazonKeywordSuggestionsByAsin');
    const products = await base44.asServiceRole.entities.Product.filter(
      { amazon_account_id: aid, status: 'active' }, null, 50
    ).catch(() => []);

    const activeProducts = products.filter((p: any) =>
      p.asin && (p.fba_inventory || 0) > 0 && p.inventory_status !== 'out_of_stock'
    );

    let totalSynced = 0;
    for (const p of activeProducts.slice(0, 20)) {
      try {
        const r = await base44.asServiceRole.functions.invoke('syncAmazonKeywordSuggestionsByAsin', {
          amazon_account_id: aid,
          asin: p.asin,
          max_suggestions_per_asin: 50,
          match_types: ['EXACT', 'PHRASE', 'BROAD'],
          _service_role: true,
        });
        totalSynced += r?.data?.total_created || 0;
        await new Promise(res => setTimeout(res, 1500));
      } catch (e: any) {
        errors.push(`sync ASIN ${p.asin}: ${e.message}`);
      }
    }
    results.sync_suggestions = { products_processed: activeProducts.length, total_synced: totalSynced };

    // ── ETAPA 3: Rankear com IA ───────────────────────────────────────────
    console.log('[KeywordDiscovery] Etapa 3: rankAmazonKeywordSuggestions');
    let totalRanked = 0;
    for (const p of activeProducts.slice(0, 20)) {
      try {
        const r = await base44.asServiceRole.functions.invoke('rankAmazonKeywordSuggestions', {
          amazon_account_id: aid,
          asin: p.asin,
          max_results: 10,
          _service_role: true,
        });
        totalRanked += r?.data?.ranked || 0;
        await new Promise(res => setTimeout(res, 1000));
      } catch (e: any) {
        errors.push(`rank ASIN ${p.asin}: ${e.message}`);
      }
    }
    results.rank_suggestions = { total_ranked: totalRanked };

    // ── ETAPA 4: Arquivar campanhas manuais sem performance ───────────────
    console.log('[KeywordDiscovery] Etapa 4: archiveManualCampaignsWithoutSpend');
    try {
      const r = await base44.asServiceRole.functions.invoke('archiveManualCampaignsWithoutSpend', {
        amazon_account_id: aid, _service_role: true,
      });
      results.archive_campaigns = { archived: r?.data?.archived || 0, candidates: r?.data?.candidates || 0 };
    } catch (e: any) {
      errors.push(`archiveManualCampaignsWithoutSpend: ${e.message}`);
    }

    // ── ETAPA 5: Criar campanhas EXACT ────────────────────────────────────
    // Não cria aqui — agendado para janela das 13h. Apenas valida elegíveis.
    console.log('[KeywordDiscovery] Etapa 5: validar elegíveis para janela 13h');
    let eligibleCount = 0;
    for (const p of activeProducts.slice(0, 20)) {
      try {
        const r = await base44.asServiceRole.functions.invoke('createExactCampaignsFromAmazonSuggestions', {
          amazon_account_id: aid,
          asin: p.asin,
          limit: 4,
          execute_now_if_window: true, // respeita a janela — só cria se estiver na janela
          _service_role: true,
        });
        if (r?.data?.created) eligibleCount += r.data.created;
        await new Promise(res => setTimeout(res, 500));
      } catch {}
    }
    results.create_campaigns = { created: eligibleCount };

    const duration_ms = Date.now() - new Date(startedAt).getTime();

    return Response.json({
      ok: true,
      started_at: startedAt,
      duration_ms,
      products_active: activeProducts.length,
      results,
      errors: errors.slice(0, 20),
    });

  } catch (error: any) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});