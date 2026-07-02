/**
 * suggestProductKeywordsWithAI
 *
 * Gera sugestões de palavras-chave via OpenAI para um produto Amazon.
 * - 5 cauda média (2–4 palavras, intenção comercial)
 * - 5 cauda longa (5–9 palavras, alta intenção de compra)
 *
 * Nunca expõe a chave OpenAI ao frontend.
 * Nunca envia credenciais Amazon, refresh tokens ou dados pessoais à OpenAI.
 * Registra sugestões em KeywordSuggestion com deduplicação.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

// ── normalização ──────────────────────────────────────────────────────────────
function normalizeKeyword(kw) {
  return (kw || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remove acentos para comparação
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isSimilar(a, b) {
  const na = normalizeKeyword(a);
  const nb = normalizeKeyword(b);
  if (na === nb) return true;
  // Jaccard sobre tokens
  const ta = new Set(na.split(' '));
  const tb = new Set(nb.split(' '));
  const inter = [...ta].filter(t => tb.has(t)).length;
  const union = new Set([...ta, ...tb]).size;
  return union > 0 && inter / union >= 0.80;
}

// ── cálculo de bid ────────────────────────────────────────────────────────────
function calculateBid({ sourceCpc, sourceBid, avgProductCpc, price, convRate, targetAcos, minBid, maxBid }) {
  const candidates = [];
  if (sourceCpc > 0) candidates.push(sourceCpc * 1.10);
  if (sourceBid > 0) candidates.push(sourceBid);
  if (avgProductCpc > 0) candidates.push(avgProductCpc * 1.05);
  const maxProfitable = price && convRate && targetAcos
    ? price * convRate * (targetAcos / 100)
    : 0;
  if (maxProfitable > 0) candidates.push(maxProfitable);
  if (!candidates.length) {
    return { bid: Math.max(minBid || 0.30, 0.30), confidence: 'low', max_profitable_cpc: 0 };
  }
  const bid = Math.min(...candidates);
  const clamped = Math.max(Math.min(bid, maxBid || 5.0), minBid || 0.10);
  const confidence = sourceCpc > 0 ? 'high' : avgProductCpc > 0 ? 'medium' : 'low';
  return { bid: Math.round(clamped * 100) / 100, confidence, max_profitable_cpc: Math.round(maxProfitable * 100) / 100 };
}

// ── chamada OpenAI ────────────────────────────────────────────────────────────
async function callOpenAI(payload) {
  const apiKey = Deno.env.get('OPENAI_API_KEY');
  if (!apiKey) throw new Error('OPENAI_API_KEY não configurada no ambiente.');

  const systemPrompt = `Você é especialista em Amazon Ads Sponsored Products no marketplace brasileiro.

Analise o produto informado e sugira palavras-chave com intenção real de compra.

Gere exatamente:
- 5 palavras-chave de cauda média (2 a 4 palavras, intenção comercial);
- 5 palavras-chave de cauda longa (5 a 9 palavras, alta intenção de compra).

Regras obrigatórias:
1. As palavras devem representar como clientes reais pesquisariam pelo produto.
2. Não invente características que não estejam presentes no título, descrição ou bullet points.
3. Não inclua nomes de marcas concorrentes sem evidência.
4. Não repita termos já existentes em campanhas (lista: existing_keywords).
5. Não repita termos já negativados (lista: negative_keywords).
6. Não gere variações quase idênticas entre si.
7. Priorize intenção comercial e transacional.
8. Evite termos genéricos demais (ex: "produto", "comprar", "bom").
9. Para cauda média: entre 2 e 4 palavras.
10. Para cauda longa: preferencialmente entre 5 e 9 palavras.
11. Considere os termos reais de campanhas automáticas e manuais (existing_search_terms).
12. Quando existir termo convertido próximo, gere uma expansão semanticamente relacionada.
13. Classifique relevância (0–1), intenção de compra e confiança (0–1).
14. Explique brevemente por que cada termo pode converter.
15. Retorne apenas JSON válido, sem texto extra.

Formato de resposta:
{
  "medium_tail": [
    {
      "keyword": "...",
      "match_type": "exact",
      "intent": "commercial",
      "relevance_score": 0.95,
      "confidence": 0.91,
      "reason": "..."
    }
  ],
  "long_tail": [
    {
      "keyword": "...",
      "match_type": "exact",
      "intent": "high_purchase_intent",
      "relevance_score": 0.98,
      "confidence": 0.94,
      "reason": "..."
    }
  ]
}`;

  const userMessage = `Produto:
ASIN: ${payload.asin}
SKU: ${payload.sku || 'N/A'}
Título: ${payload.title || 'N/A'}
Categoria: ${payload.category || 'N/A'}
Marca: ${payload.brand || 'N/A'}
Preço: R$ ${payload.price || 'N/A'}
Descrição: ${payload.description || 'N/A'}
Bullet points: ${(payload.bullet_points || []).join(' | ') || 'N/A'}
Keywords já existentes: ${(payload.existing_keywords || []).slice(0, 30).join(', ') || 'nenhuma'}
Search terms reais: ${(payload.existing_search_terms || []).slice(0, 20).join(', ') || 'nenhum'}
Termos convertidos: ${(payload.converted_search_terms || []).slice(0, 10).join(', ') || 'nenhum'}
Keywords negativadas: ${(payload.negative_keywords || []).slice(0, 20).join(', ') || 'nenhuma'}
Marketplace: ${payload.marketplace || 'BR'}
Idioma: ${payload.language || 'pt-BR'}`;

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      temperature: 0.4,
      max_tokens: 1500,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`OpenAI erro ${res.status}: ${err.error?.message || 'desconhecido'}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || '';

  // Tentar parsear o JSON (com fallback de uma tentativa)
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    // tentar extrair JSON do texto
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Resposta da OpenAI não contém JSON válido.');
    parsed = JSON.parse(match[0]);
  }

  if (!Array.isArray(parsed.medium_tail) || !Array.isArray(parsed.long_tail)) {
    throw new Error('Estrutura JSON inválida: medium_tail e long_tail são obrigatórios.');
  }

  return parsed;
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
    const sym = account.currency_symbol || 'R$';

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
      return Response.json({ ok: false, error: 'Produto sem título. Sincronize os títulos antes de sugerir palavras-chave.', blocked: true });
    }

    // ── Carregar contexto ─────────────────────────────────────────────────
    const [campaigns, keywords, searchTerms, negatives, autopilotCfg] = await Promise.all([
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid, asin }, '-created_date', 20),
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: aid }, '-spend', 500),
      base44.asServiceRole.entities.SearchTerm.filter({ amazon_account_id: aid, advertised_asin: asin }, '-orders_14d', 200),
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: aid, state: 'archived' }, '-created_date', 200),
      base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: aid }),
    ]);

    const cfg = autopilotCfg[0] || {};
    const minBid = cfg.min_bid || 0.10;
    const maxBid = cfg.max_bid || 5.0;
    const targetAcos = cfg.target_acos || cfg.acos_target || 25;

    const campaignKeywords = keywords.filter(k => campaigns.some(c => c.campaign_id === k.campaign_id));
    const existingKeywordTexts = campaignKeywords.map(k => k.keyword_text || k.keyword || '').filter(Boolean);
    const convertedTerms = searchTerms.filter(st => (st.orders_14d || st.orders_7d || 0) >= 1).map(st => st.search_term || st.keyword_text || '').filter(Boolean);
    const negativeTexts = negatives.map(k => k.keyword_text || k.keyword || '').filter(Boolean);
    const allSearchTerms = searchTerms.map(st => st.search_term || st.keyword_text || '').filter(Boolean);

    // Métricas do produto para calcular bid
    const avgProductCpc = campaignKeywords.length > 0
      ? campaignKeywords.reduce((s, k) => s + (k.cpc || 0), 0) / campaignKeywords.length
      : 0;
    const convRate = product.conversion_rate_30d || 0.08; // fallback 8%
    const price = product.price || product.buy_box_price || 0;

    // ── Chamar OpenAI ─────────────────────────────────────────────────────
    const aiPayload = {
      asin,
      sku: product.sku || '',
      title,
      description: product.product_name || title,
      bullet_points: [],
      category: product.category || '',
      brand: product.brand || '',
      price,
      existing_keywords: existingKeywordTexts,
      existing_search_terms: allSearchTerms,
      converted_search_terms: convertedTerms,
      negative_keywords: negativeTexts,
      marketplace: account.country_code || 'BR',
      language: 'pt-BR',
    };

    const aiResult = await callOpenAI(aiPayload);

    // ── Buscar sugestões anteriores para deduplicação ─────────────────────
    const prevSuggestions = await base44.asServiceRole.entities.KeywordSuggestion.filter(
      { amazon_account_id: aid, asin }, '-created_at', 200
    );
    const prevTexts = prevSuggestions.map(s => s.keyword || '').filter(Boolean);

    // ── Processar sugestões ───────────────────────────────────────────────
    const now = new Date().toISOString();
    const toCreate = [];
    const allSuggestions = [
      ...aiResult.medium_tail.map(s => ({ ...s, tail_type: 'medium' })),
      ...aiResult.long_tail.map(s => ({ ...s, tail_type: 'long' })),
    ];

    for (const s of allSuggestions) {
      const kw = (s.keyword || '').toLowerCase().trim();
      if (!kw) continue;

      // Verificar duplicata contra existentes
      const alreadyInCampaign = existingKeywordTexts.some(e => isSimilar(e, kw));
      const alreadyPrev = prevTexts.some(e => isSimilar(e, kw));
      const isNegated = negativeTexts.some(n => isSimilar(n, kw));
      const similarPrev = prevSuggestions.find(ps => isSimilar(ps.keyword || '', kw));

      if (isNegated) continue; // nunca sugerir termos negativados

      let status = 'suggested';
      let alreadyExists = false;
      let duplicateOf = null;
      let blockReason = null;

      if (alreadyInCampaign) {
        status = 'duplicate';
        alreadyExists = true;
        blockReason = 'Keyword já existe em uma campanha deste produto.';
      } else if (alreadyPrev && similarPrev) {
        status = 'duplicate';
        alreadyExists = true;
        duplicateOf = similarPrev.id;
        blockReason = 'Sugestão semelhante já registrada anteriormente.';
      }

      // Calcular bid
      // Verificar se há CPC real deste search term
      const sourceSt = searchTerms.find(st => isSimilar(st.search_term || st.keyword_text || '', kw));
      const bidCalc = calculateBid({
        sourceCpc: sourceSt?.cpc || 0,
        sourceBid: 0,
        avgProductCpc,
        price,
        convRate,
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
        normalized_keyword: normalizeKeyword(kw),
        tail_type: s.tail_type,
        match_type: s.match_type || 'exact',
        intent: s.intent || 'commercial',
        relevance_score: s.relevance_score || 0,
        confidence: s.confidence || 0,
        reason: s.reason || '',
        source: 'OPENAI_TITLE_ANALYSIS',
        source_search_term_id: sourceSt?.id || null,
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

    // Criar em bloco
    let created = 0;
    for (let i = 0; i < toCreate.length; i += 20) {
      const batch = toCreate.slice(i, i + 20);
      const records = await base44.asServiceRole.entities.KeywordSuggestion.bulkCreate(batch);
      created += batch.length;
    }

    // Retornar sugestões agrupadas
    const suggestions = toCreate;
    const medium = suggestions.filter(s => s.tail_type === 'medium');
    const long = suggestions.filter(s => s.tail_type === 'long');
    const new_suggestions = suggestions.filter(s => s.status === 'suggested').length;
    const duplicates = suggestions.filter(s => s.status === 'duplicate').length;

    return Response.json({
      ok: true,
      total: suggestions.length,
      new_suggestions,
      duplicates,
      medium_tail: medium,
      long_tail: long,
      product_title: title,
      bid_context: { avg_product_cpc: avgProductCpc, conv_rate: convRate, price, target_acos: targetAcos },
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});