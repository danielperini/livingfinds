/**
 * rankAmazonKeywordSuggestions
 *
 * Cruza sugestões oficiais da Amazon Ads com performance real das campanhas
 * e usa IA APENAS para ranquear/filtrar — nunca para criar keywords.
 *
 * A IA recebe dados estruturados e escolhe as melhores entre as sugestões Amazon.
 * Máximo 10 sugestões por produto.
 * Confiança mínima para criação automática: 0.90
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  const now = new Date().toISOString();
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { amazon_account_id, asin, max_results = 10 } = body;

    if (!asin) return Response.json({ ok: false, error: 'asin obrigatório' });

    let account: any = null;
    if (amazon_account_id) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: amazon_account_id });
      account = accs[0];
    }
    if (!account) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      account = accs[0];
    }
    if (!account) return Response.json({ ok: false, error: 'Conta não encontrada' });

    const aid = account.id;
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

    // Buscar sugestões Amazon para este ASIN
    const suggestions = await base44.asServiceRole.entities.KeywordSuggestion.filter({
      amazon_account_id: aid,
      asin,
      source: 'AMAZON_ADS_SUGGESTED_KEYWORD',
      status: 'suggested',
    }, null, 200).catch(() => []);

    if (!suggestions.length) {
      return Response.json({ ok: true, asin, ranked: 0, message: 'Nenhuma sugestão Amazon encontrada para rankear' });
    }

    // Carregar dados de contexto em paralelo
    const [product, searchTerms, keywords, campaigns, metricsRaw, autopilotConfig] = await Promise.all([
      base44.asServiceRole.entities.Product.filter({ amazon_account_id: aid, asin }).catch(() => []),
      base44.asServiceRole.entities.SearchTerm.filter({ amazon_account_id: aid }, '-created_date', 500).catch(() => []),
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: aid }, null, 500).catch(() => []),
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid, asin }, null, 50).catch(() => []),
      base44.asServiceRole.entities.CampaignMetricsDaily.filter({ amazon_account_id: aid }, '-date', 200).catch(() => []),
      base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: aid }, null, 1).catch(() => []),
    ]);

    const prod = product[0] || null;
    const ap = autopilotConfig[0] || null;

    // Verificar produto elegível
    const hasStock = prod && (prod.fba_inventory || 0) > 0 && prod.inventory_status !== 'out_of_stock';
    const hasPrice = prod && (prod.price || 0) > 0;
    const isActive = prod?.status === 'active';

    if (!hasStock || !hasPrice || !isActive) {
      return Response.json({
        ok: true, asin, ranked: 0,
        message: 'Produto sem estoque, preço ou inativo — ranking bloqueado',
        product_status: { has_stock: hasStock, has_price: hasPrice, is_active: isActive },
      });
    }

    // Índice de keywords existentes ativas (para evitar duplicatas)
    const activeKeywordsNorm = new Set(
      keywords
        .filter((k: any) => k.state === 'ENABLED' || k.status === 'enabled')
        .map((k: any) => (k.keyword_text || k.keyword || '').toLowerCase().trim())
    );

    // Índice de termos negativados
    const negatedTerms = new Set(
      keywords
        .filter((k: any) => k.state === 'NEGATED' || k.match_type === 'NEGATIVE_EXACT' || k.match_type === 'NEGATIVE_PHRASE')
        .map((k: any) => (k.keyword_text || k.keyword || '').toLowerCase().trim())
    );

    // Índice de performance por termo (últimos 30 dias)
    const termPerf: Record<string, { spend: number; sales: number; orders: number; clicks: number; impressions: number }> = {};
    for (const st of searchTerms) {
      const norm = (st.query || st.search_term || '').toLowerCase().trim();
      if (!norm) continue;
      if (!termPerf[norm]) termPerf[norm] = { spend: 0, sales: 0, orders: 0, clicks: 0, impressions: 0 };
      termPerf[norm].spend += st.spend || 0;
      termPerf[norm].sales += st.sales || 0;
      termPerf[norm].orders += st.orders || 0;
      termPerf[norm].clicks += st.clicks || 0;
      termPerf[norm].impressions += st.impressions || 0;
    }

    // Calcular métricas reais de campanhas do produto
    let productSpend30d = 0, productSales30d = 0, productOrders30d = 0;
    const campaignIds = new Set(campaigns.map((c: any) => c.campaign_id || c.amazon_campaign_id).filter(Boolean));
    for (const m of metricsRaw) {
      if (!campaignIds.has(m.campaign_id)) continue;
      if (m.date && m.date < thirtyDaysAgo) continue;
      productSpend30d += m.spend || 0;
      productSales30d += m.sales || 0;
      productOrders30d += m.orders || 0;
    }
    const realAcos = productSales30d > 0 ? (productSpend30d / productSales30d) * 100 : null;
    const realCpc = productOrders30d > 0 ? productSpend30d / productOrders30d : null;
    const targetAcos = ap?.target_acos || 10;
    const grossMargin = prod?.break_even_acos_pct || prod?.profit_margin_pct || 0;
    const maxCpc = prod?.maximum_ad_spend_per_order || null;

    // Preparar dados estruturados para a IA
    const suggestionsForAI = suggestions.slice(0, 100).map((s: any) => ({
      id: s.id,
      keyword: s.keyword,
      normalized: s.normalized_keyword,
      match_type: s.match_type,
      source_asin: s.source_asin,
      source_asin_type: s.source_asin_type,
      amazon_bid: s.amazon_suggested_bid,
      amazon_bid_min: s.amazon_suggested_bid_min,
      amazon_bid_max: s.amazon_suggested_bid_max,
      amazon_relevance: s.amazon_relevance_score,
      amazon_impressions_est: s.amazon_impression_estimate,
      amazon_orders_est: s.amazon_order_estimate,
      already_active: activeKeywordsNorm.has((s.normalized_keyword || s.keyword || '').toLowerCase()),
      is_negated: negatedTerms.has((s.normalized_keyword || s.keyword || '').toLowerCase()),
      historical: termPerf[(s.normalized_keyword || s.keyword || '').toLowerCase()] || null,
    }));

    const productContext = {
      asin,
      product_name: prod?.product_name || prod?.display_name || asin,
      price: prod?.price || 0,
      stock: prod?.fba_inventory || 0,
      gross_margin_pct: grossMargin,
      target_acos: targetAcos,
      real_acos_30d: realAcos,
      real_cpc_30d: realCpc,
      max_cpc: maxCpc,
      product_spend_30d: productSpend30d,
      product_orders_30d: productOrders30d,
    };

    // IA: ranquear apenas entre sugestões Amazon — não criar keywords novas
    const aiPrompt = `Você é um especialista em Amazon Ads. Seu trabalho é APENAS ranquear e filtrar sugestões de keywords que já foram fornecidas pela Amazon Ads API. Você NÃO pode criar nenhuma keyword nova, modificar o texto de nenhuma keyword, ou sugerir termos que não estejam na lista abaixo.

PRODUTO:
${JSON.stringify(productContext, null, 2)}

SUGESTÕES DA AMAZON ADS API (escolha as melhores entre estas):
${JSON.stringify(suggestionsForAI, null, 2)}

CRITÉRIOS DE RANQUEAMENTO (por prioridade):
1. Keyword veio da Amazon Ads API ✓ (todas já vieram)
2. Alta aderência ao produto (relevância semântica real)
3. Não contém marca registrada ou nome de concorrente
4. Não é termo genérico demais (ex: "produto", "item", "coisa")
5. Não está negativada (already_negated = true → descartar)
6. Não existe campanha ativa igual (already_active = true → descartar)
7. CPC sugerido Amazon cabe na margem do produto
8. Produto tem estoque suficiente
9. Se tem histórico: pedidos > 0 aumenta score; gasto sem venda diminui score
10. Evitar keywords muito parecidas entre si (priorizar diversidade)
11. Preferir EXACT match

RETORNE JSON com esta estrutura:
{
  "ranked_suggestions": [
    {
      "id": "id da sugestão original",
      "ai_rank": 1,
      "ai_confidence": 0.95,
      "ai_reason": "motivo claro e objetivo em 1-2 frases",
      "risk_level": "low",
      "recommended_match_type": "EXACT",
      "recommended_bid": 0.75,
      "recommended_daily_budget": 5.00,
      "implementation_priority": "immediate",
      "should_create_campaign": true
    }
  ]
}

Selecione no máximo ${max_results} sugestões. Apenas inclua sugestões com ai_confidence >= 0.70. Para should_create_campaign = true, exija ai_confidence >= 0.90 e risk_level = low ou medium.`;

    const aiRes = await base44.asServiceRole.integrations.Core.InvokeLLM({
      prompt: aiPrompt,
      response_json_schema: {
        type: 'object',
        properties: {
          ranked_suggestions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                ai_rank: { type: 'number' },
                ai_confidence: { type: 'number' },
                ai_reason: { type: 'string' },
                risk_level: { type: 'string' },
                recommended_match_type: { type: 'string' },
                recommended_bid: { type: 'number' },
                recommended_daily_budget: { type: 'number' },
                implementation_priority: { type: 'string' },
                should_create_campaign: { type: 'boolean' },
              },
            },
          },
        },
      },
    });

    const ranked = aiRes?.ranked_suggestions || [];
    let updated = 0;

    // Atualizar apenas campos de ranqueamento — o texto da keyword não muda
    for (const r of ranked) {
      if (!r.id) continue;
      await base44.asServiceRole.entities.KeywordSuggestion.update(r.id, {
        ai_rank: r.ai_rank,
        ai_confidence: r.ai_confidence,
        confidence: Math.round((r.ai_confidence || 0) * 100),
        ai_reason: r.ai_reason,
        risk_level: r.risk_level || 'medium',
        recommended_match_type: r.recommended_match_type || 'EXACT',
        recommended_bid: r.recommended_bid,
        recommended_budget: r.recommended_daily_budget || 5,
        implementation_priority: r.implementation_priority || 'next_window',
        should_create_campaign: r.should_create_campaign || false,
        status: 'ranked',
      }).catch(() => {});
      updated++;
    }

    return Response.json({
      ok: true,
      asin,
      suggestions_evaluated: suggestions.length,
      ranked: updated,
      should_create_count: ranked.filter((r: any) => r.should_create_campaign).length,
    });

  } catch (error: any) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});