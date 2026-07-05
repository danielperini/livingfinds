/**
 * suggestProductKeywordsWithAI — Geração determinística de sugestões de keywords
 *
 * SEM IA: gera sugestões baseadas em:
 *  1. Search terms já convertidos (orders >= 1) do próprio produto
 *  2. Termos do TermBank para o mesmo ASIN
 *  3. Extração de N-grams do título do produto (2-4 palavras)
 *
 * Claude só é invocado se `force_ai: true` for passado explicitamente (kickoff manual).
 * Isso elimina o consumo de créditos em sincronizações automáticas.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function norm(value: string): string {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isSimilar(a: string, b: string): boolean {
  const na = norm(a), nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const ta = new Set(na.split(' '));
  const tb = new Set(nb.split(' '));
  const inter = [...ta].filter((token) => tb.has(token)).length;
  const union = new Set([...ta, ...tb]).size;
  return union > 0 && inter / union >= 0.80;
}

function firstObject(...values: any[]): any {
  return values.find((value) => value && typeof value === 'object' && !Array.isArray(value)) || null;
}

function extractEventProduct(body: any): any {
  return firstObject(
    body?.data, body?.new_data, body?.newData, body?.record, body?.entity,
    body?.event?.data, body?.event?.new_data, body?.event?.record,
    body?.payload?.data, body?.payload?.record, body?.product,
  );
}

function extractAsin(body: any, eventProduct: any): string | null {
  const candidates = [
    body?.asin, body?.ASIN, body?.advertised_asin,
    eventProduct?.asin, eventProduct?.ASIN, eventProduct?.advertised_asin,
    eventProduct?.amazon_asin, eventProduct?.parent_asin,
  ];
  const value = candidates.find((c) => String(c || '').trim());
  return value ? String(value).trim().toUpperCase() : null;
}

function extractProductId(body: any, eventProduct: any): string | null {
  return body?.product_id || body?.productId || eventProduct?.id || eventProduct?._id || null;
}

function extractAccountId(body: any, eventProduct: any): string | null {
  return body?.amazon_account_id || body?.amazonAccountId
    || eventProduct?.amazon_account_id || eventProduct?.amazonAccountId || null;
}

function calcBid({ stCpc, stAcos, stConvRate, avgCpc, price, targetAcos, minBid, maxBid }: any): { bid: number; confidence: string; max_profitable_cpc: number } {
  const candidates: number[] = [];
  if (stCpc > 0) candidates.push(stCpc * 1.10);
  const convRate = stConvRate > 0 ? stConvRate : 0.08;
  if (price > 0 && targetAcos > 0) {
    const maxProfitable = price * convRate * (targetAcos / 100);
    if (maxProfitable > 0) candidates.push(maxProfitable);
  }
  if (avgCpc > 0) candidates.push(avgCpc * 1.05);
  if (!candidates.length) return { bid: Math.max(minBid, 0.30), confidence: 'low', max_profitable_cpc: 0 };
  const rawBid = Math.min(...candidates);
  const clamped = Math.max(Math.min(rawBid, maxBid), minBid);
  const maxProfitable = price > 0 ? Math.round(price * convRate * (targetAcos / 100) * 100) / 100 : 0;
  return {
    bid: Math.round(clamped * 100) / 100,
    confidence: stCpc > 0 ? 'high' : avgCpc > 0 ? 'medium' : 'low',
    max_profitable_cpc: maxProfitable,
  };
}

// ── Extração determinística de N-grams do título ──────────────────────────────
function extractTitleNgrams(title: string): string[] {
  const stopWords = new Set([
    'de', 'do', 'da', 'dos', 'das', 'e', 'o', 'a', 'os', 'as', 'um', 'uma',
    'com', 'em', 'para', 'por', 'sem', 'sob', 'ate', 'no', 'na', 'nos', 'nas',
    'que', 'se', 'ou', 'mas', 'por', 'isso', 'este', 'esta', 'esse', 'essa',
    'kit', 'jogo', 'conjunto', 'peca', 'pecas', 'unidade', 'un', 'par',
  ]);

  const normalized = norm(title);
  const tokens = normalized.split(' ').filter((t) => t.length >= 3 && !stopWords.has(t));
  const ngrams = new Set<string>();

  // 2-grams e 3-grams — foco em termos de cauda média (high purchase intent)
  for (let i = 0; i < tokens.length; i++) {
    if (i + 1 < tokens.length) {
      const bigram = `${tokens[i]} ${tokens[i + 1]}`;
      if (bigram.length >= 8) ngrams.add(bigram);
    }
    if (i + 2 < tokens.length) {
      const trigram = `${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}`;
      if (trigram.length >= 12) ngrams.add(trigram);
    }
    if (i + 3 < tokens.length) {
      const fourgram = `${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]} ${tokens[i + 3]}`;
      if (fourgram.length >= 16) ngrams.add(fourgram);
    }
  }

  return [...ngrams].slice(0, 15);
}

async function writeLog(base44: any, {
  accountId, status, startedAt, asin, productId, stage, message, details,
}: any): Promise<void> {
  const completedAt = new Date().toISOString();
  await base44.asServiceRole.entities.SyncExecutionLog.create({
    amazon_account_id: accountId,
    operation: 'suggest_product_keywords_deterministic',
    status,
    trigger_type: 'product_created_or_updated',
    started_at: startedAt,
    completed_at: completedAt,
    records_processed: Number(details?.new_suggestions || 0),
    result_summary: JSON.stringify({ function: 'suggestProductKeywordsWithAI', stage, asin, product_id: productId, message, ...details }).slice(0, 4000),
    error_message: status === 'error' ? String(message || 'Erro desconhecido').slice(0, 1000) : null,
  }).catch(() => {});
}

// ── Claude (opcional — só quando force_ai: true) ──────────────────────────────
async function callClaude(payload: any): Promise<any> {
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY não configurada.');
  const model = 'claude-haiku-4-5';
  const systemPrompt = `Você é especialista em Amazon Ads Sponsored Products no marketplace brasileiro.
Gere exatamente 10 palavras-chave novas: 5 de cauda média e 5 de cauda longa.
Use apenas características reais do produto e dados históricos.
Não repita keywords existentes ou negativadas.
Use match_type exact.
Retorne somente JSON válido no formato:
{"medium_tail":[{"keyword":"...","match_type":"exact","intent":"commercial","relevance_score":0.95,"confidence":0.90,"reason":"..."}],"long_tail":[{"keyword":"...","match_type":"exact","intent":"high_purchase_intent","relevance_score":0.97,"confidence":0.88,"reason":"..."}]}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model, max_tokens: 1500, temperature: 0.3, system: systemPrompt,
      messages: [{ role: 'user', content: JSON.stringify(payload) }],
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(`Anthropic erro ${response.status}: ${error.error?.message || JSON.stringify(error)}`);
  }

  const data = await response.json();
  const content = String(data.content?.[0]?.text || '').trim();
  let parsed: any;
  try { parsed = JSON.parse(content); } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Claude não retornou JSON válido.');
    parsed = JSON.parse(match[0]);
  }
  if (!Array.isArray(parsed.medium_tail) || !Array.isArray(parsed.long_tail)) {
    throw new Error('Resposta inválida: medium_tail e long_tail obrigatórios.');
  }
  return { ...parsed, model_used: model, ai_used: true };
}

// ── Handler principal ─────────────────────────────────────────────────────────
Deno.serve(async (request) => {
  const startedAt = new Date().toISOString();
  let base44: any = null;
  let accountId: string | null = null;
  let asin: string | null = null;
  let productId: string | null = null;
  let stage = 'initializing';

  try {
    base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    const serviceRole = body._service_role === true;
    if (!serviceRole) {
      const user = await base44.auth.me().catch(() => null);
      if (!user) throw new Error('Unauthorized');
    }

    // force_ai: true → chamada manual explícita (kickoff) — usa Claude
    // force_ai: false/ausente → automação/sync → lógica determinística (zero IA)
    const forceAI = body.force_ai === true;

    const eventProduct = extractEventProduct(body);
    productId = extractProductId(body, eventProduct);
    accountId = extractAccountId(body, eventProduct);
    asin = extractAsin(body, eventProduct);

    // ── Resolver produto ──────────────────────────────────────────────────────
    stage = 'resolve_product';
    let product: any = null;
    if (productId) {
      const rows = await base44.asServiceRole.entities.Product.filter({ id: productId });
      product = rows[0] || null;
    }
    if (!product && asin && accountId) {
      const rows = await base44.asServiceRole.entities.Product.filter({ amazon_account_id: accountId, asin });
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
    if (!asin) throw new Error(`ASIN ausente no produto ${productId}.`);

    // ── Validar produto ───────────────────────────────────────────────────────
    stage = 'validate_product';
    const productStatus = String(product.status || eventProduct?.status || '').toLowerCase();
    const fbaInventory = Number(product.fba_inventory ?? product.fba_quantity ?? 0);
    const inventoryStatus = String(product.inventory_status || eventProduct?.inventory_status || '').toLowerCase();

    if (productStatus !== 'active' || fbaInventory <= 0 || inventoryStatus === 'out_of_stock') {
      await writeLog(base44, { accountId, status: 'success', startedAt, asin, productId, stage, message: 'Produto ignorado: inativo ou sem estoque.', details: { skipped: true } });
      return Response.json({ ok: true, skipped: true, asin, reason: 'product not active or no FBA stock' });
    }

    // ── Resolver conta ────────────────────────────────────────────────────────
    stage = 'resolve_account';
    let account: any = null;
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

    const title = product.product_name || product.display_name || product.title || '';
    if (!String(title).trim()) throw new Error('Produto sem título.');

    // ── Carregar contexto ─────────────────────────────────────────────────────
    stage = 'load_context';
    const [campaigns, allKeywords, searchTerms, configs, previousSuggestions, termBankTerms] = await Promise.all([
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: accountId, asin }, '-created_date', 30).catch(() => []),
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: accountId }, '-spend', 500).catch(() => []),
      base44.asServiceRole.entities.SearchTerm.filter({ amazon_account_id: accountId, advertised_asin: asin }, '-orders_14d', 300).catch(() => []),
      base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: accountId }).catch(() => []),
      base44.asServiceRole.entities.KeywordSuggestion.filter({ amazon_account_id: accountId, asin }, '-created_at', 500).catch(() => []),
      base44.asServiceRole.entities.TermBank.filter({ amazon_account_id: accountId, asin }, null, 200).catch(() => []),
    ]);

    const config = configs[0] || {};
    const minBid = Number(config.min_bid || 0.10);
    const maxBid = Number(config.max_bid || 5.0);
    const targetAcos = Number(config.target_acos || config.acos_target || 25);

    const campaignIds = new Set(campaigns.map((c: any) => c.campaign_id));
    const productKeywords = allKeywords.filter((k: any) => campaignIds.has(k.campaign_id) && k.state !== 'archived');
    const negativeKeywords = allKeywords.filter((k: any) => k.state === 'archived' || k.status === 'archived');
    const existingKeywordTexts = productKeywords.map((k: any) => k.keyword_text || k.keyword || '').filter(Boolean);
    const negativeTexts = negativeKeywords.map((k: any) => k.keyword_text || k.keyword || '').filter(Boolean);

    const avgCpc = productKeywords.length
      ? productKeywords.reduce((s: number, k: any) => s + Number(k.cpc || 0), 0) / productKeywords.length : 0;
    const keywordsWithClicks = productKeywords.filter((k: any) => Number(k.clicks || 0) > 0);
    const avgConvRate = keywordsWithClicks.length
      ? keywordsWithClicks.reduce((s: number, k: any) => s + Number(k.orders || 0) / Math.max(Number(k.clicks || 0), 1), 0) / keywordsWithClicks.length
      : Number(product.conversion_rate_30d || 0.08);

    const aggregate = new Map<string, any>();
    for (const st of searchTerms as any[]) {
      const term = String(st.search_term || st.keyword_text || '').toLowerCase().trim();
      if (!term) continue;
      const current = aggregate.get(term) || { term, clicks: 0, orders: 0, spend: 0, sales: 0 };
      current.clicks += Number(st.clicks || 0);
      current.orders += Number(st.orders_14d || st.orders_7d || 0);
      current.spend += Number(st.spend || 0);
      current.sales += Number(st.sales_14d || st.sales_7d || 0);
      aggregate.set(term, current);
    }

    const searchTermMetrics = [...aggregate.values()].map((item) => ({
      term: item.term, clicks: item.clicks, orders: item.orders, spend: item.spend,
      acos: item.sales > 0 ? item.spend / item.sales * 100 : 0,
      cpc: item.clicks > 0 ? item.spend / item.clicks : 0,
      conv_rate: item.clicks > 0 ? item.orders / item.clicks : 0,
    })).sort((a, b) => b.orders - a.orders);

    const price = Number(product.price || product.buy_box_price || 0);
    const now = new Date().toISOString();

    // ── Conjunto de sugestões já existentes para dedup ────────────────────────
    const alreadySuggestedNorms = new Set(
      previousSuggestions.map((s: any) => `${norm(s.keyword || '')}::${s.match_type || 'exact'}`)
    );

    const recordsToCreate: any[] = [];
    const generatedNorms = new Set<string>();

    const addSuggestion = (keyword: string, tailType: string, intent: string, relevance: number, confidence: number, reason: string, sourceMetricTerm?: string) => {
      const kw = keyword.toLowerCase().trim();
      if (!kw || kw.length < 4) return;
      if (negativeTexts.some((n) => isSimilar(n, kw))) return;
      if (existingKeywordTexts.some((e) => isSimilar(e, kw))) return;
      const normalized = norm(kw);
      const dedupKey = `${normalized}::exact`;
      if (alreadySuggestedNorms.has(dedupKey)) return;
      if (generatedNorms.has(dedupKey)) return;
      generatedNorms.add(dedupKey);

      const sourceMetric = searchTermMetrics.find((m) => isSimilar(m.term, kw));
      const bid = calcBid({
        stCpc: sourceMetric?.cpc || 0,
        stAcos: sourceMetric?.acos || 0,
        stConvRate: sourceMetric?.conv_rate || 0,
        avgCpc, price, targetAcos, minBid, maxBid,
      });

      recordsToCreate.push({
        amazon_account_id: accountId,
        product_id: product.id,
        asin,
        sku: product.sku || '',
        keyword: kw,
        normalized_keyword: normalized,
        tail_type: tailType,
        match_type: 'exact',
        intent,
        relevance_score: relevance,
        confidence,
        reason,
        source: 'AUTOMATIC_SEARCH_TERM',
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
    };

    if (forceAI) {
      // ── MODO IA: Claude (kickoff manual explícito) ─────────────────────────
      stage = 'claude_generation';
      const convertedTerms = searchTermMetrics.filter((m) => m.orders >= 1).map((m) => ({ term: m.term, orders: m.orders, acos: m.acos }));
      const aiResult = await callClaude({
        asin, sku: product.sku || '', title,
        category: product.category || '', brand: product.brand || '', price,
        inventory_status: inventoryStatus || 'unknown',
        avg_cpc: avgCpc, avg_conv_rate: avgConvRate, avg_acos: 0,
        target_acos: targetAcos,
        search_term_metrics: searchTermMetrics.slice(0, 15),
        converted_terms: convertedTerms.slice(0, 10),
        existing_keywords: existingKeywordTexts.slice(0, 30),
        negative_keywords: negativeTexts.slice(0, 20),
      });

      const aiSuggestions = [
        ...aiResult.medium_tail.map((s: any) => ({ ...s, tail_type: 'medium' })),
        ...aiResult.long_tail.map((s: any) => ({ ...s, tail_type: 'long' })),
      ];
      for (const suggestion of aiSuggestions) {
        addSuggestion(
          String(suggestion.keyword || ''),
          suggestion.tail_type,
          suggestion.intent || 'commercial',
          Number(suggestion.relevance_score || 0.80),
          Number(suggestion.confidence || 0.75),
          suggestion.reason || 'Gerado por IA (Claude)',
        );
      }
    } else {
      // ── MODO DETERMINÍSTICO: zero créditos de IA ───────────────────────────
      stage = 'deterministic_generation';

      // 1. Search terms já convertidos (melhor fonte — intenção de compra confirmada)
      for (const metric of searchTermMetrics) {
        if (metric.orders < 1) continue;
        const confidence = Math.min(0.95, 0.65 + metric.orders * 0.08);
        const words = metric.term.split(' ').length;
        const tailType = words >= 4 ? 'long' : 'medium';
        addSuggestion(
          metric.term, tailType, 'high_purchase_intent',
          0.95, confidence,
          `Search term convertido: ${metric.orders} pedido(s), CPC R$${metric.cpc.toFixed(2)}`,
        );
      }

      // 2. TermBank para este ASIN (termos validados historicamente)
      for (const tb of termBankTerms as any[]) {
        if (tb.status !== 'active') continue;
        const words = String(tb.term || '').split(' ').length;
        const tailType = words >= 4 ? 'long' : 'medium';
        addSuggestion(
          String(tb.term || ''), tailType, 'commercial',
          0.88, 0.80,
          `TermBank: classificação ${tb.classification || 'active'}, score ${tb.performance_score || 0}`,
        );
      }

      // 3. N-grams do título (extração determinística)
      const titleNgrams = extractTitleNgrams(title);
      for (const ngram of titleNgrams) {
        const words = ngram.split(' ').length;
        const tailType = words >= 4 ? 'long' : 'medium';
        addSuggestion(
          ngram, tailType, 'commercial', 0.75, 0.65,
          `Extraído do título do produto: "${title.slice(0, 60)}"`,
        );
      }
    }

    // ── Gravar sugestões em lotes de 20 ──────────────────────────────────────
    stage = 'persist';
    let saved = 0;
    for (let i = 0; i < recordsToCreate.length; i += 20) {
      const batch = recordsToCreate.slice(i, i + 20);
      await base44.asServiceRole.entities.KeywordSuggestion.bulkCreate(batch);
      saved += batch.length;
    }

    const responseBody = {
      ok: true,
      action: 'keyword_suggestions_generated',
      mode: forceAI ? 'ai_claude' : 'deterministic',
      asin, product_id: product.id, amazon_account_id: accountId,
      total: saved, new_suggestions: saved,
      ai_credits_used: forceAI,
    };

    await writeLog(base44, {
      accountId, status: 'success', startedAt, asin, productId: product.id,
      stage: 'completed', message: 'Sugestões geradas.',
      details: responseBody,
    });

    return Response.json(responseBody);

  } catch (error: any) {
    if (base44) {
      await writeLog(base44, {
        accountId, status: 'error', startedAt, asin, productId, stage,
        message: error?.message || 'Erro ao gerar sugestões',
        details: { stack: String(error?.stack || '').slice(0, 1000) },
      });
    }
    return Response.json({ ok: false, error: error?.message, stage, asin, product_id: productId }, { status: 500 });
  }
});