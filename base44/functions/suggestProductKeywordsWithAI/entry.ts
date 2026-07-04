import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function norm(value) {
  return String(value || '')
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
  const inter = [...ta].filter((token) => tb.has(token)).length;
  const union = new Set([...ta, ...tb]).size;
  return union > 0 && inter / union >= 0.80;
}

function firstObject(...values) {
  return values.find((value) => value && typeof value === 'object' && !Array.isArray(value)) || null;
}

function extractEventProduct(body) {
  return firstObject(
    body?.data,
    body?.new_data,
    body?.newData,
    body?.record,
    body?.entity,
    body?.event?.data,
    body?.event?.new_data,
    body?.event?.record,
    body?.payload?.data,
    body?.payload?.record,
    body?.product,
  );
}

function extractAsin(body, eventProduct) {
  const candidates = [
    body?.asin,
    body?.ASIN,
    body?.advertised_asin,
    eventProduct?.asin,
    eventProduct?.ASIN,
    eventProduct?.advertised_asin,
    eventProduct?.amazon_asin,
    eventProduct?.parent_asin,
  ];
  const value = candidates.find((candidate) => String(candidate || '').trim());
  return value ? String(value).trim().toUpperCase() : null;
}

function extractProductId(body, eventProduct) {
  return body?.product_id || body?.productId || eventProduct?.id || eventProduct?._id || null;
}

function extractAccountId(body, eventProduct) {
  return body?.amazon_account_id || body?.amazonAccountId || eventProduct?.amazon_account_id || eventProduct?.amazonAccountId || null;
}

async function writeLog(base44, {
  accountId = null,
  status,
  startedAt,
  asin = null,
  productId = null,
  stage,
  message = null,
  details = {},
}) {
  const completedAt = new Date().toISOString();
  const summary = {
    function: 'suggestProductKeywordsWithAI',
    stage,
    asin,
    product_id: productId,
    message,
    ...details,
  };

  await base44.asServiceRole.entities.SyncExecutionLog.create({
    amazon_account_id: accountId,
    operation: 'suggest_product_keywords_with_ai',
    status,
    trigger_type: 'product_created_or_updated',
    started_at: startedAt,
    completed_at: completedAt,
    records_processed: Number(details?.records_processed || details?.new_suggestions || 0),
    result_summary: JSON.stringify(summary).slice(0, 4000),
    error_message: status === 'error' ? String(message || 'Erro desconhecido').slice(0, 1000) : null,
  }).catch(() => {});
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
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY não configurada.');
  const model = Deno.env.get('ANTHROPIC_MODEL_FAST') || 'claude-haiku-4-5';
  const systemPrompt = `Você é especialista em Amazon Ads Sponsored Products no marketplace brasileiro.
Gere exatamente 10 palavras-chave novas: 5 de cauda média e 5 de cauda longa.
Use apenas características reais do produto e dados históricos.
Não repita keywords existentes ou negativadas.
Use match_type exact.
Retorne somente JSON válido no formato:
{"medium_tail":[{"keyword":"...","match_type":"exact","intent":"commercial","relevance_score":0.95,"confidence":0.90,"reason":"..."}],"long_tail":[{"keyword":"...","match_type":"exact","intent":"high_purchase_intent","relevance_score":0.97,"confidence":0.88,"reason":"..."}]}`;

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
      messages: [{
        role: 'user',
        content: JSON.stringify({
          asin: payload.asin,
          sku: payload.sku,
          title: payload.title,
          category: payload.category,
          brand: payload.brand,
          price: payload.price,
          inventory_status: payload.inventory_status,
          avg_cpc: payload.avg_cpc,
          avg_conv_rate: payload.avg_conv_rate,
          avg_acos: payload.avg_acos,
          target_acos: payload.target_acos,
          converted_terms: payload.converted_terms.slice(0, 10),
          search_term_metrics: payload.search_term_metrics.slice(0, 15),
          existing_keywords: payload.existing_keywords.slice(0, 30),
          negative_keywords: payload.negative_keywords.slice(0, 20),
        }),
      }],
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
  const startedAt = new Date().toISOString();
  let base44 = null;
  let accountId = null;
  let asin = null;
  let productId = null;
  let stage = 'initializing';

  try {
    base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    const serviceRole = body._service_role === true;
    if (!serviceRole) {
      const user = await base44.auth.me().catch(() => null);
      if (!user) throw new Error('Unauthorized');
    }

    const eventProduct = extractEventProduct(body);
    productId = extractProductId(body, eventProduct);
    accountId = extractAccountId(body, eventProduct);
    asin = extractAsin(body, eventProduct);

    stage = 'resolve_product';
    let product = null;
    if (productId) {
      const rows = await base44.asServiceRole.entities.Product.filter({ id: productId });
      product = rows[0] || null;
    }

    if (!product && asin && accountId) {
      const rows = await base44.asServiceRole.entities.Product.filter({
        amazon_account_id: accountId,
        asin,
      });
      product = rows[0] || null;
    }

    if (!product && asin) {
      const rows = await base44.asServiceRole.entities.Product.filter({ asin });
      product = rows[0] || null;
    }

    if (!product && eventProduct?.sku) {
      const rows = accountId
        ? await base44.asServiceRole.entities.Product.filter({ amazon_account_id: accountId, sku: eventProduct.sku })
        : await base44.asServiceRole.entities.Product.filter({ sku: eventProduct.sku });
      product = rows[0] || null;
    }

    if (product) {
      productId = product.id;
      accountId = accountId || product.amazon_account_id || null;
      asin = String(product.asin || asin || '').trim().toUpperCase() || null;
    }

    if (!product) throw new Error(`Produto não encontrado. product_id=${productId || 'n/a'} asin=${asin || 'n/a'}`);
    if (!asin) throw new Error(`ASIN ausente no produto ${productId}. Sincronize o catálogo antes de gerar keywords.`);

    stage = 'validate_product';
    const status = String(product.status || eventProduct?.status || '').toLowerCase();
    const fbaInventory = Number(
      product.fba_inventory ??
      product.fba_quantity ??
      product.inventory_fba ??
      product.fulfillable_quantity ??
      eventProduct?.fba_inventory ??
      eventProduct?.fba_quantity ??
      0
    );
    const inventoryStatus = String(product.inventory_status || eventProduct?.inventory_status || '').toLowerCase();

    if (status !== 'active' || fbaInventory <= 0 || inventoryStatus === 'out_of_stock') {
      await writeLog(base44, {
        accountId,
        status: 'success',
        startedAt,
        asin,
        productId,
        stage,
        message: 'Produto ignorado por estar inativo ou sem estoque FBA.',
        details: { skipped: true, product_status: status, fba_inventory: fbaInventory, inventory_status: inventoryStatus },
      });
      return Response.json({ ok: true, skipped: true, asin, product_id: productId, reason: 'product not active or no FBA stock' });
    }

    stage = 'resolve_account';
    let account = null;
    if (accountId) {
      const rows = await base44.asServiceRole.entities.AmazonAccount.filter({ id: accountId });
      account = rows[0] || null;
    }
    if (!account) {
      const rows = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      account = rows[0] || null;
    }
    if (!account) throw new Error('Conta Amazon conectada não encontrada.');
    accountId = account.id;

    stage = 'load_context';
    const title = product.product_name || product.display_name || product.title || '';
    if (!String(title).trim()) throw new Error('Produto sem título. Sincronize os títulos antes de gerar sugestões.');

    const [campaigns, allKeywords, searchTerms, configs, previousSuggestions] = await Promise.all([
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: accountId, asin }, '-created_date', 30).catch(() => []),
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: accountId }, '-spend', 600).catch(() => []),
      base44.asServiceRole.entities.SearchTerm.filter({ amazon_account_id: accountId, advertised_asin: asin }, '-orders_14d', 300).catch(() => []),
      base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: accountId }).catch(() => []),
      base44.asServiceRole.entities.KeywordSuggestion.filter({ amazon_account_id: accountId, asin }, '-created_at', 500).catch(() => []),
    ]);

    const config = configs[0] || {};
    const minBid = Number(config.min_bid || 0.10);
    const maxBid = Number(config.max_bid || 5.0);
    const targetAcos = Number(config.target_acos || config.acos_target || 25);
    const campaignIds = new Set(campaigns.map((campaign) => campaign.campaign_id));
    const productKeywords = allKeywords.filter((keyword) => campaignIds.has(keyword.campaign_id) && keyword.state !== 'archived');
    const negativeKeywords = allKeywords.filter((keyword) => keyword.state === 'archived' || keyword.status === 'archived');
    const avgCpc = productKeywords.length
      ? productKeywords.reduce((sum, keyword) => sum + Number(keyword.cpc || 0), 0) / productKeywords.length
      : 0;
    const keywordsWithClicks = productKeywords.filter((keyword) => Number(keyword.clicks || 0) > 0);
    const avgConvRate = keywordsWithClicks.length
      ? keywordsWithClicks.reduce((sum, keyword) => sum + Number(keyword.orders || 0) / Math.max(Number(keyword.clicks || 0), 1), 0) / keywordsWithClicks.length
      : Number(product.conversion_rate_30d || 0.08);
    const keywordsWithAcos = productKeywords.filter((keyword) => Number(keyword.acos || 0) > 0);
    const avgAcos = keywordsWithAcos.length
      ? keywordsWithAcos.reduce((sum, keyword) => sum + Number(keyword.acos || 0), 0) / keywordsWithAcos.length
      : 0;
    const existingKeywordTexts = productKeywords.map((keyword) => keyword.keyword_text || keyword.keyword || '').filter(Boolean);
    const negativeTexts = negativeKeywords.map((keyword) => keyword.keyword_text || keyword.keyword || '').filter(Boolean);

    const aggregate = new Map();
    for (const searchTerm of searchTerms) {
      const term = String(searchTerm.search_term || searchTerm.keyword_text || '').toLowerCase().trim();
      if (!term) continue;
      const current = aggregate.get(term) || { term, clicks: 0, orders: 0, spend: 0, sales: 0, impressions: 0 };
      current.clicks += Number(searchTerm.clicks || 0);
      current.orders += Number(searchTerm.orders_14d || searchTerm.orders_7d || 0);
      current.spend += Number(searchTerm.spend || 0);
      current.sales += Number(searchTerm.sales_14d || searchTerm.sales_7d || 0);
      current.impressions += Number(searchTerm.impressions || 0);
      aggregate.set(term, current);
    }

    const searchTermMetrics = [...aggregate.values()].map((item) => ({
      term: item.term,
      clicks: item.clicks,
      orders: item.orders,
      spend: item.spend,
      acos: item.sales > 0 ? item.spend / item.sales * 100 : 0,
      cpc: item.clicks > 0 ? item.spend / item.clicks : 0,
      conv_rate: item.clicks > 0 ? item.orders / item.clicks : 0,
    })).sort((a, b) => b.orders - a.orders || b.clicks - a.clicks);

    const convertedTerms = searchTermMetrics.filter((item) => item.orders >= 1).map((item) => ({ term: item.term, orders: item.orders, acos: item.acos }));

    stage = 'claude_generation';
    const aiResult = await callClaude({
      asin,
      sku: product.sku || '',
      title,
      category: product.category || '',
      brand: product.brand || '',
      price: Number(product.price || product.buy_box_price || 0),
      inventory_status: inventoryStatus || 'unknown',
      avg_cpc: avgCpc,
      avg_conv_rate: avgConvRate,
      avg_acos: avgAcos,
      target_acos: targetAcos,
      search_term_metrics: searchTermMetrics,
      converted_terms: convertedTerms,
      existing_keywords: existingKeywordTexts,
      negative_keywords: negativeTexts,
    });

    stage = 'deduplicate_and_persist';
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
        (norm(previous.normalized_keyword || previous.keyword || '') === normalizedKeyword || isSimilar(previous.keyword || '', keyword))
      );
      if (alreadySuggested) continue;
      const generatedKey = `${normalizedKeyword}::${matchType}`;
      if (generatedNorms.has(generatedKey)) continue;
      generatedNorms.add(generatedKey);
      const sourceMetric = searchTermMetrics.find((metric) => isSimilar(metric.term, keyword));
      const sourceSearchTerm = searchTerms.find((row) => isSimilar(row.search_term || row.keyword_text || '', keyword));
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
        amazon_account_id: accountId,
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
        source: 'CLAUDE_PRODUCT_ANALYSIS',
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

    const responseBody = {
      ok: true,
      action: 'keyword_suggestions_generated',
      asin,
      product_id: product.id,
      amazon_account_id: accountId,
      total: recordsToCreate.length,
      new_suggestions: recordsToCreate.length,
      duplicates_skipped: aiSuggestions.length - recordsToCreate.length,
      persisted: true,
      amazon_api_called: false,
      auto_approved: false,
      kickoff_queue_created: false,
      model_used: aiResult.model_used,
    };

    await writeLog(base44, {
      accountId,
      status: 'success',
      startedAt,
      asin,
      productId: product.id,
      stage: 'completed',
      message: 'Sugestões de keywords geradas com sucesso.',
      details: responseBody,
    });

    return Response.json(responseBody);
  } catch (error) {
    if (base44) {
      await writeLog(base44, {
        accountId,
        status: 'error',
        startedAt,
        asin,
        productId,
        stage,
        message: error?.message || 'Erro ao gerar sugestões de keywords',
        details: { stack: String(error?.stack || '').slice(0, 1500) },
      });
    }
    return Response.json({
      ok: false,
      error: error?.message || 'Erro ao gerar sugestões de keywords',
      stage,
      asin,
      product_id: productId,
      log_operation: 'suggest_product_keywords_with_ai',
    }, { status: 500 });
  }
});
