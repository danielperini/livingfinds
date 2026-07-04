/**
 * suggestProductKeywordsWithAI — v3 (Claude / Anthropic)
 *
 * Gera e persiste sugestões de keywords para produtos ativos com estoque.
 * Pode ser chamada pela interface ou diretamente por automação de entidade Product.
 *
 * Não cria campanhas, não altera bids/budgets na Amazon, não aprova sugestões
 * e não cria ProductKickoffQueue.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function norm(kw) {
  return (kw || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isSimilar(a, b) {
  const na = norm(a), nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const ta = new Set(na.split(' '));
  const tb = new Set(nb.split(' '));
  const inter = [...ta].filter((t) => tb.has(t)).length;
  const union = new Set([...ta, ...tb]).size;
  return union > 0 && inter / union >= 0.80;
}

function calcBid({ stCpc, stAcos, stConvRate, avgCpc, price, targetAcos, minBid, maxBid }) {
  const candidates = [];
  if (stCpc > 0) candidates.push(stCpc * 1.10);

  const convRate = stConvRate > 0 ? stConvRate : 0.08;
  if (price > 0 && targetAcos > 0) {
    const maxProfitable = price * convRate * (targetAcos / 100);
    if (maxProfitable > 0) candidates.push(maxProfitable);
  }

  if (avgCpc > 0) candidates.push(avgCpc * 1.05);

  if (stAcos > 0 && stAcos > targetAcos && stCpc > 0) {
    candidates.push(stCpc * (targetAcos / stAcos));
  }

  if (!candidates.length) {
    return { bid: Math.max(minBid, 0.30), confidence: 'low', max_profitable_cpc: 0 };
  }

  const rawBid = Math.min(...candidates);
  const clamped = Math.max(Math.min(rawBid, maxBid), minBid);
  const maxProfitable = price > 0
    ? Math.round(price * convRate * (targetAcos / 100) * 100) / 100
    : 0;

  return {
    bid: Math.round(clamped * 100) / 100,
    confidence: stCpc > 0 ? 'high' : avgCpc > 0 ? 'medium' : 'low',
    max_profitable_cpc: maxProfitable,
  };
}

async function callClaude(payload) {
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY não configurada. Configure em Settings → Environment Variables.');
  }

  const model = Deno.env.get('ANTHROPIC_MODEL_FAST') || 'claude-haiku-4-5';

  const systemPrompt = `Você é especialista em Amazon Ads Sponsored Products no marketplace brasileiro.

Analise os dados reais do produto e gere exatamente 10 palavras-chave novas:
- 5 de cauda média;
- 5 de cauda longa.

REGRAS:
1. Use apenas características presentes no título, categoria, marca e dados históricos.
2. Priorize expansões semânticas de termos que converteram.
3. Não repita keywords existentes.
4. Não sugira keywords negativadas.
5. Não gere variações quase idênticas.
6. Use match_type exact.
7. Classifique relevance_score, confidence, intent e reason.
8. Retorne somente JSON válido.

FORMATO:
{
  "medium_tail": [
    {
      "keyword": "...",
      "match_type": "exact",
      "intent": "commercial",
      "relevance_score": 0.95,
      "confidence": 0.90,
      "reason": "..."
    }
  ],
  "long_tail": [
    {
      "keyword": "...",
      "match_type": "exact",
      "intent": "high_purchase_intent",
      "relevance_score": 0.97,
      "confidence": 0.88,
      "reason": "..."
    }
  ]
}`;

  const stContext = payload.search_term_metrics.slice(0, 15).map((st) =>
    `"${st.term}": cliques=${st.clicks}, pedidos=${st.orders}, spend=R$${st.spend.toFixed(2)}, acos=${st.acos.toFixed(1)}%, cpc=R$${st.cpc.toFixed(2)}, conv=${(st.conv_rate * 100).toFixed(1)}%`
  ).join('\n');

  const convertedContext = payload.converted_terms.slice(0, 10).map((t) =>
    `"${t.term}" (${t.orders} pedidos, ACoS ${t.acos.toFixed(1)}%)`
  ).join('\n');

  const userMessage = `PRODUTO:
ASIN: ${payload.asin}
SKU: ${payload.sku || 'N/A'}
Título: ${payload.title}
Categoria: ${payload.category || 'N/A'}
Marca: ${payload.brand || 'N/A'}
Preço: R$ ${payload.price || 'N/A'}
Estoque: ${payload.inventory_status || 'N/A'}

MÉTRICAS:
CPC médio: R$ ${payload.avg_cpc.toFixed(2)}
Conversão média: ${(payload.avg_conv_rate * 100).toFixed(1)}%
ACoS médio: ${payload.avg_acos.toFixed(1)}%
Target ACoS: ${payload.target_acos}%

TERMOS CONVERTIDOS:
${convertedContext || 'nenhum'}

SEARCH TERMS:
${stContext || 'nenhum'}

KEYWORDS EXISTENTES:
${payload.existing_keywords.slice(0, 30).join(', ') || 'nenhuma'}

KEYWORDS NEGATIVADAS:
${payload.negative_keywords.slice(0, 20).join(', ') || 'nenhuma'}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1500,
      temperature: 0.3,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(`Anthropic erro ${response.status}: ${error.error?.message || JSON.stringify(error)}`);
  }

  const data = await response.json();
  const content = String(data.content?.[0]?.text || '').trim();

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Claude não retornou JSON válido.');
    parsed = JSON.parse(match[0]);
  }

  if (!Array.isArray(parsed.medium_tail) || !Array.isArray(parsed.long_tail)) {
    throw new Error('Resposta inválida: medium_tail e long_tail obrigatórios.');
  }

  return {
    ...parsed,
    model_used: model,
    input_tokens: data.usage?.input_tokens,
    output_tokens: data.usage?.output_tokens,
  };
}

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));

    const serviceRole = body._service_role === true;
    if (!serviceRole) {
      const user = await base44.auth.me().catch(() => null);
      if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const eventProduct = body.data && typeof body.data === 'object' ? body.data : null;
    const amazonAccountId = body.amazon_account_id || eventProduct?.amazon_account_id || null;
    const requestedAsin = body.asin || eventProduct?.asin || null;
    const productId = body.product_id || eventProduct?.id || null;

    if (!requestedAsin && !productId) {
      return Response.json({ ok: false, error: 'asin ou product_id obrigatório' }, { status: 400 });
    }

    if (eventProduct) {
      const isActive = eventProduct.status === 'active';
      const hasStock =
        eventProduct.inventory_status !== 'out_of_stock' &&
        Number(eventProduct.fba_inventory || 0) > 0;

      if (!isActive || !hasStock) {
        return Response.json({
          ok: true,
          skipped: true,
          reason: 'product not active or no FBA stock',
        });
      }
    }

    let account = null;
    if (amazonAccountId) {
      const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ id: amazonAccountId });
      account = accounts[0] || null;
    } else {
      const accounts = await base44.asServiceRole.entities.AmazonAccount.filter(
        { status: 'connected' },
        '-created_date',
        1,
      );
      account = accounts[0] || null;
    }

    if (!account) {
      return Response.json({ ok: false, error: 'Conta Amazon não encontrada.' }, { status: 404 });
    }

    const aid = account.id;

    let product = null;
    if (productId) {
      const products = await base44.asServiceRole.entities.Product.filter({ id: productId });
      product = products[0] || null;
    }

    if (!product && requestedAsin) {
      const products = await base44.asServiceRole.entities.Product.filter({
        amazon_account_id: aid,
        asin: requestedAsin,
      });
      product = products[0] || null;
    }

    if (!product) {
      return Response.json({
        ok: false,
        error: `Produto ${requestedAsin || productId} não encontrado.`,
      }, { status: 404 });
    }

    const asin = product.asin || requestedAsin;
    const title = product.product_name || product.display_name || product.title || '';

    if (!title.trim()) {
      return Response.json({
        ok: false,
        blocked: true,
        error: 'Produto sem título. Sincronize os títulos antes de gerar sugestões.',
      });
    }

    const [campaigns, allKeywords, searchTerms, configs, previousSuggestions] = await Promise.all([
      base44.asServiceRole.entities.Campaign.filter(
        { amazon_account_id: aid, asin },
        '-created_date',
        30,
      ).catch(() => []),
      base44.asServiceRole.entities.Keyword.filter(
        { amazon_account_id: aid },
        '-spend',
        600,
      ).catch(() => []),
      base44.asServiceRole.entities.SearchTerm.filter(
        { amazon_account_id: aid, advertised_asin: asin },
        '-orders_14d',
        300,
      ).catch(() => []),
      base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: aid }).catch(() => []),
      base44.asServiceRole.entities.KeywordSuggestion.filter(
        { amazon_account_id: aid, asin },
        '-created_at',
        500,
      ).catch(() => []),
    ]);

    const config = configs[0] || {};
    const minBid = Number(config.min_bid || 0.10);
    const maxBid = Number(config.max_bid || 5.0);
    const targetAcos = Number(config.target_acos || config.acos_target || 25);

    const campaignIds = new Set(campaigns.map((campaign) => campaign.campaign_id));
    const productKeywords = allKeywords.filter(
      (keyword) => campaignIds.has(keyword.campaign_id) && keyword.state !== 'archived',
    );
    const negativeKeywords = allKeywords.filter(
      (keyword) => keyword.state === 'archived' || keyword.status === 'archived',
    );

    const avgCpc = productKeywords.length
      ? productKeywords.reduce((sum, keyword) => sum + Number(keyword.cpc || 0), 0) / productKeywords.length
      : 0;

    const keywordsWithClicks = productKeywords.filter((keyword) => Number(keyword.clicks || 0) > 0);
    const avgConvRate = keywordsWithClicks.length
      ? keywordsWithClicks.reduce(
          (sum, keyword) => sum + Number(keyword.orders || 0) / Math.max(Number(keyword.clicks || 0), 1),
          0,
        ) / keywordsWithClicks.length
      : Number(product.conversion_rate_30d || 0.08);

    const keywordsWithAcos = productKeywords.filter((keyword) => Number(keyword.acos || 0) > 0);
    const avgAcos = keywordsWithAcos.length
      ? keywordsWithAcos.reduce((sum, keyword) => sum + Number(keyword.acos || 0), 0) / keywordsWithAcos.length
      : 0;

    const existingKeywordTexts = productKeywords
      .map((keyword) => keyword.keyword_text || keyword.keyword || '')
      .filter(Boolean);

    const negativeTexts = negativeKeywords
      .map((keyword) => keyword.keyword_text || keyword.keyword || '')
      .filter(Boolean);

    const aggregate = new Map();

    for (const searchTerm of searchTerms) {
      const term = String(searchTerm.search_term || searchTerm.keyword_text || '').toLowerCase().trim();
      if (!term) continue;

      const current = aggregate.get(term) || {
        term,
        clicks: 0,
        orders: 0,
        spend: 0,
        sales: 0,
        impressions: 0,
      };

      current.clicks += Number(searchTerm.clicks || 0);
      current.orders += Number(searchTerm.orders_14d || searchTerm.orders_7d || 0);
      current.spend += Number(searchTerm.spend || 0);
      current.sales += Number(searchTerm.sales_14d || searchTerm.sales_7d || 0);
      current.impressions += Number(searchTerm.impressions || 0);

      aggregate.set(term, current);
    }

    const searchTermMetrics = [...aggregate.values()]
      .map((item) => ({
        term: item.term,
        clicks: item.clicks,
        orders: item.orders,
        spend: item.spend,
        acos: item.sales > 0 ? item.spend / item.sales * 100 : 0,
        cpc: item.clicks > 0 ? item.spend / item.clicks : 0,
        conv_rate: item.clicks > 0 ? item.orders / item.clicks : 0,
      }))
      .sort((a, b) => b.orders - a.orders || b.clicks - a.clicks);

    const convertedTerms = searchTermMetrics
      .filter((item) => item.orders >= 1)
      .map((item) => ({ term: item.term, orders: item.orders, acos: item.acos }));

    const aiResult = await callClaude({
      asin,
      sku: product.sku || '',
      title,
      category: product.category || '',
      brand: product.brand || '',
      price: Number(product.price || product.buy_box_price || 0),
      inventory_status: product.inventory_status || 'unknown',
      avg_cpc: avgCpc,
      avg_conv_rate: avgConvRate,
      avg_acos: avgAcos,
      target_acos: targetAcos,
      search_term_metrics: searchTermMetrics,
      converted_terms: convertedTerms,
      existing_keywords: existingKeywordTexts,
      negative_keywords: negativeTexts,
    });

    const generatedNorms = new Set();
    const now = new Date().toISOString();
    const price = Number(product.price || product.buy_box_price || 0);

    const aiSuggestions = [
      ...aiResult.medium_tail.map((item) => ({ ...item, tail_type: 'medium' })),
      ...aiResult.long_tail.map((item) => ({ ...item, tail_type: 'long' })),
    ];

    const recordsToCreate = [];

    for (const suggestion of aiSuggestions) {
      const keyword = String(suggestion.keyword || '').toLowerCase().trim();
      if (!keyword) continue;
      if (negativeTexts.some((negative) => isSimilar(negative, keyword))) continue;
      if (existingKeywordTexts.some((existing) => isSimilar(existing, keyword))) continue;

      const normalizedKeyword = norm(keyword);
      const matchType = suggestion.match_type || 'exact';

      const alreadySuggested = previousSuggestions.some((previous) =>
        (previous.match_type || 'exact') === matchType &&
        (
          norm(previous.normalized_keyword || previous.keyword || '') === normalizedKeyword ||
          isSimilar(previous.keyword || '', keyword)
        ),
      );

      if (alreadySuggested) continue;

      const generatedKey = `${normalizedKeyword}::${matchType}`;
      if (generatedNorms.has(generatedKey)) continue;
      generatedNorms.add(generatedKey);

      const sourceMetric = searchTermMetrics.find((metric) => isSimilar(metric.term, keyword));
      const sourceSearchTerm = searchTerms.find((searchTerm) =>
        isSimilar(
          searchTerm.search_term || searchTerm.keyword_text || '',
          keyword,
        ),
      );

      const bid = calcBid({
        stCpc: Number(sourceMetric?.cpc || 0),
        stAcos: Number(sourceMetric?.acos || 0),
        stConvRate: Number(sourceMetric?.conv_rate || 0),
        avgCpc,
        price,
        targetAcos,
        minBid,
        maxBid,
      });

      recordsToCreate.push({
        amazon_account_id: aid,
        product_id: product.id,
        asin,
        sku: product.sku || '',
        keyword,
        normalized_keyword: normalizedKeyword,
        tail_type: suggestion.tail_type,
        match_type: matchType,
        intent: suggestion.intent || 'commercial',
        relevance_score: Number(suggestion.relevance_score || 0),
        confidence: Number(suggestion.confidence || 0),
        reason: suggestion.reason || '',
        source: 'OPENAI_TITLE_ANALYSIS',
        source_search_term_id: sourceSearchTerm?.id || null,
        status: 'suggested',
        already_exists: false,
        duplicate_of: null,
        block_reason: null,
        recommended_bid: bid.bid,
        recommended_budget: 5.00,
        maximum_profitable_cpc: bid.max_profitable_cpc,
        bid_confidence: bid.confidence,
        created_at: now,
      });
    }

    const saved = [];

    for (let index = 0; index < recordsToCreate.length; index += 20) {
      const batch = recordsToCreate.slice(index, index + 20);
      const result = await base44.asServiceRole.entities.KeywordSuggestion.bulkCreate(batch);
      saved.push(...(Array.isArray(result) ? result : batch));
    }

    const persistedSuggestions = recordsToCreate.map((record, index) => ({
      ...record,
      id: saved[index]?.id || null,
    }));

    return Response.json({
      ok: true,
      action: 'keyword_suggestions_generated',
      asin,
      product_id: product.id,
      total: persistedSuggestions.length,
      new_suggestions: persistedSuggestions.length,
      duplicates_skipped: aiSuggestions.length - persistedSuggestions.length,
      persisted: true,
      amazon_api_called: false,
      auto_approved: false,
      kickoff_queue_created: false,
      medium_tail: persistedSuggestions.filter((item) => item.tail_type === 'medium'),
      long_tail: persistedSuggestions.filter((item) => item.tail_type === 'long'),
      product_title: title,
      model_used: aiResult.model_used,
      tokens: {
        input: aiResult.input_tokens,
        output: aiResult.output_tokens,
      },
      bid_context: {
        avg_cpc: avgCpc,
        avg_conv_rate: avgConvRate,
        avg_acos: avgAcos,
        price,
        target_acos: targetAcos,
        converted_terms_count: convertedTerms.length,
        search_terms_analyzed: searchTermMetrics.length,
      },
    });
  } catch (error) {
    return Response.json({
      ok: false,
      error: error?.message || 'Erro ao gerar sugestões de keywords',
    }, { status: 500 });
  }
});
