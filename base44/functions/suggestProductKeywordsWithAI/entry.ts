/**
 * suggestProductKeywordsWithAI — v2 (Claude / Anthropic)
 *
 * Cruza dados reais do produto com histórico de search terms para gerar
 * sugestões de palavras-chave refinadas via Claude.
 *
 * Fluxo:
 *   1. Carrega produto, campanhas, keywords, search terms e configuração
 *   2. Constrói métricas reais (CPC, conversão, ACoS por termo)
 *   3. Envia contexto enriquecido ao Claude
 *   4. Valida deduplicação e calcula bid baseado em dados reais
 *   5. Persiste em KeywordSuggestion e retorna com IDs
 *
 * NUNCA envia: tokens Amazon, refresh tokens, credenciais ou PII.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

// ── normalização ──────────────────────────────────────────────────────────────
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
  if (na === nb) return true;
  const ta = new Set(na.split(' ')), tb = new Set(nb.split(' '));
  const inter = [...ta].filter(t => tb.has(t)).length;
  const union = new Set([...ta, ...tb]).size;
  return union > 0 && inter / union >= 0.80;
}

// ── cálculo de bid refinado ───────────────────────────────────────────────────
function calcBid({ stCpc, stAcos, stConvRate, avgCpc, price, targetAcos, minBid, maxBid }) {
  const candidates = [];

  // Bid baseado no CPC real do search term similar (mais confiável)
  if (stCpc > 0) candidates.push(stCpc * 1.10);

  // Bid rentável: preço × taxa de conversão × (target_acos / 100)
  const convRate = stConvRate > 0 ? stConvRate : 0.08;
  if (price > 0 && targetAcos > 0) {
    const maxProfitable = price * convRate * (targetAcos / 100);
    if (maxProfitable > 0) candidates.push(maxProfitable);
  }

  // CPC médio das keywords do produto como referência
  if (avgCpc > 0) candidates.push(avgCpc * 1.05);

  // Ajuste por ACoS real: se ACoS do termo > target, reduz bid proporcional
  if (stAcos > 0 && stAcos > targetAcos && stCpc > 0) {
    const adjustedBid = stCpc * (targetAcos / stAcos);
    candidates.push(adjustedBid);
  }

  if (!candidates.length) {
    return { bid: Math.max(minBid, 0.30), confidence: 'low', max_profitable_cpc: 0 };
  }

  const rawBid = Math.min(...candidates);
  const clamped = Math.max(Math.min(rawBid, maxBid), minBid);
  const maxProfitable = price > 0 ? Math.round(price * convRate * (targetAcos / 100) * 100) / 100 : 0;
  const confidence = stCpc > 0 ? 'high' : avgCpc > 0 ? 'medium' : 'low';

  return { bid: Math.round(clamped * 100) / 100, confidence, max_profitable_cpc: maxProfitable };
}

// ── chamada Claude (Anthropic) ────────────────────────────────────────────────
async function callClaude(payload) {
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY não configurada. Configure em Settings → Environment Variables.');

  const model = Deno.env.get('ANTHROPIC_MODEL_FAST') || 'claude-haiku-4-5';

  const systemPrompt = `Você é especialista em Amazon Ads Sponsored Products no marketplace brasileiro (amazon.com.br).

Sua tarefa: analisar dados reais de um produto e seus search terms históricos para sugerir exatamente 10 palavras-chave novas — 5 de cauda média e 5 de cauda longa — com alta intenção de compra.

REGRAS OBRIGATÓRIAS:
1. Use SOMENTE características presentes no título e categoria do produto.
2. Priorize expansões semânticas dos termos que já converteram (converted_terms).
3. NÃO repita termos já existentes em campanhas (existing_keywords).
4. NÃO repita termos negativados (negative_keywords).
5. NÃO gere variações quase idênticas entre si (similaridade Jaccard > 80%).
6. Cauda média: 2 a 4 palavras, intenção comercial ou transacional.
7. Cauda longa: 5 a 9 palavras, alta especificidade e intenção de compra.
8. Evite termos genéricos demais (ex: "produto bom", "comprar online").
9. Se um search term histórico tem alta conversão, crie uma expansão direta.
10. Classifique: relevance_score (0–1), confidence (0–1), intent.
11. Explique brevemente por que o termo pode converter (reason).
12. Retorne APENAS JSON válido, sem texto extra, sem markdown.

FORMATO EXATO:
{
  "medium_tail": [
    {"keyword": "...", "match_type": "exact", "intent": "commercial", "relevance_score": 0.95, "confidence": 0.90, "reason": "..."}
  ],
  "long_tail": [
    {"keyword": "...", "match_type": "exact", "intent": "high_purchase_intent", "relevance_score": 0.97, "confidence": 0.88, "reason": "..."}
  ]
}`;

  // Montar contexto com métricas reais dos search terms
  const stContext = payload.search_term_metrics.slice(0, 15).map(st =>
    `  "${st.term}": cliques=${st.clicks}, pedidos=${st.orders}, spend=R$${st.spend.toFixed(2)}, acos=${st.acos.toFixed(1)}%, cpc=R$${st.cpc.toFixed(2)}, conv=${(st.conv_rate * 100).toFixed(1)}%`
  ).join('\n');

  const convertedContext = payload.converted_terms.slice(0, 10).map(t =>
    `  "${t.term}" (${t.orders} pedidos, ACoS ${t.acos.toFixed(1)}%)`
  ).join('\n');

  const userMessage = `PRODUTO:
ASIN: ${payload.asin}
SKU: ${payload.sku || 'N/A'}
Título: ${payload.title}
Categoria: ${payload.category || 'N/A'}
Marca: ${payload.brand || 'N/A'}
Preço: R$ ${payload.price || 'N/A'}
Estoque: ${payload.inventory_status || 'N/A'}

MÉTRICAS DO PRODUTO (30 dias):
CPC médio das keywords: R$ ${payload.avg_cpc.toFixed(2)}
Taxa de conversão média: ${(payload.avg_conv_rate * 100).toFixed(1)}%
ACoS médio das campanhas: ${payload.avg_acos.toFixed(1)}%
Target ACoS configurado: ${payload.target_acos}%

TERMOS QUE JÁ CONVERTERAM (prioridade máxima para expansão):
${convertedContext || '  nenhum ainda'}

TOP SEARCH TERMS HISTÓRICOS COM MÉTRICAS REAIS:
${stContext || '  nenhum disponível'}

KEYWORDS JÁ EM CAMPANHA (não repetir):
${payload.existing_keywords.slice(0, 30).join(', ') || 'nenhuma'}

KEYWORDS NEGATIVADAS (não sugerir):
${payload.negative_keywords.slice(0, 20).join(', ') || 'nenhuma'}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
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

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Anthropic erro ${res.status}: ${err.error?.message || JSON.stringify(err)}`);
  }

  const data = await res.json();
  const content = (data.content?.[0]?.text || '').trim();

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

  return { ...parsed, model_used: model, input_tokens: data.usage?.input_tokens, output_tokens: data.usage?.output_tokens };
}

// ═══════════════════════════════════════════════════════════════════════════════
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { amazon_account_id, asin, product_id } = body;
    if (!asin) return Response.json({ ok: false, error: 'asin obrigatório' }, { status: 400 });

    // ── Resolver conta ────────────────────────────────────────────────────
    let account = null;
    if (amazon_account_id) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: amazon_account_id });
      account = accs[0] || null;
    } else {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      account = accs[0] || null;
    }
    if (!account) return Response.json({ ok: false, error: 'Conta Amazon não encontrada.' });
    const aid = account.id;

    // ── Carregar produto ──────────────────────────────────────────────────
    let product = null;
    if (product_id) {
      const prods = await base44.asServiceRole.entities.Product.filter({ id: product_id });
      product = prods[0] || null;
    }
    if (!product) {
      const prods = await base44.asServiceRole.entities.Product.filter({ amazon_account_id: aid, asin });
      product = prods[0] || null;
    }
    if (!product) return Response.json({ ok: false, error: `Produto ${asin} não encontrado.` });

    const title = product.product_name || product.display_name || '';
    if (!title.trim()) {
      return Response.json({ ok: false, blocked: true, error: 'Produto sem título. Sincronize os títulos antes de gerar sugestões.' });
    }

    // ── Carregar contexto em paralelo ─────────────────────────────────────
    const [campaigns, allKeywords, searchTerms, autopilotCfg, prevSuggestions] = await Promise.all([
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid, asin }, '-created_date', 30),
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: aid }, '-spend', 600),
      base44.asServiceRole.entities.SearchTerm.filter({ amazon_account_id: aid, advertised_asin: asin }, '-orders_14d', 300),
      base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: aid }),
      base44.asServiceRole.entities.KeywordSuggestion.filter({ amazon_account_id: aid, asin }, '-created_at', 200),
    ]);

    const cfg = autopilotCfg[0] || {};
    const minBid    = cfg.min_bid     || 0.10;
    const maxBid    = cfg.max_bid     || 5.0;
    const targetAcos = cfg.target_acos || cfg.acos_target || 25;

    // ── Métricas reais das keywords do produto ────────────────────────────
    const campaignIds = new Set(campaigns.map(c => c.campaign_id));
    const productKeywords = allKeywords.filter(k => campaignIds.has(k.campaign_id) && k.state !== 'archived');
    const negativeKeywords = allKeywords.filter(k => k.state === 'archived' || k.status === 'archived');

    const avgCpc = productKeywords.length > 0
      ? productKeywords.reduce((s, k) => s + (k.cpc || 0), 0) / productKeywords.length
      : 0;

    const kWithConv = productKeywords.filter(k => k.clicks > 0);
    const avgConvRate = kWithConv.length > 0
      ? kWithConv.reduce((s, k) => s + ((k.orders || 0) / (k.clicks || 1)), 0) / kWithConv.length
      : (product.conversion_rate_30d || 0.08);

    const kWithAcos = productKeywords.filter(k => k.acos > 0);
    const avgAcos = kWithAcos.length > 0
      ? kWithAcos.reduce((s, k) => s + (k.acos || 0), 0) / kWithAcos.length
      : 0;

    const existingKeywordTexts = productKeywords.map(k => k.keyword_text || k.keyword || '').filter(Boolean);
    const negativeTexts = negativeKeywords.map(k => k.keyword_text || k.keyword || '').filter(Boolean);

    // ── Enriquecer search terms com métricas reais ────────────────────────
    // Agregar por termo (pode haver múltiplas datas)
    const stAgg = new Map();
    for (const st of searchTerms) {
      const term = (st.search_term || st.keyword_text || '').toLowerCase().trim();
      if (!term) continue;
      const existing = stAgg.get(term) || { term, clicks: 0, orders: 0, spend: 0, sales: 0, impressions: 0 };
      existing.clicks     += st.clicks      || 0;
      existing.orders     += st.orders_14d  || st.orders_7d || 0;
      existing.spend      += st.spend       || 0;
      existing.sales      += st.sales_14d   || st.sales_7d  || 0;
      existing.impressions += st.impressions || 0;
      stAgg.set(term, existing);
    }

    const stMetrics = [...stAgg.values()].map(st => ({
      term: st.term,
      clicks: st.clicks,
      orders: st.orders,
      spend: st.spend,
      acos: st.sales > 0 ? (st.spend / st.sales) * 100 : 0,
      cpc: st.clicks > 0 ? st.spend / st.clicks : 0,
      conv_rate: st.clicks > 0 ? st.orders / st.clicks : 0,
    })).sort((a, b) => b.orders - a.orders || b.clicks - a.clicks);

    // Termos com conversão real
    const convertedTerms = stMetrics
      .filter(st => st.orders >= 1)
      .map(st => ({ term: st.term, orders: st.orders, acos: st.acos }));

    // ── Chamar Claude ─────────────────────────────────────────────────────
    const aiPayload = {
      asin,
      sku: product.sku || '',
      title,
      category: product.category || '',
      brand: product.brand || '',
      price: product.price || product.buy_box_price || 0,
      inventory_status: product.inventory_status || 'unknown',
      avg_cpc: avgCpc,
      avg_conv_rate: avgConvRate,
      avg_acos: avgAcos,
      target_acos: targetAcos,
      search_term_metrics: stMetrics,
      converted_terms: convertedTerms,
      existing_keywords: existingKeywordTexts,
      negative_keywords: negativeTexts,
    };

    const aiResult = await callClaude(aiPayload);

    // ── Processar + deduplicar + calcular bids ────────────────────────────
    const prevTexts = prevSuggestions.map(s => s.keyword || '');
    const now = new Date().toISOString();
    const price = product.price || product.buy_box_price || 0;

    const allSuggestions = [
      ...aiResult.medium_tail.map(s => ({ ...s, tail_type: 'medium' })),
      ...aiResult.long_tail.map(s => ({ ...s, tail_type: 'long' })),
    ];

    const toCreate = [];
    for (const s of allSuggestions) {
      const kw = (s.keyword || '').toLowerCase().trim();
      if (!kw) continue;

      // Nunca sugerir negativados
      if (negativeTexts.some(n => isSimilar(n, kw))) continue;

      let status = 'suggested';
      let alreadyExists = false;
      let duplicateOf = null;
      let blockReason = null;

      if (existingKeywordTexts.some(e => isSimilar(e, kw))) {
        status = 'duplicate'; alreadyExists = true;
        blockReason = 'Keyword já existe em campanha deste produto.';
      } else {
        const simPrev = prevSuggestions.find(ps => isSimilar(ps.keyword || '', kw));
        if (simPrev) {
          status = 'duplicate'; alreadyExists = true;
          duplicateOf = simPrev.id;
          blockReason = 'Sugestão semelhante já registrada anteriormente.';
        }
      }

      // Cruzar com métricas reais do search term mais próximo
      const sourceSt = stMetrics.find(st => isSimilar(st.term, kw));
      const sourceStRaw = searchTerms.find(st => {
        const t = (st.search_term || st.keyword_text || '').toLowerCase().trim();
        return isSimilar(t, kw);
      });

      const bidCalc = calcBid({
        stCpc: sourceSt?.cpc || 0,
        stAcos: sourceSt?.acos || 0,
        stConvRate: sourceSt?.conv_rate || 0,
        avgCpc,
        price,
        targetAcos,
        minBid,
        maxBid,
      });

      toCreate.push({
        amazon_account_id: aid,
        product_id: product.id,
        asin,
        sku: product.sku || '',
        keyword: kw,
        normalized_keyword: norm(kw),
        tail_type: s.tail_type,
        match_type: s.match_type || 'exact',
        intent: s.intent || 'commercial',
        relevance_score: s.relevance_score || 0,
        confidence: s.confidence || 0,
        reason: s.reason || '',
        source: 'OPENAI_TITLE_ANALYSIS', // mantém enum compatível
        source_search_term_id: sourceStRaw?.id || null,
        status,
        already_exists: alreadyExists,
        duplicate_of: duplicateOf,
        block_reason: blockReason,
        recommended_bid: bidCalc.bid,
        recommended_budget: 5.00,
        maximum_profitable_cpc: bidCalc.max_profitable_cpc,
        bid_confidence: bidCalc.confidence,
        created_at: now,
      });
    }

    // ── Persistir ─────────────────────────────────────────────────────────
    const savedRecords = [];
    for (let i = 0; i < toCreate.length; i += 20) {
      const batch = toCreate.slice(i, i + 20);
      const records = await base44.asServiceRole.entities.KeywordSuggestion.bulkCreate(batch);
      savedRecords.push(...(Array.isArray(records) ? records : batch));
    }

    // Enriquecer com IDs persistidos para o frontend criar campanhas
    const withIds = toCreate.map((s, i) => ({ ...s, id: savedRecords[i]?.id || null }));

    const medium = withIds.filter(s => s.tail_type === 'medium');
    const long = withIds.filter(s => s.tail_type === 'long');

    return Response.json({
      ok: true,
      total: withIds.length,
      new_suggestions: withIds.filter(s => s.status === 'suggested').length,
      duplicates: withIds.filter(s => s.status === 'duplicate').length,
      medium_tail: medium,
      long_tail: long,
      product_title: title,
      model_used: aiResult.model_used,
      tokens: { input: aiResult.input_tokens, output: aiResult.output_tokens },
      bid_context: {
        avg_cpc: avgCpc,
        avg_conv_rate: avgConvRate,
        avg_acos: avgAcos,
        price,
        target_acos: targetAcos,
        converted_terms_count: convertedTerms.length,
        search_terms_analyzed: stMetrics.length,
      },
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});