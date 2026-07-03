import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function wordCount(value) {
  return normalize(value).split(' ').filter(Boolean).length;
}

function similar(a, b) {
  const left = new Set(normalize(a).split(' ').filter(Boolean));
  const right = new Set(normalize(b).split(' ').filter(Boolean));
  if (!left.size || !right.size) return false;
  const intersection = [...left].filter((term) => right.has(term)).length;
  const union = new Set([...left, ...right]).size;
  return intersection / union >= 0.8;
}

async function webSearch(query) {
  const apiKey = Deno.env.get('SERPER_API_KEY');
  if (!apiKey || !query) return [];

  try {
    const response = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: {
        'X-API-KEY': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ q: query, gl: 'br', hl: 'pt-br', num: 10 }),
    });
    if (!response.ok) return [];
    const data = await response.json();
    return (data.organic || []).slice(0, 10).map((item) => ({
      title: item.title || '',
      snippet: item.snippet || '',
      position: item.position || 0,
    }));
  } catch {
    return [];
  }
}

async function callClaude(context) {
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY não configurada.');

  const prompt = `Você é especialista em pesquisa de intenção de compra e Amazon Ads no Brasil.

OBJETIVO
Gerar exatamente 4 palavras-chave novas para um experimento de anúncios.

FONTES PERMITIDAS
- título, descrição e atributos do produto;
- nomes e descrições de campanhas e anúncios da própria conta;
- palavras-chave, termos de pesquisa e métricas históricas da conta;
- resultados de pesquisa web comum fornecidos abaixo.

PROIBIDO
- consultar, raspar ou simular pesquisas públicas na Amazon;
- inventar características que não aparecem nas fontes;
- gerar palavras-chave de cauda curta;
- repetir palavras existentes, negativas ou muito semelhantes.

REGRAS
1. Priorize cauda longa com 5 a 9 palavras.
2. Cauda média só pode ter 3 ou 4 palavras e deve apresentar forte evidência de eficiência.
3. Nunca retorne termo com 1 ou 2 palavras.
4. Todas devem ter intenção comercial ou alta intenção de compra.
5. confidence é uma estimativa baseada nas evidências. Só use valor >= 0.95 quando houver forte recorrência, conversão histórica, frequência de busca externa ou aderência direta ao anúncio.
6. Retorne JSON válido, sem markdown.

FORMATO
{"suggestions":[{"keyword":"...","tail_type":"long","intent":"high_purchase_intent","confidence":0.95,"relevance_score":0.98,"frequency_score":0.9,"reason":"..."}]}

CONTEXTO
${JSON.stringify(context).slice(0, 20000)}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: Deno.env.get('ANTHROPIC_MODEL_FAST') || 'claude-haiku-4-5',
      max_tokens: 1200,
      temperature: 0.2,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || `Erro Anthropic ${response.status}`);

  const text = String(data?.content?.[0]?.text || '').trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('A IA não retornou JSON válido.');
  const parsed = JSON.parse(match[0]);
  return Array.isArray(parsed.suggestions) ? parsed.suggestions : [];
}

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const user = await base44.auth.me();
    if (!user) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });

    const body = await request.json().catch(() => ({}));
    const { amazon_account_id, asin, product_id } = body;
    if (!amazon_account_id || !asin) {
      return Response.json({ ok: false, error: 'amazon_account_id e asin são obrigatórios' }, { status: 400 });
    }

    let product = null;
    if (product_id) product = await base44.asServiceRole.entities.Product.get(product_id).catch(() => null);
    if (!product) {
      const products = await base44.asServiceRole.entities.Product.filter({ amazon_account_id, asin });
      product = products[0] || null;
    }
    if (!product) return Response.json({ ok: false, error: 'Produto não encontrado' }, { status: 404 });

    const [campaigns, keywords, searchTerms, previous] = await Promise.all([
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id, asin }, '-created_date', 100),
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id }, '-spend', 1000),
      base44.asServiceRole.entities.SearchTerm.filter({ amazon_account_id, advertised_asin: asin }, '-impressions', 500),
      base44.asServiceRole.entities.KeywordSuggestion.filter({ amazon_account_id, asin }, '-created_at', 300),
    ]);

    const campaignIds = new Set(campaigns.map((item) => String(item.campaign_id)));
    const productKeywords = keywords.filter((item) => campaignIds.has(String(item.campaign_id)));
    const existing = productKeywords.map((item) => item.keyword_text || item.keyword).filter(Boolean);
    const negative = productKeywords
      .filter((item) => String(item.state || item.status).toLowerCase() === 'archived' || item.negative === true)
      .map((item) => item.keyword_text || item.keyword)
      .filter(Boolean);

    const frequency = new Map();
    for (const term of searchTerms) {
      const text = normalize(term.search_term || term.keyword_text);
      if (!text) continue;
      const current = frequency.get(text) || { term: text, impressions: 0, clicks: 0, orders: 0, spend: 0, sales: 0 };
      current.impressions += Number(term.impressions || 0);
      current.clicks += Number(term.clicks || 0);
      current.orders += Number(term.orders_14d || term.orders_7d || term.orders || 0);
      current.spend += Number(term.spend || 0);
      current.sales += Number(term.sales_14d || term.sales_7d || term.sales || 0);
      frequency.set(text, current);
    }

    const accountSignals = [...frequency.values()]
      .map((item) => ({
        ...item,
        conversion_rate: item.clicks > 0 ? item.orders / item.clicks : 0,
        acos: item.sales > 0 ? item.spend / item.sales * 100 : 0,
      }))
      .sort((a, b) => b.orders - a.orders || b.impressions - a.impressions)
      .slice(0, 40);

    const title = product.product_name || product.display_name || asin;
    const description = product.description || product.product_description || product.bullet_points || product.features || '';
    const adDescriptions = campaigns.map((item) => ({
      name: item.name || item.campaign_name || '',
      objective: item.campaign_objective || item.objective || '',
      targeting_type: item.targeting_type || '',
      orders: Number(item.orders_30d || item.orders || 0),
      sales: Number(item.sales_30d || item.sales || 0),
      spend: Number(item.spend_30d || item.spend || 0),
      roas: Number(item.roas_30d || item.roas || 0),
      acos: Number(item.acos_30d || item.acos || 0),
    }));

    const webResults = await webSearch(`${title} comprar Brasil`);
    const suggestions = await callClaude({
      product: { asin, title, description, category: product.category || '', brand: product.brand || '' },
      account_ads: adDescriptions,
      account_search_frequency: accountSignals,
      existing_keywords: existing,
      negative_keywords: negative,
      web_results: webResults,
      web_search_used: webResults.length > 0,
    });

    const previousTexts = previous.map((item) => item.keyword).filter(Boolean);
    const accepted = [];
    for (const suggestion of suggestions) {
      const keyword = normalize(suggestion.keyword);
      const count = wordCount(keyword);
      if (!keyword || count < 3) continue;
      const tailType = count >= 5 ? 'long' : 'medium';
      if (tailType === 'medium' && Number(suggestion.frequency_score || 0) < 0.75) continue;
      if (Number(suggestion.confidence || 0) < 0.95) continue;
      if (existing.some((item) => similar(item, keyword))) continue;
      if (negative.some((item) => similar(item, keyword))) continue;
      if (previousTexts.some((item) => similar(item, keyword))) continue;
      if (accepted.some((item) => similar(item.keyword, keyword))) continue;

      accepted.push({ ...suggestion, keyword, tail_type: tailType });
      if (accepted.length === 4) break;
    }

    if (accepted.length < 4) {
      return Response.json({
        ok: false,
        blocked: true,
        error: `Foram encontradas apenas ${accepted.length} sugestões elegíveis. Nenhuma palavra de cauda curta foi aceita.`,
        eligible_count: accepted.length,
        web_search_used: webResults.length > 0,
      }, { status: 422 });
    }

    const now = new Date().toISOString();
    const records = [];
    for (const item of accepted) {
      const saved = await base44.asServiceRole.entities.KeywordSuggestion.create({
        amazon_account_id,
        product_id: product.id,
        asin,
        sku: product.sku || '',
        keyword: item.keyword,
        normalized_keyword: normalize(item.keyword),
        tail_type: item.tail_type,
        match_type: 'exact',
        intent: item.intent || 'high_purchase_intent',
        relevance_score: Number(item.relevance_score || 0.95),
        confidence: Number(item.confidence || 0.95),
        reason: item.reason || 'Estimativa baseada em frequência, dados da conta e aderência ao anúncio.',
        source: 'OPENAI_TITLE_ANALYSIS',
        status: 'suggested',
        already_exists: false,
        recommended_bid: 0.30,
        recommended_budget: 5,
        created_at: now,
      });
      records.push(saved);
    }

    return Response.json({
      ok: true,
      total: records.length,
      suggestions: records,
      long_tail: records.filter((item) => item.tail_type === 'long'),
      medium_tail: records.filter((item) => item.tail_type === 'medium'),
      short_tail: [],
      policy: 'sem_cauda_curta_prioridade_cauda_longa',
      web_search_used: webResults.length > 0,
      account_signals_analyzed: accountSignals.length,
      campaigns_analyzed: campaigns.length,
    });
  } catch (error) {
    return Response.json({ ok: false, error: error?.message || 'Erro ao gerar sugestões' }, { status: 500 });
  }
});
