/**
 * runKeywordMLPipeline — Motor de ML determinístico para palavras-chave v4
 *
 * Pipeline completo: scoring → cross-ASIN guard → persist → promoção automática → recalibração inline
 *
 * Etapas:
 * 0. PRÉ-SCORING: Cross-ASIN boost + High-Performance Guard
 * 1. Collect & normalizar dados reais
 * 2. Classificar cauda por demanda híbrida
 * 3. Calcular features enriquecidas
 * 4. Pontuar candidatos (sem bônus de cauda exceto evidence-condicionado)
 * 5. Upsert idempotente em KeywordPrediction
 * 6. Promoção automática (scored + quality >= 0.60 + CVR >= 3%)
 * 7. Recalibração inline (monitoring/created com dados reais)
 *
 * GUARDRAIL: promoção e recalibração puladas se persist ultrapassar 25s
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const RULE_VERSION = 'ml-v4-2026-07';

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

// ── Semelhança semântica (token overlap) ──────────────────────────────────────
function semanticSimilarity(kw: string, title: string): number {
  const ka = new Set(normTerm(kw).split(' ').filter(t => t.length >= 3));
  const ta = new Set(normTerm(title).split(' ').filter(t => t.length >= 3));
  if (!ka.size || !ta.size) return 0;
  const inter = [...ka].filter(t => ta.has(t)).length;
  return Math.round((inter / Math.max(ka.size, ta.size)) * 100) / 100;
}

// ── Atributos semânticos de especificidade ────────────────────────────────────
const SEMANTIC_COLORS    = ['preto','branco','azul','vermelho','verde','amarelo','rosa','cinza','marrom','bege','dourado','prata','transparente','laranja','roxo','lilas'];
const SEMANTIC_MATERIALS = ['inox','aco','aluminio','plastico','borracha','couro','silicone','madeira','vidro','metal','ceramica','tecido','nylon','poliester'];
const SEMANTIC_SIZES     = ['mini','maxi','pequeno','grande','pp','gg','xl','xxl','xg','xxg'];

function detectSemanticAttrs(norm: string): string[] {
  const found: string[] = [];
  for (const c of SEMANTIC_COLORS)    if (norm.includes(c)) found.push(`cor:${c}`);
  for (const m of SEMANTIC_MATERIALS) if (norm.includes(m)) found.push(`material:${m}`);
  for (const s of SEMANTIC_SIZES)     if (norm.includes(s)) found.push(`tamanho:${s}`);
  if (/\d+\s*(un|pç|peca|ml|litro|litros|kg|g\b|cm|mm|l\b)/.test(norm)) found.push('quantidade_numerica');
  return found;
}

// ── Classificação de cauda HÍBRIDA ────────────────────────────────────────────
function classifyTailHybrid(kw: string, allTermsWithImpressions: Array<{term: string; impressions: number}>): {
  tail_type: 'short' | 'medium' | 'long';
  tail_class_method: 'DEMAND_DATA' | 'SEMANTIC_ATTR_FALLBACK' | 'WORD_COUNT_FALLBACK';
  tail_class_confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  demand_percentile: number;
  normalized_search_volume: number;
  word_count: number;
  semantic_attrs: string[];
} {
  const norm = normTerm(kw);
  const wc = norm.split(' ').filter(Boolean).length;
  const semantic_attrs = detectSemanticAttrs(norm);

  if (allTermsWithImpressions.length >= 30) {
    const selfEntry = allTermsWithImpressions.find(t => normTerm(t.term) === norm);
    const selfImpressions = selfEntry?.impressions ?? 0;
    const sorted = [...allTermsWithImpressions].sort((a, b) => a.impressions - b.impressions);
    const below = sorted.filter(t => t.impressions <= selfImpressions).length;
    const demand_percentile = Math.round((below / sorted.length) * 100);
    let tail_type: 'short' | 'medium' | 'long';
    let tail_class_confidence: 'HIGH' | 'MEDIUM' | 'LOW' = 'HIGH';
    if (demand_percentile >= 80) tail_type = 'short';
    else if (demand_percentile >= 30) tail_type = 'medium';
    else tail_type = 'long';
    if (selfImpressions === 0) tail_class_confidence = 'MEDIUM';
    return { tail_type, tail_class_method: 'DEMAND_DATA', tail_class_confidence, demand_percentile, normalized_search_volume: selfImpressions, word_count: wc, semantic_attrs };
  }

  if (wc >= 3 && semantic_attrs.length >= 1) {
    return { tail_type: 'long', tail_class_method: 'SEMANTIC_ATTR_FALLBACK', tail_class_confidence: 'MEDIUM', demand_percentile: 0, normalized_search_volume: 0, word_count: wc, semantic_attrs };
  }

  const tail_type: 'short' | 'medium' | 'long' = wc >= 5 ? 'long' : wc >= 3 ? 'medium' : 'short';
  return { tail_type, tail_class_method: 'WORD_COUNT_FALLBACK', tail_class_confidence: 'LOW', demand_percentile: 0, normalized_search_volume: 0, word_count: wc, semantic_attrs };
}

// ── Intenção comercial determinística ──────────────────────────────────────────
function classifyCommercialIntent(kw: string, product: any): { commercial_intent: string; commercial_intent_score: number } {
  const t = normTerm(kw);
  const brand = normTerm(product?.brand || '');
  const words = t.split(' ').filter(Boolean);
  const buySignals = ['comprar','melhor','barato','preço','oferta','kit','conjunto','com','sem','para','original','profissional'];
  const infoWords = ['como','qual','quando','porque','tutorial','review','avaliacao','comparacao','o que'];
  const competitorWords = ['vs','versus','alternativa','melhor que'];
  const hasBuy = buySignals.some(w => t.includes(w));
  const hasInfo = infoWords.some(w => t.includes(w));
  const hasCompetitor = competitorWords.some(w => t.includes(w));
  const hasBrand = brand && t.includes(brand);
  const hasSize = /\d+\s*(ml|litro|litros|cm|metro|metros|kg|g\b|polegada|l\b|un\b)/.test(t);
  const hasMaterial = /inox|aco|aluminio|plastico|borracha|couro|silicone|madeira|vidro|metal|ceramica/.test(t);
  const hasProblem = /antiodor|anti.odor|antivazamento|silencioso|vedado|hermetico/.test(t);
  const hasBenefit = /automatico|automatica|sensor|inteligente|smart|wifi|bluetooth|recarregavel/.test(t);
  const hasSize2 = /pequeno|medio|grande|mini|maxi|pp\b|mg\b|gg\b|xl\b/.test(t);
  let commercial_intent = 'ambiguous';
  let commercial_intent_score = 0.5;
  if (hasInfo) { commercial_intent = 'informational'; commercial_intent_score = 0.15; }
  else if (hasCompetitor) { commercial_intent = 'competitor_branded'; commercial_intent_score = 0.55; }
  else if (hasBrand) { commercial_intent = 'branded'; commercial_intent_score = 0.75; }
  else if (hasProblem) { commercial_intent = 'problem_solution'; commercial_intent_score = 0.85; }
  else if (hasBenefit && words.length >= 2) { commercial_intent = 'attribute_specific'; commercial_intent_score = 0.80; }
  else if ((hasSize || hasSize2 || hasMaterial) && words.length >= 3) { commercial_intent = 'product_specific'; commercial_intent_score = 0.85; }
  else if ((hasSize || hasMaterial) && words.length >= 2) { commercial_intent = 'attribute_specific'; commercial_intent_score = 0.75; }
  else if (hasBuy) { commercial_intent = 'use_case'; commercial_intent_score = 0.70; }
  else if (words.length <= 2) { commercial_intent = 'generic_category'; commercial_intent_score = 0.30; }
  else { commercial_intent = 'product_specific'; commercial_intent_score = 0.60; }
  return { commercial_intent, commercial_intent_score };
}

// ── Contradiction flags determinísticos ───────────────────────────────────────
function detectContradictions(kw: string, product: any): string[] {
  const flags: string[] = [];
  const t = normTerm(kw);
  const title = normTerm(product?.product_name || product?.display_name || '');
  const bullets = normTerm((product?.bullet_points || []).join(' '));
  const allText = `${title} ${bullets}`;
  const MATERIALS: Record<string, string[]> = {
    inox: ['plastico','borracha','madeira'],
    madeira: ['inox','aluminio','plastico'],
    ceramica: ['inox','aluminio','plastico'],
    vidro: ['plastico','aluminio'],
  };
  for (const [mat, incompatibles] of Object.entries(MATERIALS)) {
    if (t.includes(mat) && !allText.includes(mat) && incompatibles.some(i => allText.includes(i))) {
      flags.push(`material_incompativel:${mat}`);
    }
  }
  const audiences: string[] = ['infantil','crianca','bebe','adulto','idoso','pet','gato','cachorro'];
  for (const aud of audiences) {
    if (t.includes(aud) && !allText.includes(aud)) {
      flags.push(`publico_incompativel:${aud}`);
    }
  }
  return flags;
}

// ── ACoS status ──────────────────────────────────────────────────────────────
function classifyAcosStatus(acos: number | null, sales: number, targetAcos: number): string {
  if (sales === 0 || acos === null) return 'NO_SALES';
  if (acos === 0) return 'NO_DATA';
  if (acos <= targetAcos) return 'PROFITABLE';
  if (acos <= targetAcos * 1.3) return 'ACCEPTABLE';
  return 'ABOVE_TARGET';
}

// ── Evidence level ────────────────────────────────────────────────────────────
function calcEvidenceLevel(clicks: number, orders: number, impressions: number): 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH' {
  if (impressions === 0) return 'NONE';
  if (orders >= 3 || clicks >= 20) return 'HIGH';
  if ((orders >= 1 && orders <= 2) || (clicks >= 10 && clicks < 20)) return 'MEDIUM';
  if (clicks > 0 || impressions > 0) return 'LOW';
  return 'NONE';
}

// ── Features enriquecidas ─────────────────────────────────────────────────────
function generateFeatures(kw: string, product: any, metrics: any, negativeTexts: string[]): any {
  const norm = normTerm(kw);
  const words = norm.split(' ').filter(Boolean);
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
  const semTitle = semanticSimilarity(kw, title);
  const semBullets = semanticSimilarity(kw, bullets);
  const semAttrs = semanticSimilarity(kw, attrs);
  const kwTokens = norm.split(' ').filter(t => t.length >= 3);
  const matchedTokens = kwTokens.filter(t => allText.includes(t)).length;
  const product_attribute_match_score = kwTokens.length > 0 ? Math.round((matchedTokens / kwTokens.length) * 100) / 100 : 0;
  const attrBonus = [
    COLOR_WORDS.some(c => norm.includes(c)),
    SIZE_WORDS.some(s => norm.includes(s)),
    MATERIAL_WORDS.some(m => norm.includes(m)),
    /\d+\s*(un|pç|peca|ml|litro|kg|g\b|cm|mm)/.test(norm),
    INTENT_WORDS.some(i => norm.includes(i)),
  ].filter(Boolean).length;
  const specificity_score = Math.min(1, (Math.min(wc, 6) / 6) * 0.6 + (attrBonus / 5) * 0.4);
  const { commercial_intent, commercial_intent_score } = classifyCommercialIntent(kw, product);
  const historical_acos = (metrics.sales > 0 && metrics.spend > 0)
    ? Math.round((metrics.spend / metrics.sales) * 10000) / 100 : null;
  const historical_roas = (metrics.spend > 0) ? metrics.sales / metrics.spend : 0;
  const contradictionFlags = detectContradictions(kw, product);
  return {
    word_count: wc,
    char_count: kw.length,
    is_long_tail: wc >= 5 ? 1 : 0,
    is_medium_tail: (wc >= 3 && wc <= 4) ? 1 : 0,
    is_short_tail: wc <= 2 ? 1 : 0,
    contains_brand: brand && norm.includes(brand) ? 1 : 0,
    contains_product_type: semTitle > 0.5 ? 1 : 0,
    contains_size: SIZE_WORDS.some(s => norm.includes(s)) ? 1 : 0,
    contains_color: COLOR_WORDS.some(c => norm.includes(c)) ? 1 : 0,
    contains_material: MATERIAL_WORDS.some(m => norm.includes(m)) ? 1 : 0,
    contains_quantity: /\d+\s*(un|pç|peca|ml|litro|kg|g\b|cm|mm)/.test(norm) ? 1 : 0,
    contains_purchase_intent: INTENT_WORDS.some(i => norm.includes(i)) ? 1 : 0,
    semantic_similarity_to_title: semTitle,
    semantic_similarity_to_bullets: semBullets,
    semantic_similarity_to_attrs: semAttrs,
    semScore: Math.round((semTitle * 0.60 + semBullets * 0.30 + semAttrs * 0.10) * 100) / 100,
    historical_impressions: metrics.impressions || 0,
    historical_clicks: metrics.clicks || 0,
    historical_spend: metrics.spend || 0,
    historical_orders: metrics.orders || 0,
    historical_sales: metrics.sales || 0,
    historical_ctr: metrics.ctr || 0,
    historical_cpc: metrics.cpc || 0,
    historical_conversion_rate: metrics.conv_rate || 0,
    historical_acos,
    historical_roas,
    days_with_data: metrics.days || 0,
    negative_conflict: negativeTexts.some(n => isSimilar(n, kw)) ? 1 : 0,
    is_generic: isGeneric(kw) ? 1 : 0,
    product_stock: Number(product?.fba_inventory ?? product?.fba_quantity ?? 0),
    product_price: Number(product?.price || product?.buy_box_price || 0),
    product_margin: Number(product?.margin_pct || product?.margin || 0),
    amazon_suggestion_rank: metrics.amazon_rank || 99,
    commercial_intent,
    commercial_intent_score,
    specificity_score,
    product_attribute_match_score,
    contradiction_flags: contradictionFlags,
  };
}

// ── Modelo de pontuação v3 ────────────────────────────────────────────────────
function scoreCandidate(features: any, targetAcos: number, tail_type?: string, evidence_level?: string): {
  conversion_probability: number;
  quality_score: number;
  confidence: number;
  data_confidence: number;
  long_tail_score_bonus: number;
} {
  const semScore = features.semScore;
  let convScore = 0;
  if (features.historical_orders >= 2) convScore += 0.45;
  else if (features.historical_orders === 1) convScore += 0.25;
  else if (features.historical_clicks >= 5) convScore += 0.12;
  if (features.historical_conversion_rate >= 0.15) convScore += 0.20;
  else if (features.historical_conversion_rate >= 0.08) convScore += 0.12;
  else if (features.historical_conversion_rate >= 0.03) convScore += 0.06;
  convScore += semScore * 0.20;
  if (features.contains_purchase_intent) convScore += 0.05;
  if (features.contains_size || features.contains_color || features.contains_material) convScore += 0.04;
  if (features.contains_quantity) convScore += 0.03;
  convScore += features.commercial_intent_score * 0.06;
  if (features.amazon_suggestion_rank <= 5) convScore += 0.05;
  else if (features.amazon_suggestion_rank <= 20) convScore += 0.02;
  if (features.is_generic) convScore -= 0.15;
  if (features.negative_conflict) convScore = 0;
  if (features.historical_spend > 10 && features.historical_orders === 0 && features.historical_clicks >= 10) convScore -= 0.20;
  if (features.product_stock === 0) convScore = 0;
  if (features.contradiction_flags && features.contradiction_flags.length > 0) convScore -= 0.30;
  convScore = Math.max(0, Math.min(1, convScore));
  let qs = 0;
  qs += convScore * 0.30;
  qs += semScore * 0.20;
  qs += Math.min(features.historical_conversion_rate * 1.5, 0.15) * (1/0.15) * 0.15;
  if (features.historical_roas > 0) qs += Math.min(features.historical_roas / 10, 1) * 0.10;
  if (features.historical_acos !== null && features.historical_sales > 0 && features.historical_acos <= targetAcos) {
    qs += (1 - features.historical_acos / 100) * 0.10;
  }
  if (features.amazon_suggestion_rank <= 10) qs += (1 - features.amazon_suggestion_rank / 10) * 0.05;
  qs += features.product_attribute_match_score * 0.05;
  const isLongTailEvidence = tail_type === 'long' && (evidence_level === 'MEDIUM' || evidence_level === 'HIGH');
  const long_tail_score_bonus = isLongTailEvidence ? 0.05 : 0;
  qs += long_tail_score_bonus;
  let dc = 0;
  if (features.historical_clicks >= 20) dc += 0.40;
  else if (features.historical_clicks >= 5) dc += 0.20;
  if (features.historical_impressions >= 100) dc += 0.20;
  if (features.days_with_data >= 14) dc += 0.20;
  else if (features.days_with_data >= 7) dc += 0.10;
  if (features.semantic_similarity_to_title >= 0.3) dc += 0.20;
  dc = Math.max(0, Math.min(1, dc));
  const confidence = dc > 0 ? Math.min(1, convScore * 0.7 + dc * 0.3) : convScore * 0.5;
  return {
    conversion_probability: Math.round(convScore * 100) / 100,
    quality_score: Math.round(Math.max(0, Math.min(1, qs)) * 100) / 100,
    confidence: Math.round(confidence * 100) / 100,
    data_confidence: Math.round(dc * 100) / 100,
    long_tail_score_bonus,
  };
}

// ── Bid recomendado v3 ────────────────────────────────────────────────────────
function calcBid(metrics: any, product: any, config: any, isExperimental: boolean, tail_type?: string): { bid: number; bid_method: string } {
  const minBid = Number(config.min_bid || 0.50);
  const maxBid = Number(config.max_bid || 5.0);
  const targetAcos = Number(config.target_acos || 25);
  const price = Number(product?.price || product?.buy_box_price || 0);
  const convRate = Number(metrics.conv_rate || 0.08);
  const historicalCvr = Number(metrics.conv_rate || 0);
  if (tail_type === 'long' && historicalCvr >= 0.03 && price > 0 && targetAcos > 0) {
    const bidCvr = price * historicalCvr * (targetAcos / 100);
    if (bidCvr >= minBid) {
      return { bid: Math.round(Math.max(minBid, Math.min(bidCvr, maxBid)) * 100) / 100, bid_method: 'cvr_real' };
    }
  }
  const candidates: number[] = [];
  if (metrics.cpc > 0) candidates.push(metrics.cpc * 1.10);
  if (price > 0 && targetAcos > 0) {
    const maxProfit = price * convRate * (targetAcos / 100);
    if (maxProfit > 0) candidates.push(maxProfit);
  }
  if (metrics.amazon_suggested_bid > 0) candidates.push(metrics.amazon_suggested_bid);
  let bid = candidates.length > 0 ? Math.min(...candidates) : minBid;
  if (isExperimental) bid = Math.max(minBid, bid * 0.70);
  return { bid: Math.round(Math.max(minBid, Math.min(bid, maxBid)) * 100) / 100, bid_method: 'experimental_capped' };
}

// ── Reason builder v3 ─────────────────────────────────────────────────────────
function buildReason(kw: string, features: any, scores: any, tailInfo: any, evidenceLevel: string, longTailEarlyPromo?: boolean, crossAsinBoost?: boolean): string {
  const parts: string[] = [];
  if (tailInfo.tail_class_method === 'DEMAND_DATA') {
    parts.push(`cauda ${tailInfo.tail_type} por demanda (percentil ${tailInfo.demand_percentile}%, método: dados reais)`);
  } else if (tailInfo.tail_class_method === 'SEMANTIC_ATTR_FALLBACK') {
    parts.push(`cauda ${tailInfo.tail_type} por atributos semânticos (${tailInfo.semantic_attrs?.join(', ')})`);
  } else {
    parts.push(`cauda ${tailInfo.tail_type} por contagem de palavras (fallback)`);
  }
  if (longTailEarlyPromo) parts.push('long-tail com evidência MEDIUM promovida antecipadamente');
  if (crossAsinBoost) parts.push('boost cross-ASIN: CVR confirmada em outro produto');
  if (features.semantic_similarity_to_title >= 0.5) parts.push(`alta similaridade ao título (${Math.round(features.semantic_similarity_to_title * 100)}%)`);
  else if (features.semantic_similarity_to_title >= 0.25) parts.push(`similaridade moderada ao título (${Math.round(features.semantic_similarity_to_title * 100)}%)`);
  if (features.historical_orders >= 2) parts.push(`${features.historical_orders} vendas atribuídas`);
  else if (features.historical_orders === 1) parts.push('1 venda atribuída');
  else if (features.historical_sales === 0) parts.push('sem vendas — ACoS não calculável');
  if (features.historical_conversion_rate >= 0.10) parts.push(`CVR ${(features.historical_conversion_rate * 100).toFixed(1)}%`);
  if (features.historical_cpc > 0) parts.push(`CPC histórico R$${features.historical_cpc.toFixed(2)}`);
  if (features.historical_acos !== null && features.historical_sales > 0) parts.push(`ACoS ${features.historical_acos.toFixed(1)}%`);
  if (features.commercial_intent_score >= 0.75) parts.push(`intenção comercial alta (${features.commercial_intent})`);
  if (features.amazon_suggestion_rank <= 10) parts.push('sugerida pela Amazon');
  if (features.contradiction_flags && features.contradiction_flags.length > 0) parts.push(`⚠ contradições: ${features.contradiction_flags.join(', ')}`);
  parts.push(`evidência: ${evidenceLevel}`);
  return parts.length > 0 ? parts.join(', ') + '.' : 'Candidato gerado por análise de dados históricos.';
}

// ── RECALIBRAÇÃO INLINE (lógica core extraída) ────────────────────────────────
// Usada pelo pipeline e pelo standalone recalibrateKeywordMLModel
async function runCalibrationInline(
  base44: any,
  amazon_account_id: string,
  modelVersionId: string | null,
  allPreds: any[],
  kwMetrics: Map<string, any>
): Promise<{ updated: number; successful: number; underperforming: number; precision: number; calibration_by_tail: any }> {
  const monitoringPreds = allPreds.filter(p => ['monitoring', 'created'].includes(p.status));
  const updates: any[] = [];
  let successful = 0, underperforming = 0;

  for (const pred of monitoringPreds) {
    const actual = kwMetrics.get((pred.keyword || '').toLowerCase());
    if (!actual) continue;
    const hasRealData = (actual.orders || 0) > 0 || (actual.clicks || 0) >= 10;
    if (!hasRealData) continue;

    const actualConvRate = actual.clicks > 0 ? actual.orders / actual.clicks : 0;
    const actualAcos = actual.sales > 0 ? (actual.spend / actual.sales) * 100 : 0;
    const actualRoas = actual.spend > 0 ? actual.sales / actual.spend : 0;
    const predError = Math.abs((pred.conversion_probability || 0) - actualConvRate);
    const isSuccessful = actual.orders >= 1 && (actualAcos <= (pred.expected_acos || 35) * 1.3 || actualRoas >= (pred.expected_roas || 2) * 0.7);
    const isUnderperforming = actual.clicks >= 10 && actual.orders === 0;

    updates.push({
      id: pred.id,
      actual_orders: actual.orders,
      actual_sales: actual.sales,
      actual_conversion_rate: actualConvRate,
      actual_acos: actualAcos,
      actual_roas: actualRoas,
      prediction_error: Math.round(predError * 100) / 100,
      outcome_status: isSuccessful ? 'successful' : isUnderperforming ? 'underperforming' : 'monitoring',
      status: isSuccessful ? 'successful' : isUnderperforming ? 'underperforming' : pred.status,
    });

    if (isSuccessful) successful++;
    if (isUnderperforming) underperforming++;
  }

  // Aplicar updates em lote
  for (let i = 0; i < updates.length; i += 20) {
    const batch = updates.slice(i, i + 20);
    await Promise.all(batch.map((u: any) => {
      const { id, ...data } = u;
      return base44.asServiceRole.entities.KeywordPrediction.update(id, data).catch(() => {});
    }));
    if (i + 20 < updates.length) await new Promise(r => setTimeout(r, 150));
  }

  // Calcular precisão e calibração por tail
  const withOutcome = allPreds.filter(p => ['successful', 'underperforming'].includes(p.status));
  const precision = withOutcome.length > 0
    ? allPreds.filter(p => p.status === 'successful').length / withOutcome.length : 0;
  const avgPredError = withOutcome.length > 0
    ? withOutcome.reduce((s: number, p: any) => s + (p.prediction_error || 0), 0) / withOutcome.length : 0;

  const calibration_by_tail: Record<string, any> = {};
  for (const tail of ['short', 'medium', 'long']) {
    const tailGroup = withOutcome.filter((p: any) => (p.tail_type || 'medium') === tail);
    if (tailGroup.length === 0) continue;
    const successfulTail = tailGroup.filter((p: any) => p.status === 'successful');
    const underperformingTail = tailGroup.filter((p: any) => p.status === 'underperforming');
    const withSales = tailGroup.filter((p: any) => (p.actual_orders || 0) > 0);
    const withAcos = tailGroup.filter((p: any) => (p.actual_acos || 0) > 0 && (p.actual_orders || 0) > 0);
    calibration_by_tail[tail] = {
      count: tailGroup.length,
      precision: Math.round((successfulTail.length / tailGroup.length) * 100) / 100,
      false_positive_rate: Math.round((underperformingTail.length / tailGroup.length) * 100) / 100,
      conversion_rate: withSales.length > 0 ? Math.round((withSales.reduce((s: number, p: any) => s + (p.actual_conversion_rate || 0), 0) / withSales.length) * 1000) / 1000 : 0,
      avg_acos: withAcos.length > 0 ? Math.round((withAcos.reduce((s: number, p: any) => s + (p.actual_acos || 0), 0) / withAcos.length) * 10) / 10 : null,
      avg_roas: withSales.length > 0 ? Math.round((withSales.reduce((s: number, p: any) => s + (p.actual_roas || 0), 0) / withSales.length) * 100) / 100 : 0,
    };
  }

  // Atualizar MLModelVersion com métricas de calibração
  if (modelVersionId) {
    try {
      const v = await base44.asServiceRole.entities.MLModelVersion.get(modelVersionId).catch(() => null);
      if (v) {
        let existingWeights: any = {};
        try { existingWeights = JSON.parse(v.weights_json || '{}'); } catch {}
        await base44.asServiceRole.entities.MLModelVersion.update(modelVersionId, {
          total_with_sales: allPreds.filter((p: any) => (p.actual_orders || 0) > 0).length,
          precision: Math.round(precision * 100) / 100,
          conversion_prediction_accuracy: Math.max(0, Math.round((1 - avgPredError) * 100) / 100),
          acos_prediction_error: Math.round(avgPredError * 100) / 100,
          profit_generated: allPreds.filter((p: any) => p.status === 'successful').reduce((s: number, p: any) => s + (p.actual_profit || 0), 0),
          weights_json: JSON.stringify({
            ...existingWeights,
            calibration_by_tail,
            calibration_updated_at: new Date().toISOString(),
          }),
        }).catch(() => {});
      }
    } catch {}
  }

  return { updated: updates.length, successful, underperforming, precision: Math.round(precision * 100) / 100, calibration_by_tail };
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
    const today = now.slice(0, 10);
    const modelVersion = `v${today}`;

    // ── 1. COLLECT ──────────────────────────────────────────────────────────
    const [products, searchTerms, keywords, campaigns, termBank, config, prevPredictions, dailyMetricsRaw] = await Promise.all([
      base44.asServiceRole.entities.Product.filter({ amazon_account_id }, '-updated_at', 300),
      base44.asServiceRole.entities.SearchTerm.filter({ amazon_account_id }, '-orders_14d', 500),
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id }, '-spend', 500),
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id, state: { $in: ['enabled', 'ENABLED'] } }, '-spend', 200),
      base44.asServiceRole.entities.TermBank.filter({ amazon_account_id }, null, 500),
      base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id }).then((r: any[]) => r[0] || {}),
      base44.asServiceRole.entities.KeywordPrediction.filter({ amazon_account_id }, '-created_at', 1000),
      base44.asServiceRole.entities.CampaignMetricsDaily.filter({ amazon_account_id }, '-date', 500).catch(() => []),
    ]);

    const targetAcos = Number(config.target_acos || 25);

    // Produtos ativos com estoque
    const activeProducts = (products as any[]).filter(p =>
      p.status === 'active' &&
      (Number(p.fba_inventory ?? p.fba_quantity ?? 0) > 0 || p.inventory_status === 'in_stock' || p.inventory_status === 'available')
    );

    if (!activeProducts.length) {
      return Response.json({ ok: true, message: 'Nenhum produto ativo com estoque encontrado.', candidates: 0 });
    }

    // ── ETAPA 0: PRÉ-SCORING — Cross-ASIN Guard + High-Performance Guard ────
    // Carregar predições com status 'successful' ou protected_high_performance=true (max 500)
    const guardPredictions = (prevPredictions as any[]).filter(p =>
      p.status === 'successful' || p.protected_high_performance === true
    ).slice(0, 500);

    // Indexar por normalized_keyword para lookup O(1)
    const crossAsinSuccessMap = new Map<string, any>();       // norm → {cvr, asin}
    const highPerfGuardMap = new Map<string, any>();          // norm::asin → pred

    for (const p of guardPredictions) {
      const norm = normTerm(p.keyword || '');
      if (!norm) continue;

      if (p.protected_high_performance === true) {
        highPerfGuardMap.set(`${norm}::${p.asin}`, p);
      }

      if (p.status === 'successful' && (p.actual_conversion_rate || 0) >= 0.03) {
        // Registrar CVR confirmada de outro ASIN (cross-ASIN boost)
        if (!crossAsinSuccessMap.has(norm)) {
          crossAsinSuccessMap.set(norm, { cvr: p.actual_conversion_rate, asin: p.asin });
        }
      }
    }

    // Negativadas globais
    const negativeKeywords = (keywords as any[]).filter(k => k.state === 'archived' || k.matchType === 'NEGATIVE_EXACT' || k.matchType === 'NEGATIVE_PHRASE');
    const negativeTexts = negativeKeywords.map(k => k.keyword_text || k.keyword || '').filter(Boolean);

    // Keywords ativas existentes
    const activeCampaignIds = new Set((campaigns as any[]).map(c => c.campaign_id));
    const activeKeywords = (keywords as any[]).filter(k => activeCampaignIds.has(k.campaign_id) && k.state !== 'archived');
    const existingKwTexts = activeKeywords.map(k => (k.keyword_text || k.keyword || '').toLowerCase()).filter(Boolean);

    // Índice de predições existentes para upsert idempotente
    const existingPredMap = new Map<string, any>();
    for (const p of prevPredictions as any[]) {
      const k = `${normTerm(p.keyword)}::${p.asin}::${p.model_version || ''}`;
      if (!existingPredMap.has(k)) existingPredMap.set(k, p);
    }
    const prevNorms = new Set(
      (prevPredictions as any[])
        .filter(p => !['rejected', 'expired', 'blocked'].includes(p.status))
        .map(p => `${normTerm(p.keyword)}::${p.asin}`)
    );

    // TermBank ativos
    const activeTBTerms = (termBank as any[]).filter(t => t.status === 'active');

    // ── 2. AGREGAR search terms por termo+ASIN com múltiplas janelas ─────
    const stMap = new Map<string, any>();
    for (const st of searchTerms as any[]) {
      const term = String(st.search_term || st.keyword_text || '').toLowerCase().trim();
      const asin = String(st.advertised_asin || st.asin || '');
      if (!term || !asin) continue;
      const key = `${term}::${asin}`;
      const cur = stMap.get(key) || { term, asin, impressions: 0, clicks: 0, spend: 0, orders: 0, units: 0, sales: 0, days: 0, impressions_7d: 0, clicks_7d: 0, orders_7d: 0, sales_7d: 0, impressions_30d: 0, clicks_30d: 0, orders_30d: 0, sales_30d: 0 };
      cur.impressions += Number(st.impressions || 0);
      cur.clicks += Number(st.clicks || 0);
      cur.spend += Number(st.spend || 0);
      cur.orders += Number(st.orders_14d || st.orders_7d || st.orders || 0);
      cur.sales += Number(st.sales_14d || st.sales_7d || st.sales || 0);
      cur.days = Math.max(cur.days, Number(st.days || 1));
      if (st.orders_7d) { cur.orders_7d += Number(st.orders_7d || 0); cur.impressions_7d += Number(st.impressions || 0); }
      if (st.orders_30d || st.orders) { cur.orders_30d += Number(st.orders_30d || st.orders || 0); }
      stMap.set(key, cur);
    }

    const enrichedST = [...stMap.values()].map(st => ({
      ...st,
      ctr: st.impressions > 0 ? st.clicks / st.impressions : 0,
      cpc: st.clicks > 0 ? st.spend / st.clicks : 0,
      conv_rate: st.clicks > 0 ? st.orders / st.clicks : 0,
      acos: st.sales > 0 ? (st.spend / st.sales) * 100 : null,
      roas: st.spend > 0 ? st.sales / st.spend : 0,
    }));

    const allTermsForContext = enrichedST.map(st => ({ term: st.term, impressions: st.impressions }));

    // ── 3. MODEL READINESS ──────────────────────────────────────────────────
    const totalOrders = enrichedST.reduce((s, t) => s + t.orders, 0);
    const totalClicks = enrichedST.reduce((s, t) => s + t.clicks, 0);
    let readinessScore = 0;
    if (activeProducts.length >= 1) readinessScore += 20;
    if ((campaigns as any[]).length >= 2) readinessScore += 20;
    if (enrichedST.length >= 20) readinessScore += 20;
    if (totalClicks >= 100) readinessScore += 20;
    if (totalOrders >= 5) readinessScore += 20;
    const modelStatus = readinessScore >= 80 ? 'production' : readinessScore >= 60 ? 'validated' : readinessScore >= 40 ? 'testing' : readinessScore >= 20 ? 'learning' : 'insufficient_data';

    // ── 4. GERAR CANDIDATOS por produto ─────────────────────────────────────
    const toCreate: any[] = [];
    const toUpdate: any[] = [];
    let totalCandidates = 0;

    for (const product of activeProducts) {
      const asin = product.asin;
      if (!asin) continue;

      const productSTs = enrichedST.filter(st => st.asin === asin);
      const productTB = activeTBTerms.filter(t => t.asin === asin);
      const productCampIds = new Set((campaigns as any[]).filter(c => c.asin === asin).map(c => c.campaign_id));
      const productKwTexts = new Set(activeKeywords.filter(k => productCampIds.has(k.campaign_id)).map(k => (k.keyword_text || k.keyword || '').toLowerCase()));

      const candidates = new Map<string, any>();

      // FONTE 1: search terms convertidos
      for (const st of productSTs) {
        if (isTruncated(st.term) || isGeneric(st.term)) continue;
        const n = normTerm(st.term);
        if (!n || n.length < 4) continue;
        const existing = candidates.get(n) || { term: st.term, metrics: st, source: 'search_term_converted' };
        if (st.orders > (existing.metrics?.orders || 0)) existing.metrics = st;
        candidates.set(n, existing);
      }

      // FONTE 2: TermBank ativo
      for (const tb of productTB) {
        const term = String(tb.term || '');
        if (!term || isTruncated(term) || isGeneric(term)) continue;
        const n = normTerm(term);
        if (candidates.has(n)) continue;
        candidates.set(n, {
          term,
          metrics: { impressions: tb.impressions || 0, clicks: tb.clicks || 0, spend: tb.spend || 0, orders: tb.orders || 0, sales: tb.sales || 0, days: 14, cpc: tb.average_cpc || 0, conv_rate: 0, acos: tb.acos > 0 && tb.sales > 0 ? tb.acos : null, roas: tb.roas || 0 },
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

      // ── SCORE CADA CANDIDATO ────────────────────────────────────────────
      const scored: any[] = [];
      for (const [norm_, cand] of candidates.entries()) {
        const kw = cand.term;
        if (!kw || kw.length < 5) continue;
        if (negativeTexts.some(n => isSimilar(n, kw))) continue;
        if (existingKwTexts.some(e => isSimilar(e, kw))) continue;
        if (productKwTexts.has(kw.toLowerCase())) continue;

        // ── HIGH-PERFORMANCE GUARD (etapa 0b) ────────────────────────────
        // Se já existe como protected_high_performance=true para este ASIN:
        // mantém bid atual, força status='monitoring', não entra no fluxo normal
        const highPerfKey = `${norm_}::${asin}`;
        const highPerfPred = highPerfGuardMap.get(highPerfKey);
        if (highPerfPred) {
          // Garantir que não será rebaixado — apenas atualizar timestamp
          toUpdate.push({
            id: highPerfPred.id,
            last_evaluated_at: now,
            next_evaluation_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
            protected_high_performance: true,
            status: 'monitoring',
          });
          continue;
        }

        const dedupKey = `${norm_}::${asin}`;
        const isExisting = prevNorms.has(dedupKey);

        // ── CROSS-ASIN BOOST (etapa 0a) ───────────────────────────────────
        // Se existe CVR confirmada >= 3% para esta keyword em outro ASIN
        const crossAsinEntry = crossAsinSuccessMap.get(norm_);
        const cross_asin_boost = !!(crossAsinEntry && crossAsinEntry.asin !== asin);

        const features = generateFeatures(kw, product, cand.metrics || {}, negativeTexts);
        if (features.negative_conflict) continue;
        if (features.product_stock === 0) continue;

        // Enriquecer features com CVR do cross-ASIN se presente
        if (cross_asin_boost && crossAsinEntry && features.historical_conversion_rate < crossAsinEntry.cvr) {
          features.historical_conversion_rate = crossAsinEntry.cvr;
          features.cross_asin_boost = true;
        }

        const tailInfo = classifyTailHybrid(kw, allTermsForContext);
        const evidenceLevel = calcEvidenceLevel(features.historical_clicks, features.historical_orders, features.historical_impressions);
        const scores = scoreCandidate(features, targetAcos, tailInfo.tail_type, evidenceLevel);
        if (scores.quality_score < 0.20 && !isExisting) continue;

        const acos_status = classifyAcosStatus(features.historical_acos, features.historical_sales, targetAcos);
        const matchType = 'EXACT';
        const isExperimental = scores.data_confidence < 0.40 || scores.conversion_probability < 0.30;
        const { bid, bid_method } = calcBid(cand.metrics || {}, product, config, isExperimental, tailInfo.tail_type);

        const isBlocked = (features.contradiction_flags && features.contradiction_flags.length > 0) || features.is_generic;
        const hasContradict = features.contradiction_flags && features.contradiction_flags.length > 0;
        const isLongTailEarlyPromo = !isBlocked && tailInfo.tail_type === 'long' && evidenceLevel === 'MEDIUM' && scores.quality_score >= 0.45;

        const status = isBlocked ? 'blocked'
          : isExperimental && !isLongTailEarlyPromo ? 'experimental'
          : isLongTailEarlyPromo ? 'scored'
          : scores.quality_score >= 0.60 && (acos_status === 'PROFITABLE' || acos_status === 'NO_SALES') ? 'scored'
          : 'candidate';

        const reason = buildReason(kw, features, scores, tailInfo, evidenceLevel, isLongTailEarlyPromo, cross_asin_boost);

        const expSales = features.product_price * Math.max(features.historical_conversion_rate, 0.05);
        const expAcos = bid > 0 && expSales > 0 ? (bid / expSales) * 100 : targetAcos;
        const expRoas = expSales > 0 && bid > 0 ? expSales / bid : 0;

        const analysis_windows = JSON.stringify({
          impressions_72h: cand.metrics?.impressions_72h ?? 0,
          clicks_72h: cand.metrics?.clicks_72h ?? 0,
          orders_72h: cand.metrics?.orders_72h ?? 0,
          sales_72h: cand.metrics?.sales_72h ?? 0,
          clicks_7d: cand.metrics?.clicks_7d ?? features.historical_clicks,
          orders_7d: cand.metrics?.orders_7d ?? features.historical_orders,
          sales_7d: cand.metrics?.sales_7d ?? features.historical_sales,
          clicks_14d: features.historical_clicks,
          orders_14d: features.historical_orders,
          sales_14d: features.historical_sales,
          clicks_30d: cand.metrics?.clicks_30d ?? features.historical_clicks,
          orders_30d: cand.metrics?.orders_30d ?? features.historical_orders,
          sales_30d: cand.metrics?.sales_30d ?? features.historical_sales,
        });

        const predRecord: any = {
          amazon_account_id, asin,
          sku: product.sku || '',
          keyword: kw,
          normalized_keyword: norm_,
          match_type: matchType,
          tail_type: tailInfo.tail_type,
          tail_class_method: tailInfo.tail_class_method,
          tail_class_confidence: tailInfo.tail_class_confidence,
          demand_percentile: tailInfo.demand_percentile,
          normalized_search_volume: tailInfo.normalized_search_volume,
          word_count: tailInfo.word_count,
          source: cand.source,
          model_version: modelVersion,
          rule_version: RULE_VERSION,
          relevance_score: features.semScore,
          conversion_probability: scores.conversion_probability,
          keyword_quality_score: scores.quality_score,
          confidence: scores.confidence,
          data_confidence: scores.data_confidence,
          recommended_bid: bid,
          status,
          reason,
          recommended_action: 'create_manual_exact_campaign',
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
          commercial_intent: features.commercial_intent,
          commercial_intent_score: features.commercial_intent_score,
          specificity_score: features.specificity_score,
          product_attribute_match_score: features.product_attribute_match_score,
          evidence_level: evidenceLevel,
          acos_status,
          contradiction_flags: features.contradiction_flags ? JSON.stringify(features.contradiction_flags) : '[]',
          analysis_windows,
          protected_high_performance: false,
          negative_keyword_conflict: false,
          duplicate_keyword: false,
          policy_valid: !hasContradict,
          expected_cpc: bid,
          expected_conversion_rate: Math.max(features.historical_conversion_rate, 0.05),
          expected_acos: Math.round(expAcos * 10) / 10,
          expected_roas: Math.round(expRoas * 100) / 100,
          expected_orders: scores.conversion_probability > 0.5 ? 1 : 0,
          expected_profit: expRoas > 1 ? (expSales - bid) * scores.conversion_probability : 0,
          features_json: JSON.stringify({
            ...features,
            contradiction_flags: features.contradiction_flags,
            tail_semantic_attrs: tailInfo.semantic_attrs ?? [],
            bid_method,
            long_tail_score_bonus: scores.long_tail_score_bonus,
            long_tail_early_promo: isLongTailEarlyPromo,
            cross_asin_boost,
          }).slice(0, 3000),
          last_evaluated_at: now,
          next_evaluation_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
          expires_at: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
        };

        const upsertKey = `${norm_}::${asin}::${modelVersion}`;
        const existingPred = existingPredMap.get(upsertKey);
        if (existingPred) {
          toUpdate.push({ id: existingPred.id, ...predRecord });
        } else {
          predRecord.created_at = now;
          if (!isExisting || scores.quality_score >= 0.60) {
            scored.push(predRecord);
          }
        }
      }

      scored.sort((a, b) => b.keyword_quality_score - a.keyword_quality_score);
      const selected = scored.slice(0, max_per_asin);
      totalCandidates += selected.length;
      toCreate.push(...selected);
      for (const p of selected) prevNorms.add(`${normTerm(p.keyword)}::${p.asin}`);
    }

    if (dry_run) {
      return Response.json({
        ok: true, dry_run: true,
        model_status: modelStatus, readiness_score: readinessScore,
        active_products: activeProducts.length,
        search_terms_processed: enrichedST.length,
        candidates_generated: totalCandidates,
        to_create: toCreate.length,
        to_update: toUpdate.length,
        cross_asin_boosts: toCreate.filter(p => p.features_json?.includes('"cross_asin_boost":true')).length,
        sample: toCreate.slice(0, 5).map(p => {
          const fj = p.features_json ? (() => { try { return JSON.parse(p.features_json); } catch { return {}; } })() : {};
          return {
            keyword: p.keyword, asin: p.asin, tail_type: p.tail_type,
            tail_class_method: p.tail_class_method, demand_percentile: p.demand_percentile,
            match_type: p.match_type, quality_score: p.keyword_quality_score,
            evidence_level: p.evidence_level, acos_status: p.acos_status,
            status: p.status, reason: p.reason,
            bid_method: fj.bid_method, cross_asin_boost: fj.cross_asin_boost,
          };
        }),
        duration_ms: Date.now() - runStart,
      });
    }

    // ── 5. PERSIST — upsert idempotente ─────────────────────────────────────
    let created = 0, updated = 0;
    const persistStart = Date.now();

    for (let i = 0; i < toCreate.length; i += 20) {
      const batch = toCreate.slice(i, i + 20);
      await base44.asServiceRole.entities.KeywordPrediction.bulkCreate(batch);
      created += batch.length;
      if (i + 20 < toCreate.length) await new Promise(r => setTimeout(r, 150));
    }

    for (let i = 0; i < toUpdate.length; i += 20) {
      const batch = toUpdate.slice(i, i + 20);
      await Promise.all(batch.map((u: any) => {
        const { id, created_at: _ca, ...data } = u;
        return base44.asServiceRole.entities.KeywordPrediction.update(id, data).catch(() => {});
      }));
      updated += batch.length;
      if (i + 20 < toUpdate.length) await new Promise(r => setTimeout(r, 150));
    }

    // ── 6. SAVE MODEL VERSION ─────────────────────────────────────────────
    let savedModelVersionId: string | null = null;
    try {
      const mvRecord = await base44.asServiceRole.entities.MLModelVersion.create({
        amazon_account_id,
        version: modelVersion,
        status: modelStatus,
        readiness_score: readinessScore,
        training_date: now,
        total_candidates: created,
        training_records: enrichedST.length,
        training_products: activeProducts.length,
        training_campaigns: (campaigns as any[]).length,
        training_search_terms: enrichedST.length,
        weights_json: JSON.stringify({
          rule_version: RULE_VERSION,
          match_type_policy: 'EXACT_ONLY',
          acos_null_on_zero_sales: true,
          tail_bonus_removed: true,
          relevance_score_canonical: 'title*0.6+bullets*0.3+attrs*0.1',
          evidence_level_independent_of_tail: true,
          long_tail_cvr_bid_enabled: true,
          long_tail_semantic_attr_fallback: true,
          long_tail_early_promo_threshold: 0.45,
          long_tail_score_bonus_on_medium_high_evidence: 0.05,
          cross_asin_boost_enabled: true,
          high_performance_guard_enabled: true,
        }),
        thresholds_json: JSON.stringify({
          min_quality: 0.20,
          min_relevance_for_auto_create: 0.95,
          min_evidence_for_promotion: 'MEDIUM',
          min_conversion_prob: 0.30,
          min_data_confidence: 0.40,
        }),
      });
      savedModelVersionId = mvRecord?.id || null;
    } catch {}

    // ── GUARDRAIL DE TEMPO ────────────────────────────────────────────────────
    const persistElapsed = Date.now() - persistStart;
    const totalElapsed = Date.now() - runStart;
    const timeoutGuard = totalElapsed > 25000;

    let promoted_count = 0;
    let promotion_errors = 0;
    let skipped_promotion = false;
    let calibration_updated = 0;
    let calibration_precision = 0;
    let skipped_calibration = false;

    if (timeoutGuard) {
      skipped_promotion = true;
      skipped_calibration = true;
    } else {
      // ── ETAPA 6: PROMOÇÃO AUTOMÁTICA ─────────────────────────────────────
      // scored + quality >= 0.60 + CVR histórica >= 3% + não existe campanha ativa
      const toPromote = toCreate.filter(p =>
        p.status === 'scored' &&
        p.keyword_quality_score >= 0.60 &&
        p.historical_conversion_rate >= 0.03 &&
        !existingKwTexts.includes(p.keyword.toLowerCase())
      );

      if (toPromote.length > 0) {
        // Buscar produto para cada predição (nome/sku)
        const productMap = new Map((activeProducts as any[]).map(p => [p.asin, p]));

        // Invocar scheduleManualCampaignFromTerm via fetch (service-role) — máx 5 em paralelo
        const appBaseUrl = Deno.env.get('APP_BASE_URL') || '';
        const serviceToken = (req.headers.get('Authorization') || '').replace('Bearer ', '');

        for (let i = 0; i < toPromote.length; i += 5) {
          const batch = toPromote.slice(i, i + 5);
          const results = await Promise.allSettled(
            batch.map(async (p: any) => {
              const prod = productMap.get(p.asin);
              const payload = {
                amazon_account_id,
                asin: p.asin,
                keyword: p.keyword,
                match_type: 'EXACT',
                bid_initial: p.recommended_bid,
                product_name: prod?.product_name || prod?.display_name || p.asin,
                sku: prod?.sku || null,
                source: 'ml_pipeline_auto',
                _service_role: true,
              };

              // Usar fetch interno (evita perda de contexto de auth com invoke)
              const url = `${appBaseUrl}/functions/scheduleManualCampaignFromTerm`;
              const resp = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${serviceToken}` },
                body: JSON.stringify(payload),
              });
              const data = await resp.json().catch(() => ({}));
              if (!data?.ok && !data?.already_exists && !data?.already_queued) {
                throw new Error(data?.error || `HTTP ${resp.status}`);
              }
              return data;
            })
          );

          for (const r of results) {
            if (r.status === 'fulfilled') promoted_count++;
            else promotion_errors++;
          }

          if (i + 5 < toPromote.length) await new Promise(r => setTimeout(r, 300));
        }
      }

      // ── ETAPA 7: RECALIBRAÇÃO INLINE ─────────────────────────────────────
      // Só se há tempo (< 45s total)
      const elapsedBeforeCalib = Date.now() - runStart;
      if (elapsedBeforeCalib < 45000) {
        // Construir kwMetrics do pipeline atual (keywords já carregadas)
        const kwMetrics = new Map<string, any>();
        for (const kw of keywords as any[]) {
          const text = (kw.keyword_text || kw.keyword || '').toLowerCase();
          if (!text) continue;
          const cur = kwMetrics.get(text) || { clicks: 0, spend: 0, orders: 0, sales: 0, impressions: 0 };
          cur.clicks += Number(kw.clicks || 0);
          cur.spend += Number(kw.spend || 0);
          cur.orders += Number(kw.orders || 0);
          cur.sales += Number(kw.sales || 0);
          cur.impressions += Number(kw.impressions || 0);
          kwMetrics.set(text, cur);
        }

        try {
          const calibResult = await runCalibrationInline(
            base44,
            amazon_account_id,
            savedModelVersionId,
            prevPredictions as any[],
            kwMetrics
          );
          calibration_updated = calibResult.updated;
          calibration_precision = calibResult.precision;
        } catch {
          skipped_calibration = true;
        }
      } else {
        skipped_calibration = true;
      }
    }

    // ── LOG DE EXECUÇÃO ───────────────────────────────────────────────────────
    base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id,
      operation: 'ml_pipeline_v4',
      trigger_type: 'automatic',
      status: 'success',
      execution_date: today,
      started_at: new Date(runStart).toISOString(),
      completed_at: now,
      duration_ms: Date.now() - runStart,
      records_processed: created + updated,
      result_summary: JSON.stringify({
        created, updated, promoted_count, promotion_errors,
        calibration_updated, calibration_precision,
        skipped_promotion, skipped_calibration,
        model_status: modelStatus, readiness_score: readinessScore,
      }),
    }).catch(() => {});

    return Response.json({
      ok: true,
      model_status: modelStatus,
      readiness_score: readinessScore,
      active_products: activeProducts.length,
      search_terms_processed: enrichedST.length,
      candidates_generated: totalCandidates,
      created, updated,
      // Novos campos v4
      promoted_count,
      promotion_errors,
      calibration_updated,
      calibration_precision,
      skipped_promotion,
      skipped_calibration,
      ...(timeoutGuard ? { reason: 'timeout_guard' } : {}),
      breakdown: {
        scored: toCreate.filter(p => p.status === 'scored').length,
        experimental: toCreate.filter(p => p.status === 'experimental').length,
        candidate: toCreate.filter(p => p.status === 'candidate').length,
        blocked: toCreate.filter(p => p.status === 'blocked').length,
        exact: toCreate.length,
        phrase: 0,
        broad: 0,
      },
      duration_ms: Date.now() - runStart,
    });

  } catch (err: any) {
    return Response.json({ ok: false, error: err?.message || 'Erro inesperado' }, { status: 500 });
  }
});