/**
 * Campaign Factory — Motor Diário de Aprendizado e Criação de Campanhas
 *
 * Pipeline (PRD §64):
 *  1. Importar Search Terms (AUTO, BROAD, PHRASE)
 *  2. Importar Amazon Suggestions
 *  3. Atualizar KeywordBank
 *  4. Normalizar + Deduplicar
 *  5. Calcular Intent Score (semântico via LLM cache)
 *  6. Calcular Confidence + Economic Score
 *  7. Classificar lifecycle status
 *  8. Detectar Winners (PROVEN / STRONG_WINNER)
 *  9. Gerar Harvest Candidates
 * 10. Verificar duplicate guardrail
 * 11. Calcular bid sustentável
 * 12. Gerar CampaignFactoryPlan
 * 13. Dry-run ou execução conforme auto_creation_level
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import {
  calculateFactoryIntentScore,
  campaignFactoryPlanKey,
  extractFactorySearchTermSignal,
  isFactoryEconomicallyHealthy,
  normalizeFactoryKeyword,
} from '../../shared/campaignFactorySignals.ts';

// ── Config defaults (configuráveis via PerformanceSettings) ──────────────
const DEFAULT_MIN_ORDERS_PROVEN       = 2;
const DEFAULT_MIN_ORDERS_STRONG       = 5;
const DEFAULT_MIN_INTENT_PROVEN       = 75;
const DEFAULT_MIN_CLICKS_PROVEN       = 10;
const DEFAULT_MAX_ACOS_RATIO          = 1.0;   // 100% da meta
const DEFAULT_STRONG_ACOS_RATIO       = 0.80;  // 80% da meta
const DEFAULT_VALIDATION_BUDGET       = 15;    // R$
const DEFAULT_PERFORMANCE_BUDGET      = 20;    // R$
const DEFAULT_MAX_CAMPAIGNS_PER_ASIN  = 2;
const DEFAULT_MAX_NEW_PER_DAY         = 5;
const DEFAULT_LEARNING_WINDOW_H       = 72;
const DEFAULT_HARD_NO_SALE_LIMIT_MULT = 2.0;   // × Target CPA

// ── Normalização ────────────────────────────────────────────────────────
function normalizeKeyword(kw: string): string {
  return normalizeFactoryKeyword(kw);
}

function kwHash(marketplace: string, asin: string, normalized: string, matchType: string, job: string): string {
  return [marketplace, asin, normalized, matchType, job].join('|');
}

// ── Intent Score heurístico (evita LLM por ciclo) ──────────────────────
// Score baseado em sobreposição de tokens com keywords do produto
function calcIntentScore(kwText: string, productName: string, category: string): number {
  return calculateFactoryIntentScore(kwText, productName, category);
}

// ── Sustainable CPC ─────────────────────────────────────────────────────
function calcSustainableCpc(aov: number, cvr: number, targetAcos: number): number {
  if (aov <= 0 || targetAcos <= 0) return 0;
  return parseFloat((aov * cvr * (targetAcos / 100)).toFixed(2));
}

// ── Promotion Score ─────────────────────────────────────────────────────
function calcPromotionScore(entry: any, targetAcos: number): number {
  const orders  = Number(entry.orders  || 0);
  const acos    = Number(entry.acos    || 0);
  const cvr     = Number(entry.cvr     || 0);
  const intent  = Number(entry.intent_score || 0);
  const clicks  = Number(entry.clicks  || 0);
  const cpc     = Number(entry.cpc     || 0);
  const sustnCpc= Number(entry.sustainable_cpc || 0);
  const conf    = Number(entry.confidence_score || 0);

  // Pesos (PRD §38): Performance 40%, Intent 20%, Economic 20%, Confidence 10%, Recency 10%
  const performanceScore = orders > 0
    ? Math.min(100, (orders / DEFAULT_MIN_ORDERS_PROVEN) * 40 + (acos > 0 && acos <= targetAcos ? 30 : 0) + (cvr > 0 ? Math.min(30, cvr * 100) : 0))
    : (clicks > 0 ? Math.min(20, clicks * 2) : 0);

  const economicScore = sustnCpc > 0 && cpc > 0
    ? Math.min(100, Math.max(0, (1 - (cpc / sustnCpc)) * 100))
    : 50;

  const recencyScore = (() => {
    if (!entry.last_seen_at) return 20;
    const daysSince = (Date.now() - new Date(entry.last_seen_at).getTime()) / 86400000;
    return Math.max(0, 100 - daysSince * 5);
  })();

  return Math.round(
    performanceScore * 0.40 +
    intent          * 0.20 +
    economicScore   * 0.20 +
    conf            * 0.10 +
    recencyScore    * 0.10
  );
}

// ── Lifecycle Classification ────────────────────────────────────────────
function classifyLifecycle(entry: any, goal: any): { status: string; winnerTier: string; bankSegment: string } {
  const orders  = Number(entry.orders  || 0);
  const acos    = Number(entry.acos    || 0);
  const clicks  = Number(entry.clicks  || 0);
  const spend   = Number(entry.spend   || 0);
  const intent  = Number(entry.intent_score || 0);
  const promo   = Number(entry.promotion_score || 0);
  const failed  = entry.lifecycle_status === 'FAILED';

  // Hard failures não saem do FAILED sem retest_reason
  if (failed && !entry.retest_eligible) {
    return { status: 'FAILED', winnerTier: 'NONE', bankSegment: 'FAILED_BANK' };
  }

  // In negative bank
  if (entry.in_negative_bank) {
    return { status: 'RETIRED', winnerTier: 'NONE', bankSegment: 'NEGATIVE_BANK' };
  }

  // Hard no-sale limit → FAIL
  const aov         = orders > 0 && entry.sales > 0 ? entry.sales / orders : 0;
  const targetCpa   = aov > 0 ? aov * (goal.target_acos / 100) : 0;
  const hardLimit   = targetCpa * DEFAULT_HARD_NO_SALE_LIMIT_MULT;
  if (orders === 0 && clicks >= DEFAULT_MIN_CLICKS_PROVEN && spend >= hardLimit && hardLimit > 0) {
    return { status: 'FAILED', winnerTier: 'NONE', bankSegment: 'FAILED_BANK' };
  }

  // Não tem dados suficientes
  if (clicks < DEFAULT_MIN_CLICKS_PROVEN && orders === 0) {
    return { status: promo >= 40 ? 'CANDIDATE' : 'SUGGESTION', winnerTier: 'NONE', bankSegment: 'DISCOVERY_BANK' };
  }

  // STRONG_WINNER
  if (
    orders >= goal.min_orders_strong &&
    isFactoryEconomicallyHealthy(entry, goal.target_acos * DEFAULT_STRONG_ACOS_RATIO) &&
    intent >= goal.min_intent_proven
  ) {
    return { status: 'WINNER', winnerTier: 'STRONG_WINNER', bankSegment: 'PROFIT_BANK' };
  }

  // WINNER / PROVEN
  if (
    orders >= goal.min_orders_proven &&
    isFactoryEconomicallyHealthy(entry, goal.target_acos * DEFAULT_MAX_ACOS_RATIO) &&
    intent >= goal.min_intent_proven &&
    clicks >= DEFAULT_MIN_CLICKS_PROVEN
  ) {
    return { status: 'WINNER', winnerTier: 'WINNER', bankSegment: 'PROFIT_BANK' };
  }

  // Uma venda atribuída, economicamente saudável e semanticamente aderente já
  // constitui performance comprovada. Ela ainda não é um WINNER escalável, mas
  // deve aparecer no Factory e pode entrar no harvest controlado.
  if (
    orders >= 1 &&
    isFactoryEconomicallyHealthy(entry, Number(goal.max_acos || goal.target_acos)) &&
    intent >= 72
  ) {
    return { status: 'PROVEN', winnerTier: 'WINNER', bankSegment: 'PROFIT_BANK' };
  }

  // VALIDATING
  if (orders >= 1 || clicks >= DEFAULT_MIN_CLICKS_PROVEN) {
    return { status: 'VALIDATING', winnerTier: 'NONE', bankSegment: 'DISCOVERY_BANK' };
  }

  // BANK_ONLY se baixo score
  if (promo < 40) {
    return { status: 'BANK_ONLY', winnerTier: 'NONE', bankSegment: 'DISCOVERY_BANK' };
  }

  return { status: 'CANDIDATE', winnerTier: 'NONE', bankSegment: 'DISCOVERY_BANK' };
}

// ── Campaign Plan Generator ─────────────────────────────────────────────
function generateCampaignPlan(
  entry: any,
  product: any,
  goal: any,
  campaignsByAsin: any[],
  existingHashes: Set<string>,
  now: string,
  today: string,
): any | null {
  const winnerTier   = entry.winner_tier;
  const lifecycle    = entry.lifecycle_status;
  const sourceType   = entry.source_type;
  const intent       = Number(entry.intent_score || 0);
  const promo        = Number(entry.promotion_score || 0);
  const acos         = Number(entry.acos || 0);
  const targetAcos   = Number(goal.target_acos || 15);
  const sustainCpc   = Number(entry.sustainable_cpc || 0);
  const asin         = entry.asin;

  // Determinar tipo de campanha a criar
  let campaignType: string | null = null;
  let campaignJob = 'VALIDATION';
  let whyCreated = '';
  let matchType  = 'exact';

  if (lifecycle === 'WINNER' && winnerTier === 'STRONG_WINNER') {
    campaignType = 'MANUAL_EXACT';
    campaignJob  = 'SCALE';
    matchType    = 'exact';
    whyCreated   = `Strong Winner: ${entry.orders} pedidos, ACoS ${acos.toFixed(1)}% vs meta ${targetAcos}%`;
  } else if (lifecycle === 'WINNER' || lifecycle === 'PROVEN') {
    campaignType = 'MANUAL_EXACT';
    campaignJob  = sourceType === 'HISTORICAL_WINNER' ? 'PROFIT' : 'PROFIT';
    matchType    = 'exact';
    whyCreated   = `Winner proven: ${entry.orders} pedidos, ACoS ${acos.toFixed(1)}%, Intent ${intent}`;
  } else if ((lifecycle === 'CANDIDATE' || lifecycle === 'VALIDATING') && intent >= 85 && entry.amazon_recommended) {
    campaignType = 'MANUAL_EXACT';
    campaignJob  = 'VALIDATION';
    matchType    = 'exact';
    whyCreated   = `Amazon High Priority Suggestion: Intent ${intent}, sem histórico próprio`;
  } else if (lifecycle === 'CANDIDATE' && intent >= 60 && promo >= 40) {
    campaignType = 'MANUAL_EXACT';
    campaignJob  = 'VALIDATION';
    matchType    = 'exact';
    whyCreated   = `Candidate com Intent ${intent}: adicionado para validação controlada`;
  } else {
    return null; // Não cria
  }

  // Bid calculado pelo sustainable CPC (nunca Amazon suggested)
  let initialBid = sustainCpc > 0 ? sustainCpc : 0.50;
  initialBid = Math.max(Number(goal.min_bid || 0.25), Math.min(Number(goal.max_bid || 2.50), initialBid));
  initialBid = parseFloat(initialBid.toFixed(2));

  // Budget por job
  const budget = campaignJob === 'SCALE' ? DEFAULT_PERFORMANCE_BUDGET * 1.5
    : campaignJob === 'PROFIT' ? DEFAULT_PERFORMANCE_BUDGET
    : DEFAULT_VALIDATION_BUDGET;

  // Nome da campanha (PRD §47)
  const nameSuffix = campaignJob === 'SCALE' ? 'SCALE'
    : campaignJob === 'PROFIT' ? 'PERFORMANCE'
    : 'VALIDATION';
  const campaignName = `SP | MANUAL | EXACT | ${asin} | ${nameSuffix}`;

  // Duplicate check hash (PRD §78)
  const hash = campaignFactoryPlanKey(asin, entry.normalized_keyword, matchType);
  if (existingHashes.has(hash)) {
    return {
      _duplicate: true,
      duplicate_check_hash: hash,
      keyword: entry.keyword,
      asin,
      duplicate_found: true,
      duplicate_action: 'USE_EXISTING',
    };
  }

  // Critérios de sucesso/falha
  const successCriteria = `Orders >=${goal.min_orders_proven} AND ACoS <=${targetAcos}% dentro de ${DEFAULT_LEARNING_WINDOW_H}h com cliques >=${DEFAULT_MIN_CLICKS_PROVEN}`;
  const failureCriteria = `Orders=0 AND Spend >= R$${(initialBid * 15).toFixed(2)} (${DEFAULT_HARD_NO_SALE_LIMIT_MULT}× Target CPA estimado)`;

  return {
    amazon_account_id: entry.amazon_account_id,
    asin,
    sku: product?.sku || '',
    product_name: product?.product_name || product?.display_name || '',
    keyword_bank_id: entry.id,
    keyword: entry.keyword,
    normalized_keyword: entry.normalized_keyword,
    match_type: matchType,
    campaign_job: campaignJob,
    campaign_type: campaignType,
    source_type: sourceType,
    source_campaign_id: entry.source_campaign_id || '',
    why_created: whyCreated,
    source_metrics: entry.source_metrics || JSON.stringify({ orders: entry.orders, acos, intent }),
    target_campaign_name: campaignName,
    initial_bid: initialBid,
    sustainable_cpc: sustainCpc,
    amazon_suggested_bid: entry.amazon_suggested_bid || null,
    initial_budget: budget,
    bidding_strategy: 'DOWN_ONLY',
    target_acos: targetAcos,
    intent_score: intent,
    confidence_score: entry.confidence_score || 0,
    promotion_score: promo,
    negative_plan: JSON.stringify({ auto_negative_after_exact_validation: false, negative_phrase_requires_approval: true }),
    learning_window_hours: DEFAULT_LEARNING_WINDOW_H,
    success_criteria: successCriteria,
    failure_criteria: failureCriteria,
    next_step: campaignJob === 'VALIDATION' ? 'Monitor delivery → PROVEN → promote to PROFIT' : 'Monitor ACoS → if STRONG_WINNER consider SCALE',
    status: 'PROPOSED',
    auto_creation_level: 1,
    duplicate_check_hash: hash,
    duplicate_found: false,
    proposed_at: now,
    cycle_date: today,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// ENTRY POINT
// ─────────────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  const t0 = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const body   = await req.json().catch(() => ({}));
    const { amazon_account_id, dry_run = false, asin_filter } = body;

    // ── Resolver conta ──────────────────────────────────────────────────
    let account: any;
    if (amazon_account_id) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: amazon_account_id }, null, 1);
      account = accs[0];
    } else {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({}, '-created_date', 1);
      account = accs[0];
    }
    if (!account) return Response.json({ ok: false, error: 'Nenhuma conta configurada' }, { status: 404 });

    const accountId = account.id;
    const now   = new Date().toISOString();
    const today = now.slice(0, 10);

    // ── Carregar configurações ──────────────────────────────────────────
    const [perfList, economicsList] = await Promise.all([
      base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id: accountId }, null, 1).catch(() => []),
      base44.asServiceRole.entities.ProductEconomics.filter({ amazon_account_id: accountId }, null, 500).catch(() => []),
    ]);
    const perf = perfList[0] || {};
    const goal = {
      target_acos:       Number(perf.target_acos       || 15),
      max_acos:          Number(perf.max_acos           || 25),
      min_bid:           Number(perf.min_bid            || 0.25),
      max_bid:           Number(perf.max_bid            || 2.50),
      daily_budget_limit:Number(perf.daily_budget_limit || 80),
      min_orders_proven: Number(perf.min_orders_proven  || DEFAULT_MIN_ORDERS_PROVEN),
      min_orders_strong: Number(perf.min_orders_strong  || DEFAULT_MIN_ORDERS_STRONG),
      min_intent_proven: Number(perf.min_intent_proven  || DEFAULT_MIN_INTENT_PROVEN),
    };

    // Break-even por ASIN
    const breakEvenMap = new Map<string, number>();
    const avgAovMap    = new Map<string, number>();
    const avgCvrMap    = new Map<string, number>();
    for (const e of economicsList) {
      if (e.asin) {
        const asin = String(e.asin).toUpperCase();
        breakEvenMap.set(asin, Number(e.break_even_acos || 30));
        avgAovMap.set(asin, Number(e.average_sale_price || e.current_price || 0));
      }
    }

    // ── Carregar dados ─────────────────────────────────────────────────
    const [allProducts, allKeywords, allSearchTerms, allSuggestions, existingBankRaw, termBankRaw] = await Promise.all([
      base44.asServiceRole.entities.Product.filter({ amazon_account_id: accountId }, null, 1000).catch(() => []),
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: accountId }, '-spend', 1000).catch(() => []),
      base44.asServiceRole.entities.SearchTerm.filter({ amazon_account_id: accountId }, '-orders', 1000).catch(() => []),
      base44.asServiceRole.entities.KeywordSuggestion.filter({ amazon_account_id: accountId, status: 'pending' }, '-confidence', 500).catch(() => []),
      base44.asServiceRole.entities.KeywordBank.filter({ amazon_account_id: accountId }, null, 2000).catch(() => []),
      base44.asServiceRole.entities.TermBank.filter({ amazon_account_id: accountId }, '-orders', 5000).catch(() => []),
    ]);

    // Filtrar por ASIN se especificado
    const filterAsin = asin_filter ? String(asin_filter) : null;

    // Maps de lookup
    const productMap   = new Map<string, any>();
    const bankByHash   = new Map<string, any>();
    const bankByKwAsin = new Map<string, any>(); // key: normalized_keyword|asin

    for (const p of allProducts) {
      if (p.asin) productMap.set(String(p.asin).toUpperCase(), p);
    }
    for (const b of existingBankRaw) {
      if (b.keyword_hash)     bankByHash.set(b.keyword_hash, b);
      if (b.normalized_keyword && b.asin) {
        bankByKwAsin.set(`${b.normalized_keyword}|${String(b.asin).toUpperCase()}`, b);
      }
    }

    // ── PASSO 1-3: Coletar sinais e atualizar Bank ─────────────────────
    const bankUpdates: any[]  = [];
    const bankCreates: any[]  = [];
    let termsProcessed = 0;

    // Helper: upsert no bank
    const upsertBank = (
      kwText: string, asin: string, sourceType: string,
      metrics: any, extraFields: any = {},
    ) => {
      if (!kwText || !asin) return;
      asin = String(asin).toUpperCase();
      if (filterAsin && asin !== String(filterAsin).toUpperCase()) return;

      const normalized = normalizeKeyword(kwText);
      if (!normalized) return;

      const product = productMap.get(asin);
      if (!product) return;

      const aov = avgAovMap.get(asin) || Number(product.price || 0);
      const cvr = metrics.clicks > 0 ? (metrics.orders || 0) / metrics.clicks : (avgCvrMap.get(asin) || 0.05);
      const sustnCpc = calcSustainableCpc(aov, cvr, goal.target_acos);

      const kwAsinKey = `${normalized}|${asin}`;
      const existing  = bankByKwAsin.get(kwAsinKey);
      const productTitle = product.product_name || product.display_name || product.title || product.name || '';
      const intentScore = calcIntentScore(kwText, productTitle, product.category || '');

      const acos   = (metrics.spend > 0 && metrics.sales > 0) ? (metrics.spend / metrics.sales) * 100 : 0;
      const ctr    = (metrics.impressions > 0 && metrics.clicks > 0) ? (metrics.clicks / metrics.impressions) * 100 : 0;
      const cpc    = metrics.clicks > 0 ? (metrics.spend || 0) / metrics.clicks : 0;
      const roas   = metrics.spend > 0 ? (metrics.sales || 0) / metrics.spend : 0;

      const entry = {
        amazon_account_id: accountId,
        marketplace: 'BR',
        asin,
        product_family: product.category || '',
        category: product.category || '',
        keyword: kwText,
        normalized_keyword: normalized,
        keyword_hash: kwHash('BR', asin, normalized, extraFields.match_type || 'exact', extraFields.campaign_job || 'VALIDATION'),
        match_type: extraFields.match_type || 'exact',
        campaign_job: extraFields.campaign_job || 'VALIDATION',
        source_type: sourceType,
        source_campaign_id: metrics.campaign_id || '',
        source_date: today,
        source_metrics: JSON.stringify(metrics),
        source_confidence: extraFields.source_confidence || 'MEDIUM',
        // As fontes já são acumuladas pela Amazon. Usar o maior snapshot evita
        // duplicar métricas a cada execução recorrente do Factory.
        impressions: Math.max(Number(existing?.impressions || 0), Number(metrics.impressions || 0)),
        clicks:      Math.max(Number(existing?.clicks || 0), Number(metrics.clicks || 0)),
        orders:      Math.max(Number(existing?.orders || 0), Number(metrics.orders || 0)),
        sales:       Math.max(Number(existing?.sales  || 0), Number(metrics.sales  || 0)),
        spend:       Math.max(Number(existing?.spend  || 0), Number(metrics.spend  || 0)),
        ctr:   parseFloat(ctr.toFixed(4)),
        cpc:   parseFloat(cpc.toFixed(2)),
        cvr:   parseFloat(cvr.toFixed(4)),
        acos:  parseFloat(acos.toFixed(2)),
        roas:  parseFloat(roas.toFixed(2)),
        target_acos: goal.target_acos,
        sustainable_cpc: sustnCpc,
        intent_score: intentScore,
        amazon_recommended: extraFields.amazon_recommended || false,
        amazon_suggested_bid: extraFields.amazon_suggested_bid || null,
        first_seen_at: existing?.first_seen_at || now,
        last_seen_at: now,
        last_updated_at: now,
        ...extraFields,
      };

      if (existing) {
        bankUpdates.push({ id: existing.id, ...entry });
        // Atualizar o cache local
        bankByKwAsin.set(kwAsinKey, { ...existing, ...entry, id: existing.id });
      } else {
        bankCreates.push(entry);
        bankByKwAsin.set(kwAsinKey, entry);
      }
      termsProcessed++;
    };

    // ── Fonte 1: Keywords ativas (EXACT_KEYWORD) ──────────────────────
    for (const kw of allKeywords) {
      if (!kw.asin || !kw.keyword_text) continue;
      const state = (kw.state || kw.status || '').toLowerCase();
      if (state === 'archived') continue;
      upsertBank(kw.keyword_text, kw.asin, 'EXACT_KEYWORD', {
        impressions: kw.impressions || 0, clicks: kw.clicks || 0,
        orders: kw.orders || 0, sales: kw.sales || 0, spend: kw.spend || 0,
        campaign_id: kw.campaign_id,
      }, {
        match_type: kw.match_type || 'exact',
        source_confidence: kw.orders >= 2 ? 'HIGH' : kw.orders >= 1 ? 'MEDIUM' : 'LOW',
      });
    }

    // ── Fonte 2: Search Terms ──────────────────────────────────────────
    for (const st of allSearchTerms) {
      const signal = extractFactorySearchTermSignal(st);
      if (!signal.asin || !signal.keyword) continue;
      // Determinar source_type pelo match type da campanha de origem
      const sourceType = st.match_type === 'broad' ? 'BROAD_SEARCH_TERM'
        : st.match_type === 'phrase' ? 'PHRASE_SEARCH_TERM'
        : 'AUTO_SEARCH_TERM';
      upsertBank(signal.keyword, signal.asin, sourceType, signal.metrics, {
        match_type: 'exact', // Search terms se promovem para exact
        source_confidence: signal.metrics.orders >= 2 ? 'HIGH'
          : signal.metrics.orders >= 1 ? 'MEDIUM'
          : 'LOW',
      });
    }

    // ── Fonte 3: Amazon Keyword Suggestions ───────────────────────────
    for (const sug of allSuggestions) {
      if (!sug.asin && !sug.advertised_asin) continue;
      const targetAsin = sug.asin || sug.advertised_asin;
      const kwText = sug.keyword_text || sug.keyword;
      if (!kwText || !targetAsin) continue;
      upsertBank(kwText, targetAsin, 'AMAZON_KEYWORD_SUGGESTION', {
        impressions: 0, clicks: 0, orders: 0, sales: 0, spend: 0,
      }, {
        match_type: 'exact',
        source_confidence: 'LOW',
        amazon_recommended: true,
        amazon_suggested_bid: sug.suggested_bid || null,
        recommendation_date: today,
      });
    }

    // ── Fonte 4: TermBank histórico já validado ─────────────────────────
    // Converte o acervo real existente no banco operacional do Campaign
    // Factory, preservando ASIN, métricas e origem.
    for (const term of termBankRaw) {
      if (!term.term || !term.asin || term.status === 'archived') continue;
      const termMatchType = String(term.recommended_match_type || term.match_type || 'exact').toLowerCase();
      const termSource = String(term.source || '').toLowerCase();
      const sourceType = termSource === 'cross_asin' ? 'HISTORICAL_WINNER'
        : termSource.includes('search_term') ? 'AUTO_SEARCH_TERM'
        : 'KEYWORD_BANK';
      upsertBank(term.term, term.asin, sourceType, {
        impressions: term.impressions || 0,
        clicks: term.clicks || 0,
        orders: term.orders || 0,
        sales: term.sales || 0,
        spend: term.spend || 0,
        campaign_id: term.campaign_id || term.amazon_campaign_id || '',
      }, {
        match_type: ['exact', 'phrase', 'broad'].includes(termMatchType) ? termMatchType : 'exact',
        source_confidence: Number(term.confidence || 0) >= 90 ? 'VERY_HIGH'
          : Number(term.confidence || 0) >= 75 ? 'HIGH'
          : Number(term.confidence || 0) >= 50 ? 'MEDIUM'
          : 'LOW',
      });
    }

    // ── PASSO 4-6: Calcular scores e classificar lifecycle ─────────────
    // Coletar todas as entradas (existentes + novas) para classificar
    const allBankEntries = [
      ...existingBankRaw,
      ...bankCreates,
    ];

    // Existing updates também precisam de reclassificação
    const bankMap = new Map<string, any>();
    for (const e of allBankEntries) {
      const key = `${e.normalized_keyword}|${e.asin}`;
      bankMap.set(key, e);
    }
    for (const u of bankUpdates) {
      const key = `${u.normalized_keyword}|${u.asin}`;
      bankMap.set(key, u);
    }

    // Recalcular todo o banco para recuperar registros históricos gravados
    // antes da normalização dos aliases dos relatórios.
    const toReclassify = [...bankMap.values()];
    for (const entry of toReclassify) {
      entry.promotion_score = calcPromotionScore(entry, goal.target_acos);
      entry.confidence_score = Math.min(100,
        (entry.clicks >= 50 ? 30 : entry.clicks >= 20 ? 20 : entry.clicks >= 5 ? 10 : 0) +
        (entry.orders >= 5 ? 40 : entry.orders >= 2 ? 25 : entry.orders >= 1 ? 10 : 0) +
        (entry.source_confidence === 'HIGH' || entry.source_confidence === 'VERY_HIGH' ? 30 : entry.source_confidence === 'MEDIUM' ? 15 : 5)
      );

      const { status, winnerTier, bankSegment } = classifyLifecycle(entry, goal);
      entry.lifecycle_status = status;
      entry.winner_tier      = winnerTier;
      entry.bank_segment     = bankSegment;

      // Harvest candidate: winners que não têm campanha criada hoje
      if (status === 'WINNER' || status === 'PROVEN') {
        const recentlyCamped = entry.last_campaign_created_at &&
          (Date.now() - new Date(entry.last_campaign_created_at).getTime()) < 7 * 86400000;
        entry.harvest_candidate = !recentlyCamped;
        if (!recentlyCamped) {
          entry.harvest_action  = winnerTier === 'STRONG_WINNER' ? 'SCALE' : 'CREATE_EXACT';
          entry.harvest_proposed_at = now;
        }
      }

      // Historical best
      if (entry.acos > 0 && (entry.historical_best_acos == null || entry.acos < entry.historical_best_acos)) {
        entry.historical_best_acos = entry.acos;
      }
      if (entry.cvr > 0 && (entry.historical_best_cvr == null || entry.cvr > entry.historical_best_cvr)) {
        entry.historical_best_cvr = entry.cvr;
      }
    }

    // ── Persistir Bank (não-dry_run) ───────────────────────────────────
    let bankCreatedCount = 0;
    let bankUpdatedCount = 0;
    if (!dry_run) {
      if (bankCreates.length > 0) {
        await base44.asServiceRole.entities.KeywordBank.bulkCreate(bankCreates);
        bankCreatedCount = bankCreates.length;
      }
      const persistedUpdates = toReclassify.filter((entry: any) => entry.id);
      // Bulk update em lotes de 100
      for (let i = 0; i < persistedUpdates.length; i += 100) {
        const batch = persistedUpdates.slice(i, i + 100);
        await base44.asServiceRole.entities.KeywordBank.bulkUpdate(batch);
        bankUpdatedCount += batch.length;
      }
    }

    // ── PASSO 8-12: Gerar Campaign Factory Plans ───────────────────────
    const winners      = toReclassify.filter((e: any) =>
      ['WINNER', 'PROVEN'].includes(e.lifecycle_status) && e.harvest_candidate
    );
    const candidates   = toReclassify.filter((e: any) => ['CANDIDATE', 'VALIDATING'].includes(e.lifecycle_status) && e.amazon_recommended && e.intent_score >= 85);

    // Limite de criações por dia (PRD §77)
    const planTargets = [...winners, ...candidates].slice(0, DEFAULT_MAX_NEW_PER_DAY);

    // Deduplicar contra keywords/campanhas e planos reais. O keyword_hash do
    // próprio banco identifica a fonte e não significa que a campanha existe.
    const existingPlans = await base44.asServiceRole.entities.CampaignFactoryPlan.filter({
      amazon_account_id: accountId,
    }, '-proposed_at', 2000).catch(() => []);
    const plansToday = existingPlans.filter((plan: any) => plan.cycle_date === today);
    const existingHashSet = new Set<string>();
    for (const keyword of allKeywords) {
      const state = String(keyword.state || keyword.status || '').toLowerCase();
      if (!keyword.asin || !keyword.keyword_text || state === 'archived') continue;
      existingHashSet.add(campaignFactoryPlanKey(
        keyword.asin,
        keyword.keyword_text,
        keyword.match_type || 'exact',
      ));
    }
    for (const plan of existingPlans) {
      if (['FAILED', 'REJECTED'].includes(String(plan.status || '').toUpperCase())) continue;
      existingHashSet.add(
        plan.duplicate_check_hash
        || campaignFactoryPlanKey(plan.asin, plan.keyword, plan.match_type || 'exact'),
      );
    }

    const plans: any[] = [];
    const dupes: any[] = [];

    for (const entry of planTargets) {
      const product  = productMap.get(entry.asin);
      if (!product) continue;

      // Verificar limite por ASIN (PRD §77)
      const plansForAsin = plansToday.filter((p: any) =>
        p.asin === entry.asin && ['PROPOSED', 'APPROVED', 'EXECUTING'].includes(p.status)
      ).length + plans.filter((p: any) => p.asin === entry.asin).length;
      if (plansForAsin >= DEFAULT_MAX_CAMPAIGNS_PER_ASIN) continue;

      const plan = generateCampaignPlan(entry, product, goal, [], existingHashSet, now, today);
      if (!plan) continue;

      if (plan._duplicate) {
        dupes.push(plan);
        continue;
      }

      // Adicionar hash para evitar duplicata no mesmo ciclo
      existingHashSet.add(plan.duplicate_check_hash);
      plans.push(plan);
    }

    // ── Persistir Plans ────────────────────────────────────────────────
    let plansCreated = 0;
    if (!dry_run && plans.length > 0) {
      await base44.asServiceRole.entities.CampaignFactoryPlan.bulkCreate(plans);
      plansCreated = plans.length;
    }

    // ── Sumário de aprendizado ─────────────────────────────────────────
    const summary = {
      total_bank_entries: bankMap.size,
      winners:         toReclassify.filter((e: any) => ['WINNER', 'PROVEN'].includes(e.lifecycle_status)).length,
      strong_winners:  toReclassify.filter((e: any) => e.winner_tier === 'STRONG_WINNER').length,
      candidates:      toReclassify.filter((e: any) => e.lifecycle_status === 'CANDIDATE').length,
      validating:      toReclassify.filter((e: any) => e.lifecycle_status === 'VALIDATING').length,
      failed:          toReclassify.filter((e: any) => e.lifecycle_status === 'FAILED').length,
      harvest_ready:   toReclassify.filter((e: any) => e.harvest_candidate).length,
      amazon_suggestions: allSuggestions.length,
      term_bank_imported: termBankRaw.length,
    };

    return Response.json({
      ok: true,
      dry_run,
      cycle_date: today,
      terms_processed: termsProcessed,
      bank_created: dry_run ? bankCreates.length : bankCreatedCount,
      bank_updated: dry_run ? toReclassify.filter((entry: any) => entry.id).length : bankUpdatedCount,
      plans_generated: plans.length,
      plans_created: plansCreated,
      duplicates_blocked: dupes.length,
      summary,
      plans: dry_run ? plans.slice(0, 20) : plans.map(p => ({
        asin: p.asin, keyword: p.keyword, campaign_type: p.campaign_type,
        campaign_job: p.campaign_job, initial_bid: p.initial_bid,
        why_created: p.why_created,
      })),
      top_winners: toReclassify
        .filter((e: any) => ['WINNER', 'PROVEN'].includes(e.lifecycle_status))
        .sort((a: any, b: any) => b.promotion_score - a.promotion_score)
        .slice(0, 10)
        .map((e: any) => ({
          keyword: e.keyword, asin: e.asin, orders: e.orders,
          acos: e.acos, intent_score: e.intent_score,
          promotion_score: e.promotion_score, winner_tier: e.winner_tier,
          harvest_action: e.harvest_action,
        })),
      duration_ms: Date.now() - t0,
    });

  } catch (err: any) {
    return Response.json({ ok: false, error: err.message, duration_ms: Date.now() - t0 }, { status: 500 });
  }
});
