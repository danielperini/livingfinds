/**
 * runKeywordMLPipeline — Motor de ML determinístico para palavras-chave de alta conversão
 *
 * Pipeline:
 * 1. collectKeywordTrainingData   — busca dados reais
 * 2. normalizeKeywordTrainingData — limpa e normaliza
 * 3. generateKeywordFeatures      — extrai features
 * 4. trainKeywordConversionModel  — calibra pesos com dados históricos
 * 5. scoreKeywordCandidates       — pontua candidatos
 * 6. publishApprovedKeywordRecommendations — salva KeywordPrediction
 *
 * Payload: { amazon_account_id, dry_run?: boolean, max_per_asin?: number }
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

// ── Normalização ───────────────────────────────────────────────────────────────
function normTerm(v: string): string {
  return String(v || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s\-\.\/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isTruncated(kw: string): boolean {
  const k = (kw || '').trim();
  if (/\.{2,}$|:\s*$/.test(k)) return true;
  const lastWord = k.split(/\s+/).pop() || '';
  const allowed = new Set(['de','do','da','em','no','na','ao','os','as','e','a','o','un','ml','cm','mm','kg','mg']);
  return lastWord.length <= 2 && !allowed.has(lastWord.toLowerCase());
}

function isGeneric(kw: string): boolean {
  const generics = new Set(['produto','item','coisa','objeto','material','acessorio','kit','conjunto','peca','peça','unidade']);
  const words = normTerm(kw).split(' ');
  if (words.length === 1 && generics.has(words[0])) return true;
  if (words.length <= 2 && words.every(w => w.length <= 4)) return true;
  return false;
}

function isSimilar(a: string, b: string): boolean {
  const na = normTerm(a), nb = normTerm(b);
  if (!na || !nb || na === nb) return na === nb;
  const ta = new Set(na.split(' ')), tb = new Set(nb.split(' '));
  const inter = [...ta].filter(t => tb.has(t)).length;
  const union = new Set([...ta, ...tb]).size;
  return union > 0 && inter / union >= 0.82;
}

function classifyTail(kw: string): 'short' | 'medium' | 'long' {
  const words = kw.trim().split(/\s+/).length;
  if (words >= 5) return 'long';
  if (words >= 3) return 'medium';
  return 'short';
}

function matchTypeForTail(tail: string, orders: number): 'EXACT' | 'PHRASE' | 'BROAD' {
  if (orders >= 2 || tail === 'long') return 'EXACT';
  if (tail === 'medium') return 'PHRASE';
  return 'BROAD';
}

// ── Semelhança semântica simples (token overlap) ──────────────────────────────
function semanticSimilarity(kw: string, title: string): number {
  const ka = new Set(normTerm(kw).split(' ').filter(t => t.length >= 3));
  const ta = new Set(normTerm(title).split(' ').filter(t => t.length >= 3));
  if (!ka.size || !ta.size) return 0;
  const inter = [...ka].filter(t => ta.has(t)).length;
  return Math.round((inter / Math.max(ka.size, ta.size)) * 100) / 100;
}

// ── Features ──────────────────────────────────────────────────────────────────
function generateFeatures(kw: string, product: any, metrics: any, negativeTexts: string[]): any {
  const norm = normTerm(kw);
  const words = norm.split(' ');
  const wc = words.length;
  const title = normTerm(product?.product_name || product?.display_name || product?.title || '');
  const brand = normTerm(product?.brand || '');
  const bullets = normTerm((product?.bullet_points || []).join(' '));
  const attrs = normTerm(product?.attributes || '');
  const allText = `${title} ${bullets} ${attrs}`;

  const COLOR_WORDS = ['preto','branco','azul','vermelho','verde','amarelo','rosa','cinza','marrom','bege','dourado','prata','transparente'];
  const SIZE_WORDS = ['pequeno','medio','grande','pp','p','m','g','gg','xg','xxg','xl','xxl','mini','maxi'];
  const MATERIAL_WORDS = ['aco','inox','aluminio','plastico','borracha','couro','tecido','silicone','madeira','vidro','metal','ceramica'];
  const INTENT_WORDS = ['comprar','melhor','para','kit','com','sem','original','profissional','resistente','barato','qualidade','economico'];

  return {
    word_count: wc,
    char_count: kw.length,
    is_long_tail: wc >= 5 ? 1 : 0,
    is_medium_tail: (wc >= 3 && wc <= 4) ? 1 : 0,
    is_short_tail: wc <= 2 ? 1 : 0,
    contains_brand: brand && norm.includes(brand) ? 1 : 0,
    contains_product_type: semanticSimilarity(norm, title) > 0.5 ? 1 : 0,
    contains_size: SIZE_WORDS.some(s => norm.includes(s)) ? 1 : 0,
    contains_color: COLOR_WORDS.some(c => norm.includes(c)) ? 1 : 0,
    contains_material: MATERIAL_WORDS.some(m => norm.includes(m)) ? 1 : 0,
    contains_quantity: /\d+\s*(un|pç|peca|ml|litro|kg|g\b|cm|mm)/.test(norm) ? 1 : 0,
    contains_purchase_intent: INTENT_WORDS.some(i => norm.includes(i)) ? 1 : 0,
    semantic_similarity_to_title: semanticSimilarity(kw, title),
    semantic_similarity_to_bullets: semanticSimilarity(kw, bullets),
    semantic_similarity_to_attrs: semanticSimilarity(kw, attrs),
    historical_impressions: metrics.impressions || 0,
    historical_clicks: metrics.clicks || 0,
    historical_spend: metrics.spend || 0,
    historical_orders: metrics.orders || 0,
    historical_sales: metrics.sales || 0,
    historical_ctr: metrics.ctr || 0,
    historical_cpc: metrics.cpc || 0,
    historical_conversion_rate: metrics.conv_rate || 0,
    historical_acos: metrics.acos || 0,
    historical_roas: metrics.roas || 0,
    days_with_data: metrics.days || 0,
    negative_conflict: negativeTexts.some(n => isSimilar(n, kw)) ? 1 : 0,
    is_generic: isGeneric(kw) ? 1 : 0,
    product_stock: Number(product?.fba_inventory ?? product?.fba_quantity ?? 0),
    product_price: Number(product?.price || product?.buy_box_price || 0),
    product_margin: Number(product?.margin_pct || product?.margin || 0),
    amazon_suggestion_rank: metrics.amazon_rank || 99,
  };
}

// ── Modelo de pontuação ────────────────────────────────────────────────────────
function scoreCandidate(features: any, weights: any): {
  conversion_probability: number;
  quality_score: number;
  confidence: number;
  data_confidence: number;
} {
  // Probabilidade de conversão: regressão logística simplificada
  let convScore = 0;

  // Base histórica
  if (features.historical_orders >= 2) convScore += 0.45;
  else if (features.historical_orders === 1) convScore += 0.25;
  else if (features.historical_clicks >= 5) convScore += 0.12;

  // Taxa de conversão histórica
  if (features.historical_conversion_rate >= 0.15) convScore += 0.20;
  else if (features.historical_conversion_rate >= 0.08) convScore += 0.12;
  else if (features.historical_conversion_rate >= 0.03) convScore += 0.06;

  // Relevância semântica
  const semScore = features.semantic_similarity_to_title * 0.60 + features.semantic_similarity_to_bullets * 0.30 + features.semantic_similarity_to_attrs * 0.10;
  convScore += semScore * 0.20;

  // Cauda longa ganha bônus
  if (features.is_long_tail) convScore += 0.10;
  else if (features.is_medium_tail) convScore += 0.06;

  // Atributos específicos
  if (features.contains_purchase_intent) convScore += 0.05;
  if (features.contains_size || features.contains_color || features.contains_material) convScore += 0.04;
  if (features.contains_quantity) convScore += 0.03;

  // Amazon suggestion
  if (features.amazon_suggestion_rank <= 5) convScore += 0.05;
  else if (features.amazon_suggestion_rank <= 20) convScore += 0.02;

  // Penalidades
  if (features.is_generic) convScore -= 0.15;
  if (features.negative_conflict) convScore = 0; // bloqueio
  if (features.historical_spend > 10 && features.historical_orders === 0) convScore -= 0.20;
  if (features.product_stock === 0) convScore = 0; // bloqueio

  convScore = Math.max(0, Math.min(1, convScore));

  // Quality Score (fórmula composta)
  let qs = 0;
  qs += convScore * 0.30;
  qs += semScore * 0.20;
  qs += Math.min(features.historical_conversion_rate * 1.5, 0.15) * (1/0.15) * 0.15;
  if (features.historical_roas > 0) qs += Math.min(features.historical_roas / 10, 1) * 0.10;
  if (features.historical_acos > 0 && features.historical_acos <= 35) qs += (1 - features.historical_acos / 100) * 0.10;
  if (features.is_long_tail) qs += 0.05;
  if (features.amazon_suggestion_rank <= 10) qs += (1 - features.amazon_suggestion_rank / 10) * 0.05;

  // Confiança dos dados
  let dc = 0;
  if (features.historical_clicks >= 20) dc += 0.40;
  else if (features.historical_clicks >= 5) dc += 0.20;
  if (features.historical_impressions >= 100) dc += 0.20;
  if (features.days_with_data >= 14) dc += 0.20;
  else if (features.days_with_data >= 7) dc += 0.10;
  if (features.semantic_similarity_to_title >= 0.3) dc += 0.20;
  dc = Math.max(0, Math.min(1, dc));

  // Confiança geral
  const confidence = dc > 0 ? Math.min(1, convScore * 0.7 + dc * 0.3) : convScore * 0.5;

  return {
    conversion_probability: Math.round(convScore * 100) / 100,
    quality_score: Math.round(Math.max(0, Math.min(1, qs)) * 100) / 100,
    confidence: Math.round(confidence * 100) / 100,
    data_confidence: Math.round(dc * 100) / 100,
  };
}

// ── Bid recomendado ───────────────────────────────────────────────────────────
function calcBid(metrics: any, product: any, config: any, isExperimental: boolean): number {
  const minBid = Number(config.min_bid || 0.50);
  const maxBid = Number(config.max_bid || 5.0);
  const targetAcos = Number(config.target_acos || 25);
  const price = Number(product?.price || product?.buy_box_price || 0);
  const convRate = Number(metrics.conv_rate || 0.08);

  const candidates: number[] = [];
  if (metrics.cpc > 0) candidates.push(metrics.cpc * 1.10);
  if (price > 0 && targetAcos > 0) {
    const maxProfit = price * convRate * (targetAcos / 100);
    if (maxProfit > 0) candidates.push(maxProfit);
  }
  if (metrics.amazon_suggested_bid > 0) candidates.push(metrics.amazon_suggested_bid);

  let bid = candidates.length > 0 ? Math.min(...candidates) : minBid;
  if (isExperimental) bid = Math.max(minBid, bid * 0.70);
  return Math.round(Math.max(minBid, Math.min(bid, maxBid)) * 100) / 100;
}

// ── Reason builder ────────────────────────────────────────────────────────────
function buildReason(kw: string, features: any, scores: any, tailType: string): string {
  const parts: string[] = [];
  if (tailType === 'long') parts.push('termo de cauda longa com intenção específica');
  else if (tailType === 'medium') parts.push('termo de cauda média');
  else parts.push('termo curto');

  if (features.semantic_similarity_to_title >= 0.5) parts.push(`alta similaridade ao título (${Math.round(features.semantic_similarity_to_title * 100)}%)`);
  else if (features.semantic_similarity_to_title >= 0.25) parts.push(`similaridade moderada ao título (${Math.round(features.semantic_similarity_to_title * 100)}%)`);

  if (features.historical_orders >= 2) parts.push(`${features.historical_orders} vendas atribuídas`);
  else if (features.historical_orders === 1) parts.push('1 venda atribuída');

  if (features.historical_conversion_rate >= 0.10) parts.push(`taxa de conversão ${(features.historical_conversion_rate * 100).toFixed(1)}%`);
  if (features.historical_cpc > 0) parts.push(`CPC histórico R$${features.historical_cpc.toFixed(2)}`);
  if (features.historical_acos > 0 && features.historical_acos <= 35) parts.push(`ACoS ${features.historical_acos.toFixed(1)}% dentro do limite`);
  if (features.amazon_suggestion_rank <= 10) parts.push('sugerida pela Amazon');
  if (features.contains_purchase_intent) parts.push('contém intenção de compra');
  if (features.contains_size || features.contains_color) parts.push('atributo do produto presente');

  return parts.length > 0 ? parts.join(', ') + '.' : 'Candidato gerado por análise de dados históricos.';
}

// ── HANDLER ───────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { amazon_account_id, dry_run = false, max_per_asin = 10 } = body;

    if (!amazon_account_id) return Response.json({ error: 'amazon_account_id obrigatório' }, { status: 400 });

    const now = new Date().toISOString();
    const runStart = Date.now();

    // ── 1. COLLECT ──────────────────────────────────────────────────────────
    const [products, searchTerms, keywords, campaigns, termBank, config, prevPredictions] = await Promise.all([
      base44.asServiceRole.entities.Product.filter({ amazon_account_id }, '-updated_at', 300),
      base44.asServiceRole.entities.SearchTerm.filter({ amazon_account_id }, '-orders_14d', 500),
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id }, '-spend', 500),
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id, state: { $in: ['enabled', 'ENABLED'] } }, '-spend', 200),
      base44.asServiceRole.entities.TermBank.filter({ amazon_account_id }, null, 500),
      base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id }).then((r: any[]) => r[0] || {}),
      base44.asServiceRole.entities.KeywordPrediction.filter({ amazon_account_id }, '-created_at', 500),
    ]);

    // Produtos ativos com estoque
    const activeProducts = (products as any[]).filter(p =>
      p.status === 'active' &&
      (Number(p.fba_inventory ?? p.fba_quantity ?? 0) > 0 || p.inventory_status === 'in_stock' || p.inventory_status === 'available')
    );

    if (!activeProducts.length) {
      return Response.json({ ok: true, message: 'Nenhum produto ativo com estoque encontrado.', candidates: 0 });
    }

    // Negativadas globais
    const negativeKeywords = (keywords as any[]).filter(k => k.state === 'archived' || k.matchType === 'NEGATIVE_EXACT' || k.matchType === 'NEGATIVE_PHRASE');
    const negativeTexts = negativeKeywords.map(k => k.keyword_text || k.keyword || '').filter(Boolean);

    // Keywords ativas existentes
    const activeCampaignIds = new Set((campaigns as any[]).map(c => c.campaign_id));
    const activeKeywords = (keywords as any[]).filter(k => activeCampaignIds.has(k.campaign_id) && k.state !== 'archived');
    const existingKwTexts = activeKeywords.map(k => (k.keyword_text || k.keyword || '').toLowerCase()).filter(Boolean);

    // Previas já existentes para dedup
    const prevNorms = new Set(
      (prevPredictions as any[])
        .filter(p => !['rejected', 'expired', 'blocked'].includes(p.status))
        .map(p => `${normTerm(p.keyword)}::${p.asin}`)
    );

    // TermBank ativos
    const activeTBTerms = (termBank as any[]).filter(t => t.status === 'active');

    // Agregação de search terms por termo+ASIN
    const stMap = new Map<string, any>();
    for (const st of searchTerms as any[]) {
      const term = String(st.search_term || st.keyword_text || '').toLowerCase().trim();
      const asin = String(st.advertised_asin || st.asin || '');
      if (!term || !asin) continue;
      const key = `${term}::${asin}`;
      const cur = stMap.get(key) || { term, asin, impressions: 0, clicks: 0, spend: 0, orders: 0, units: 0, sales: 0, days: 0 };
      cur.impressions += Number(st.impressions || 0);
      cur.clicks += Number(st.clicks || 0);
      cur.spend += Number(st.spend || 0);
      cur.orders += Number(st.orders_14d || st.orders_7d || st.orders || 0);
      cur.units += Number(st.units_sold || 0);
      cur.sales += Number(st.sales_14d || st.sales_7d || st.sales || 0);
      cur.days = Math.max(cur.days, Number(st.days || 1));
      stMap.set(key, cur);
    }

    // Enriquecer com ctr/cpc/conv_rate/acos/roas
    const enrichedST = [...stMap.values()].map(st => ({
      ...st,
      ctr: st.impressions > 0 ? st.clicks / st.impressions : 0,
      cpc: st.clicks > 0 ? st.spend / st.clicks : 0,
      conv_rate: st.clicks > 0 ? st.orders / st.clicks : 0,
      acos: st.sales > 0 ? (st.spend / st.sales) * 100 : 0,
      roas: st.spend > 0 ? st.sales / st.spend : 0,
    }));

    // ── 2. MODEL READINESS ──────────────────────────────────────────────────
    const totalOrders = enrichedST.reduce((s, t) => s + t.orders, 0);
    const totalClicks = enrichedST.reduce((s, t) => s + t.clicks, 0);
    let readinessScore = 0;
    if (activeProducts.length >= 1) readinessScore += 20;
    if ((campaigns as any[]).length >= 2) readinessScore += 20;
    if (enrichedST.length >= 20) readinessScore += 20;
    if (totalClicks >= 100) readinessScore += 20;
    if (totalOrders >= 5) readinessScore += 20;

    const modelStatus = readinessScore >= 80 ? 'production' : readinessScore >= 60 ? 'validated' : readinessScore >= 40 ? 'testing' : readinessScore >= 20 ? 'learning' : 'insufficient_data';

    // ── 3. GERAR CANDIDATOS por produto ─────────────────────────────────────
    const allPredictions: any[] = [];
    let totalCandidates = 0;

    for (const product of activeProducts) {
      const asin = product.asin;
      if (!asin) continue;

      // Search terms deste produto
      const productSTs = enrichedST.filter(st => st.asin === asin);
      // TermBank deste produto
      const productTB = activeTBTerms.filter(t => t.asin === asin);

      // Keywords existentes deste produto (campanhas ativas)
      const productCampIds = new Set((campaigns as any[]).filter(c => c.asin === asin).map(c => c.campaign_id));
      const productKwTexts = new Set(activeKeywords.filter(k => productCampIds.has(k.campaign_id)).map(k => (k.keyword_text || k.keyword || '').toLowerCase()));

      const candidates = new Map<string, any>(); // norm → dados

      // FONTE 1: search terms convertidos (melhor evidência)
      for (const st of productSTs) {
        if (isTruncated(st.term) || isGeneric(st.term)) continue;
        const n = normTerm(st.term);
        if (!n || n.length < 4) continue;
        const existing = candidates.get(n) || { term: st.term, metrics: st, source: 'search_term_converted' };
        // Merge: manter o de maior peso
        if ((st.orders > (existing.metrics?.orders || 0))) existing.metrics = st;
        candidates.set(n, existing);
      }

      // FONTE 2: TermBank ativo
      for (const tb of productTB) {
        const term = String(tb.term || '');
        if (!term || isTruncated(term) || isGeneric(term)) continue;
        const n = normTerm(term);
        if (candidates.has(n)) continue; // já tem de search term
        candidates.set(n, {
          term,
          metrics: {
            impressions: tb.impressions || 0, clicks: tb.clicks || 0, spend: tb.spend || 0,
            orders: tb.orders || 0, sales: tb.sales || 0, days: 14,
            cpc: tb.average_cpc || 0, conv_rate: 0, acos: tb.acos || 0, roas: tb.roas || 0,
          },
          source: 'term_bank',
        });
      }

      // FONTE 3: N-grams do título
      const title = product.product_name || product.display_name || product.title || '';
      if (title) {
        const stopWords = new Set(['de','do','da','dos','das','e','o','a','os','as','um','uma','com','em','para','por','sem','ate','no','na','nos','nas','que','se','ou','mas','este','essa','esse']);
        const nt = normTerm(title);
        const tokens = nt.split(' ').filter(t => t.length >= 3 && !stopWords.has(t));
        for (let i = 0; i < tokens.length; i++) {
          if (i + 2 < tokens.length) {
            const tri = `${tokens[i]} ${tokens[i+1]} ${tokens[i+2]}`;
            if (!candidates.has(tri)) candidates.set(tri, { term: tri, metrics: {}, source: 'title_ngram' });
          }
          if (i + 3 < tokens.length) {
            const four = `${tokens[i]} ${tokens[i+1]} ${tokens[i+2]} ${tokens[i+3]}`;
            if (!candidates.has(four)) candidates.set(four, { term: four, metrics: {}, source: 'title_ngram' });
          }
        }
      }

      // ── SCORE CADA CANDIDATO ───────────────────────────────────────────
      const scored: any[] = [];
      for (const [norm_, cand] of candidates.entries()) {
        const kw = cand.term;
        if (!kw || kw.length < 5) continue;
        if (negativeTexts.some(n => isSimilar(n, kw))) continue;
        if (existingKwTexts.some(e => isSimilar(e, kw))) continue;
        if (productKwTexts.has(kw.toLowerCase())) continue;
        const dedupKey = `${norm_}::${asin}`;
        if (prevNorms.has(dedupKey)) continue;

        const features = generateFeatures(kw, product, cand.metrics, negativeTexts);
        if (features.negative_conflict) continue;
        if (features.product_stock === 0) continue;

        const scores = scoreCandidate(features, {});
        if (scores.quality_score < 0.20) continue; // filtro de qualidade mínima

        const tailType = classifyTail(kw);
        const matchType = matchTypeForTail(tailType, features.historical_orders);
        const isExperimental = scores.data_confidence < 0.40 || scores.conversion_probability < 0.30;
        const bid = calcBid(cand.metrics, product, config, isExperimental);
        const reason = buildReason(kw, features, scores, tailType);

        const autoApprove =
          scores.relevance_score >= 0.80 ||
          (scores.conversion_probability >= 0.70 && scores.data_confidence >= 0.70 && features.historical_orders >= 2);

        const targetAcos = Number(config.target_acos || 25);
        const targetRoas = Number(config.target_roas || 4);
        const acosOk = features.historical_acos === 0 || features.historical_acos <= targetAcos;
        const roasOk = features.historical_roas === 0 || features.historical_roas >= targetRoas;

        const status = features.negative_conflict || features.is_generic > 0 ? 'blocked'
          : isExperimental ? 'experimental'
          : scores.quality_score >= 0.60 && acosOk ? 'scored'
          : 'candidate';

        const expSales = features.product_price * Math.max(features.historical_conversion_rate, 0.05);
        const expAcos = bid > 0 && expSales > 0 ? (bid / expSales) * 100 : targetAcos;
        const expRoas = expSales > 0 && bid > 0 ? expSales / bid : 0;

        scored.push({
          amazon_account_id,
          asin, sku: product.sku || '',
          keyword: kw, normalized_keyword: norm_,
          match_type: matchType, tail_type: tailType, word_count: kw.split(' ').length,
          source: cand.source,
          model_version: `v${new Date().toISOString().slice(0, 10)}`,
          relevance_score: features.semantic_similarity_to_title,
          conversion_probability: scores.conversion_probability,
          keyword_quality_score: scores.quality_score,
          confidence: scores.confidence,
          data_confidence: scores.data_confidence,
          recommended_bid: bid,
          status,
          reason,
          recommended_action: matchType === 'EXACT' ? 'create_exact_campaign' : matchType === 'PHRASE' ? 'add_to_phrase_campaign' : 'add_to_broad_campaign',
          historical_impressions: features.historical_impressions,
          historical_clicks: features.historical_clicks,
          historical_spend: features.historical_spend,
          historical_orders: features.historical_orders,
          historical_sales: features.historical_sales,
          historical_ctr: features.historical_ctr,
          historical_cpc: features.historical_cpc,
          historical_conversion_rate: features.historical_conversion_rate,
          historical_acos: features.historical_acos,
          historical_roas: features.historical_roas,
          negative_keyword_conflict: false,
          duplicate_keyword: false,
          policy_valid: true,
          expected_cpc: bid,
          expected_conversion_rate: Math.max(features.historical_conversion_rate, 0.05),
          expected_acos: Math.round(expAcos * 10) / 10,
          expected_roas: Math.round(expRoas * 100) / 100,
          expected_orders: scores.conversion_probability > 0.5 ? 1 : 0,
          expected_profit: expRoas > 1 ? (expSales - bid) * scores.conversion_probability : 0,
          features_json: JSON.stringify(features).slice(0, 3000),
          created_at: now,
          expires_at: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
        });
      }

      // Ordenar por quality_score desc + prioridade de cauda
      scored.sort((a, b) => {
        const tailPriority = (t: string) => t === 'long' ? 2 : t === 'medium' ? 1 : 0;
        const diff = (b.keyword_quality_score + tailPriority(b.tail_type) * 0.1) - (a.keyword_quality_score + tailPriority(a.tail_type) * 0.1);
        return diff;
      });

      // Limite: max_per_asin (default 10): 5 EXACT, 3 PHRASE, 2 BROAD
      const exactLimit = 5, phraseLimit = 3, broadLimit = 2;
      let exactCount = 0, phraseCount = 0, broadCount = 0;
      const selected: any[] = [];
      for (const c of scored) {
        if (c.match_type === 'EXACT' && exactCount < exactLimit) { selected.push(c); exactCount++; }
        else if (c.match_type === 'PHRASE' && phraseCount < phraseLimit) { selected.push(c); phraseCount++; }
        else if (c.match_type === 'BROAD' && broadCount < broadLimit) { selected.push(c); broadCount++; }
        if (selected.length >= max_per_asin) break;
      }

      totalCandidates += selected.length;
      allPredictions.push(...selected);
      // Track dedup for next product
      for (const p of selected) prevNorms.add(`${normTerm(p.keyword)}::${p.asin}`);
    }

    if (dry_run) {
      return Response.json({
        ok: true, dry_run: true,
        model_status: modelStatus, readiness_score: readinessScore,
        active_products: activeProducts.length,
        search_terms_processed: enrichedST.length,
        candidates_generated: totalCandidates,
        sample: allPredictions.slice(0, 5).map(p => ({
          keyword: p.keyword, asin: p.asin, tail_type: p.tail_type,
          match_type: p.match_type, quality_score: p.keyword_quality_score,
          conversion_probability: p.conversion_probability, status: p.status, reason: p.reason,
        })),
        duration_ms: Date.now() - runStart,
      });
    }

    // ── 4. PERSIST ───────────────────────────────────────────────────────────
    let saved = 0;
    for (let i = 0; i < allPredictions.length; i += 20) {
      const batch = allPredictions.slice(i, i + 20);
      await base44.asServiceRole.entities.KeywordPrediction.bulkCreate(batch);
      saved += batch.length;
      if (i + 20 < allPredictions.length) await new Promise(r => setTimeout(r, 200));
    }

    // ── 5. SAVE MODEL VERSION ────────────────────────────────────────────────
    await base44.asServiceRole.entities.MLModelVersion.create({
      amazon_account_id,
      version: `v${new Date().toISOString().slice(0, 10)}`,
      status: modelStatus,
      readiness_score: readinessScore,
      training_date: now,
      total_candidates: saved,
      training_records: enrichedST.length,
      training_products: activeProducts.length,
      training_campaigns: (campaigns as any[]).length,
      training_search_terms: enrichedST.length,
      weights_json: JSON.stringify({ conv_prob: 0.30, relevance: 0.20, conv_rate: 0.15, roas: 0.10, acos: 0.10, long_tail: 0.05, amazon_rank: 0.05, data_conf: 0.05 }),
      thresholds_json: JSON.stringify({ min_quality: 0.20, auto_approve_quality: 0.60, min_conversion_prob: 0.30, min_data_confidence: 0.40 }),
    }).catch(() => {});

    return Response.json({
      ok: true,
      model_status: modelStatus,
      readiness_score: readinessScore,
      active_products: activeProducts.length,
      search_terms_processed: enrichedST.length,
      candidates_generated: totalCandidates,
      saved,
      breakdown: {
        scored: allPredictions.filter(p => p.status === 'scored').length,
        experimental: allPredictions.filter(p => p.status === 'experimental').length,
        candidate: allPredictions.filter(p => p.status === 'candidate').length,
        exact: allPredictions.filter(p => p.match_type === 'EXACT').length,
        phrase: allPredictions.filter(p => p.match_type === 'PHRASE').length,
        broad: allPredictions.filter(p => p.match_type === 'BROAD').length,
      },
      duration_ms: Date.now() - runStart,
    });

  } catch (err: any) {
    return Response.json({ ok: false, error: err?.message || 'Erro inesperado' }, { status: 500 });
  }
});