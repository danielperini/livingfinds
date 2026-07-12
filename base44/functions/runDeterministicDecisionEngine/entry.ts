/**
 * runDeterministicDecisionEngine — Motor Estratégico Unificado v4
 *
 * FILOSOFIA:
 *   Não apenas reduzir ACoS — maximizar lucro incremental sustentável.
 *   A função principal é:
 *     atrair o comprador certo → para o produto certo → com a intenção certa
 *     → no custo economicamente sustentável → mantendo margem e estoque
 *
 * ARQUITETURA:
 *   Fonte única: PerformanceSettings → AutopilotConfig → system_defaults
 *   Fila única: OptimizationDecision (RuleExecution apenas para auditoria)
 *   Motor único: nenhum motor paralelo gera decisões neste ciclo
 *
 * METODOLOGIA MRC/AMAZON ADS:
 *   Cliques líquidos pós-GIVT/SIVT, janela primária 14d, evidência mínima validada.
 *   Janelas múltiplas: 3d, 7d, 14d, 30d, 60d, 90d — decisão nunca por janela isolada.
 *
 * PROTEÇÕES ECONÔMICAS:
 *   - break_even_acos = contribution_margin_pct
 *   - target_acos_asin = break_even_acos * safety_factor (default 0.80)
 *   - safe_max_cpc = break_even_acos / CVR_estimado
 *   - Margem negativa bloqueia expansão
 *   - Estoque zero bloqueia campanhas
 *   - Dados stale (>48h) bloqueiam aumentos
 *
 * INTENÇÃO DE BUSCA:
 *   Classificação por tipo e purchase_intent_score.
 *   Termos informativos/genéricos recebem score inferior.
 *   Termos de cauda longa comercial têm prioridade.
 *
 * PROTEÇÃO DE ALTA PERFORMANCE:
 *   Campanhas/keywords com vendas consistentes, ACoS abaixo da meta,
 *   e estabilidade em múltiplas janelas são protegidas contra pausa e redução agressiva.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

// ── Fallbacks do sistema ────────────────────────────────────────────────────
const FB = {
  MIN_BID: 0.40, MAX_BID: 1.00,
  MAX_INCREASE_PCT: 0.15, MAX_DECREASE_PCT: 0.20,
  DAILY_BUDGET_CAP: 56,
  TARGET_ACOS: 10, MAX_ACOS: 15,
  TARGET_ROAS: 4, TARGET_TACOS: 5,
  SAFETY_FACTOR: 0.80,         // margem reservada para lucro líquido
  MIN_CONFIDENCE: 0.95,         // confiança mínima para criar campanha
  MIN_RELEVANCE: 0.95,          // relevância mínima produto/termo
  COOLDOWN_HOURS: 72,
  MATURATION_HOURS: 72,
  MIN_STOCK_DAYS: 7,
};

// ── Metodologia MRC ────────────────────────────────────────────────────────
const MRC = {
  MIN_CLICKS: 10,
  MIN_IMPRESSIONS: 200,
  MIN_SPEND: 12.0,
  MIN_CTR: 0.0005,
  ATTRIBUTION_WINDOW: 14,
  DATA_STABLE_DAYS: 30,
  DATA_STALE_HOURS: 48,
};

// ── Hierarquia de prioridade de conflitos ────────────────────────────────────
const PRIORITY = {
  account_security: 1, data_quality: 2, stock: 3, offer_availability: 4,
  margin: 5, budget_global: 6, protect_high_performance: 7, waste_reduction: 8,
  maintenance: 9, scale: 10, expansion: 11, create_campaign: 12,
};

// ── Score final de decisão ────────────────────────────────────────────────────
// decision_priority_score = economic_impact * confidence * urgency * data_quality * inventory * search_intent * goal_alignment
function calcDecisionScore(factors: {
  economic_impact: number; confidence: number; urgency: number;
  data_quality: number; inventory: number; search_intent: number; goal_alignment: number;
}): number {
  return factors.economic_impact * factors.confidence * factors.urgency
    * factors.data_quality * factors.inventory * factors.search_intent * factors.goal_alignment;
}

// ── Classificação de intenção de busca ────────────────────────────────────────
type IntentType = 'brand' | 'category' | 'problem' | 'benefit' | 'feature' | 'comparison'
  | 'competitor' | 'commercial' | 'transactional' | 'informational' | 'long_tail' | 'product_specific';
type PurchaseIntent = 'high' | 'medium' | 'low';

interface SearchIntentResult {
  intent_type: IntentType;
  purchase_intent: PurchaseIntent;
  purchase_intent_score: number; // 0-1
  is_long_tail: boolean;
  word_count: number;
  has_size: boolean;
  has_material: boolean;
  has_brand: boolean;
  has_qualifier: boolean;
  cluster: string;
}

function classifySearchIntent(term: string): SearchIntentResult {
  const t = (term || '').toLowerCase().trim();
  const words = t.split(/\s+/).filter(Boolean);
  const wc = words.length;

  // Indicadores de alta intenção comercial/transacional
  const buySignals = ['comprar', 'melhor', 'barato', 'preço', 'oferta', 'kit', 'conjunto', 'com', 'sem', 'para'];
  const sizeWords = ['litro', 'litros', 'l ', 'ml', 'cm', 'metro', 'metros', 'kg', 'gramas', 'polegada', 'inch', '10l', '11l', '12l', '13l', '18l', '20l', '30l', '50l', 'pequeno', 'grande', 'médio', 'mini', 'maxi'];
  const materialWords = ['inox', 'aço', 'plástico', 'alumínio', 'metal', 'madeira', 'vidro', 'silicone', 'borracha'];
  const problemWords = ['antiodor', 'anti-odor', 'antivazamento', 'silencioso', 'sem ruído', 'vedado', 'hermético'];
  const benefitWords = ['automático', 'automática', 'sensor', 'inteligente', 'smart', 'wifi', 'bluetooth', 'recarregável', 'touch'];
  const locationWords = ['banheiro', 'cozinha', 'escritório', 'quarto', 'sala', 'jardim', 'externo', 'interno', 'pet'];
  const infoWords = ['como', 'o que é', 'qual', 'quando', 'por que', 'tutorial', 'dica', 'review', 'avaliação', 'comparação'];
  const competitorWords = ['vs', 'versus', 'melhor que', 'alternativa'];

  const hasBuySignal = buySignals.some(w => t.includes(w));
  const hasSize = sizeWords.some(w => t.includes(w));
  const hasMaterial = materialWords.some(w => t.includes(w));
  const hasProblem = problemWords.some(w => t.includes(w));
  const hasBenefit = benefitWords.some(w => t.includes(w));
  const hasLocation = locationWords.some(w => t.includes(w));
  const hasInfo = infoWords.some(w => t.startsWith(w) || t.includes(' ' + w + ' '));
  const hasCompetitor = competitorWords.some(w => t.includes(w));
  const hasQualifier = hasMaterial || hasProblem || hasBenefit || hasLocation || hasSize;

  // Determinar tipo de intenção
  let intent_type: IntentType;
  let purchase_intent: PurchaseIntent;
  let purchase_intent_score: number;

  if (hasInfo) {
    intent_type = 'informational';
    purchase_intent = 'low';
    purchase_intent_score = 0.20;
  } else if (hasCompetitor) {
    intent_type = 'comparison';
    purchase_intent = 'medium';
    purchase_intent_score = 0.50;
  } else if (wc >= 3 && (hasSize || hasMaterial) && (hasBenefit || hasProblem || hasLocation)) {
    // Termo muito específico: categoria + atributo + qualificador
    intent_type = 'long_tail';
    purchase_intent = 'high';
    purchase_intent_score = 0.95;
  } else if (wc >= 3 && hasQualifier) {
    intent_type = hasBenefit ? 'benefit' : hasProblem ? 'problem' : hasLocation ? 'feature' : 'commercial';
    purchase_intent = 'high';
    purchase_intent_score = 0.88;
  } else if (wc >= 2 && (hasSize || hasMaterial || hasLocation)) {
    intent_type = hasSize ? 'feature' : hasLocation ? 'feature' : 'commercial';
    purchase_intent = 'high';
    purchase_intent_score = 0.82;
  } else if (hasBenefit && wc >= 2) {
    intent_type = 'benefit';
    purchase_intent = 'medium';
    purchase_intent_score = 0.70;
  } else if (wc === 1 || (wc === 2 && !hasQualifier && !hasBuySignal)) {
    intent_type = 'category';
    purchase_intent = 'low';
    purchase_intent_score = 0.35;
  } else {
    intent_type = 'commercial';
    purchase_intent = 'medium';
    purchase_intent_score = 0.60;
  }

  // Determinar cluster semântico
  let cluster = 'categoria';
  if (hasSize) cluster = 'tamanho';
  else if (hasMaterial) cluster = 'material';
  else if (hasProblem) cluster = 'problema';
  else if (hasBenefit) cluster = 'beneficio';
  else if (hasLocation) cluster = 'uso';
  else if (hasCompetitor) cluster = 'comparacao';
  else if (intent_type === 'long_tail') cluster = 'cauda_longa';
  else if (intent_type === 'informational') cluster = 'informacional';

  return {
    intent_type, purchase_intent, purchase_intent_score,
    is_long_tail: wc >= 3 && hasQualifier,
    word_count: wc,
    has_size: hasSize, has_material: hasMaterial,
    has_brand: false, has_qualifier: hasQualifier,
    cluster,
  };
}

// ── Calcular score de uma keyword/termo ──────────────────────────────────────
interface TermScore {
  product_relevance_score: number;
  purchase_intent_score: number;
  historical_performance_score: number;
  conversion_score: number;
  economic_score: number;
  inventory_score: number;
  amazon_suggestion_score: number;
  final_confidence: number;
  intent: SearchIntentResult;
  blocked: boolean;
  block_reason: string;
}

function scoreKeyword(params: {
  keyword_text: string;
  has_sales: boolean;
  acos_14d: number | null;
  target_acos: number;
  cvr_14d: number;
  cpc_14d: number;
  safe_max_cpc: number;
  stock_days: number;
  margin_confidence: number;
  from_term_bank: boolean;
  from_amazon_suggestion: boolean;
  spend_14d: number;
  clicks_14d: number;
  impressions_14d: number;
  product_match: boolean; // se o produto claramente atende o termo
}): TermScore {
  const intent = classifySearchIntent(params.keyword_text);

  // Product relevance: presença de termos específicos do produto
  const product_relevance_score = params.product_match ? 0.98 : (intent.purchase_intent_score > 0.7 ? 0.85 : 0.60);

  // Historical performance
  let historical_performance_score = 0.5;
  if (params.has_sales && params.acos_14d !== null && params.target_acos > 0) {
    const ratio = params.acos_14d / params.target_acos;
    historical_performance_score = ratio <= 0.7 ? 1.0 : ratio <= 1.0 ? 0.85 : ratio <= 1.3 ? 0.60 : 0.30;
  } else if (params.clicks_14d >= MRC.MIN_CLICKS) {
    historical_performance_score = 0.65; // tem dados mas sem vendas
  } else if (params.from_term_bank) {
    historical_performance_score = 0.70; // banco de termos = evidência histórica
  }

  // Conversion score
  const conversion_score = params.cvr_14d > 0
    ? Math.min(1.0, params.cvr_14d * 20) // 5% CVR = 1.0
    : (params.has_sales ? 0.60 : 0.40);

  // Economic score
  const economic_score = params.acos_14d !== null && params.target_acos > 0
    ? Math.max(0, 1 - (params.acos_14d / (params.target_acos * 1.5)))
    : (params.margin_confidence > 0.5 ? 0.65 : 0.45);

  // Inventory score
  const inventory_score = params.stock_days <= 0 ? 0.0
    : params.stock_days < 7 ? 0.30
    : params.stock_days < 21 ? 0.60
    : 1.0;

  // Amazon suggestion score
  const amazon_suggestion_score = params.from_term_bank ? 0.90
    : params.from_amazon_suggestion ? 0.70 : 0.50;

  // Fórmula ponderada
  const final_confidence =
    product_relevance_score * 0.25 +
    intent.purchase_intent_score * 0.20 +
    historical_performance_score * 0.20 +
    conversion_score * 0.15 +
    economic_score * 0.10 +
    inventory_score * 0.05 +
    amazon_suggestion_score * 0.05;

  // Regras de bloqueio
  let blocked = false;
  let block_reason = '';
  if (product_relevance_score < FB.MIN_RELEVANCE && !params.has_sales) {
    blocked = true; block_reason = `product_relevance_score ${product_relevance_score.toFixed(2)} < ${FB.MIN_RELEVANCE}`;
  } else if (final_confidence < FB.MIN_CONFIDENCE && !params.has_sales) {
    blocked = true; block_reason = `final_confidence ${final_confidence.toFixed(2)} < ${FB.MIN_CONFIDENCE}`;
  } else if (params.stock_days <= 0) {
    blocked = true; block_reason = 'stock_zero';
  } else if (intent.purchase_intent === 'low' && !params.has_sales) {
    blocked = true; block_reason = `low_purchase_intent: ${intent.intent_type}`;
  }

  return {
    product_relevance_score, purchase_intent_score: intent.purchase_intent_score,
    historical_performance_score, conversion_score, economic_score,
    inventory_score, amazon_suggestion_score, final_confidence,
    intent, blocked, block_reason,
  };
}

// ── Classificar estado estratégico do produto ─────────────────────────────────
type ProductState = 'unavailable' | 'critical_stock' | 'low_stock' | 'learning'
  | 'inefficient' | 'profitable' | 'scalable' | 'mature' | 'discontinued';

function classifyProductState(params: {
  stock: number; stock_days: number;
  has_campaign: boolean; days_since_launch: number;
  acos_14d: number | null; target_acos: number;
  roas_14d: number; target_roas: number;
  margin_positive: boolean; spend_14d: number;
  orders_14d: number; trend_3_vs_14: number;
}): ProductState {
  if (params.stock <= 0) return 'unavailable';
  if (params.stock_days < 7) return 'critical_stock';
  if (params.stock_days < 21) return 'low_stock';
  if (!params.has_campaign || params.days_since_launch < 14) return 'learning';
  if (params.spend_14d < 1) return 'learning';
  if (!params.margin_positive && params.spend_14d > 5) return 'inefficient';
  if (params.acos_14d === null) return 'learning';
  if (params.target_acos !== null && params.acos_14d > params.target_acos * 1.5) return 'inefficient';
  if (params.trend_3_vs_14 < -0.20) return 'discontinued'; // queda de 20% recente
  if (params.orders_14d >= 3 && params.target_acos !== null && params.acos_14d <= params.target_acos * 0.7
    && params.target_roas !== null && params.roas_14d >= params.target_roas * 1.2) return 'scalable';
  if (params.orders_14d >= 1 && params.target_acos !== null && params.acos_14d <= params.target_acos) return 'profitable';
  if (params.orders_14d >= 1 && params.target_acos !== null && params.acos_14d <= params.target_acos * 1.3) return 'mature';
  return 'learning';
}

// ── Verificar proteção de alta performance ────────────────────────────────────
function isHighPerformanceProtected(kw: any, settings: any, windows: any): {
  protected: boolean; reason: string;
} {
  const target = settings.target_acos;
  const targetRoas = settings.target_roas;

  // Sem vendas: não é alta performance
  if (!((kw.orders || 0) > 0 || (kw.sales || 0) > 0)) {
    return { protected: false, reason: 'no_sales' };
  }
  // ACoS zero sem vendas = não protegida
  if ((kw.acos || 0) === 0 && (kw.orders || 0) === 0) {
    return { protected: false, reason: 'acos_zero_no_sales' };
  }

  const acos14d = windows?.acos_14d ?? kw.acos ?? 999;
  const acos30d = windows?.acos_30d ?? kw.acos ?? 999;
  const roas14d = windows?.roas_14d ?? kw.roas ?? 0;
  const orders14d = windows?.orders_14d ?? kw.orders ?? 0;
  const orders30d = windows?.orders_30d ?? kw.orders ?? 0;

  // Proteção: estável em múltiplas janelas, ACoS abaixo, ROAS acima, vendas consistentes
  const acosOk14d = target !== null && target > 0 && acos14d <= target;
  const acosOk30d = target !== null && target > 0 && acos30d <= target * 1.1; // ligeira tolerância
  const roasOk = targetRoas !== null && targetRoas > 0 && roas14d >= targetRoas * 0.85;
  const salesConsistent = orders14d >= 2 && orders30d >= 4;

  if (acosOk14d && acosOk30d && salesConsistent) {
    return { protected: true, reason: `consistent_performer: ${orders30d}p/30d, ACoS ${acos14d.toFixed(0)}%` };
  }
  if (roasOk && salesConsistent) {
    return { protected: true, reason: `high_roas_performer: ROAS ${roas14d.toFixed(2)}x, ${orders14d}p/14d` };
  }
  return { protected: false, reason: 'criteria_not_met' };
}

// ── Calcular safe_max_cpc por produto ─────────────────────────────────────────
function calcSafeMaxCpc(params: {
  selling_price: number; gross_margin_pct: number;
  cvr_estimate: number; safety_factor: number;
}): number {
  if (params.selling_price <= 0 || params.gross_margin_pct <= 0) return 0;
  // safe_max_cpc = selling_price * gross_margin_pct * safety_factor * cvr_estimate
  const cpc = params.selling_price * (params.gross_margin_pct / 100) * params.safety_factor * params.cvr_estimate;
  return Math.round(cpc * 100) / 100;
}

// ── Calendário sazonal brasileiro ─────────────────────────────────────────────
function getBrazilEvents(year: number) {
  function lastFriNov(y: number) {
    const d = new Date(y, 11, 0);
    while (d.getDay() !== 5) d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  }
  function nthSunday(y: number, month: number, n: number) {
    const d = new Date(y, month - 1, 1);
    let s = 0;
    while (s < n) { if (d.getDay() === 0) s++; if (s < n) d.setDate(d.getDate() + 1); }
    return d.toISOString().slice(0, 10);
  }
  const bf = lastFriNov(year);
  const cm = new Date(bf); cm.setDate(cm.getDate() + 3);
  return [
    { date: `${year}-01-01`, name: 'Ano Novo', demand: 'moderate_peak', pre: 3, post: 2 },
    { date: nthSunday(year, 5, 2), name: 'Dia das Mães', demand: 'high_peak', pre: 21, post: 2 },
    { date: `${year}-06-12`, name: 'Dia dos Namorados', demand: 'moderate_peak', pre: 14, post: 2 },
    { date: nthSunday(year, 8, 2), name: 'Dia dos Pais', demand: 'high_peak', pre: 14, post: 2 },
    { date: `${year}-10-12`, name: 'Dia das Crianças', demand: 'high_peak', pre: 21, post: 2 },
    { date: bf, name: 'Black Friday', demand: 'very_high_peak', pre: 14, post: 3 },
    { date: cm.toISOString().slice(0, 10), name: 'Cyber Monday', demand: 'very_high_peak', pre: 0, post: 2 },
    { date: `${year}-12-25`, name: 'Natal', demand: 'high_peak', pre: 30, post: 3 },
  ];
}

function getSeasonalContext(dateStr: string) {
  const date = new Date(dateStr + 'T12:00:00');
  const year = date.getFullYear();
  const events = [...getBrazilEvents(year - 1), ...getBrazilEvents(year), ...getBrazilEvents(year + 1)];
  for (const ev of events) {
    const evDate = new Date(ev.date + 'T12:00:00');
    const preMs = ev.pre * 86400000;
    const postMs = ev.post * 86400000;
    if (date >= new Date(evDate.getTime() - preMs) && date <= new Date(evDate.getTime() + postMs)) {
      const daysTo = Math.round((evDate.getTime() - date.getTime()) / 86400000);
      return { event: ev.name, demand: ev.demand, days_to: daysTo, is_high_demand: ['very_high_peak', 'high_peak'].includes(ev.demand) };
    }
  }
  const dow = date.getDay();
  return { event: null, demand: (dow === 0 || dow === 6) ? 'uncertain' : 'normal', days_to: null, is_high_demand: false };
}

// ── Funções utilitárias ────────────────────────────────────────────────────────
function uuid(): string { return `${Date.now()}-${Math.random().toString(36).slice(2)}`; }
function clamp(v: number, min: number, max: number): number { return Math.min(max, Math.max(min, v)); }
function currentHourBRT(): number { return ((new Date().getUTCHours() - 3) + 24) % 24; }

// ── HANDLER PRINCIPAL ────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  const correlationId = uuid();
  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  const base44 = createClientFromRequest(req);

  try {
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));

    // ── Resolver conta ────────────────────────────────────────────────────
    let account: any = null;
    if (body.amazon_account_id) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id });
      account = accs[0];
    }
    if (!account) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      account = accs[0];
    }
    if (!account) return Response.json({ ok: false, error: 'Conta não encontrada.' });
    const aid = account.id;

    // ── 0. Carregar Metas de Performance (Fonte Única Absoluta) ───────────
    let settings: any = null;
    try {
      const psList = await base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id: aid }, '-updated_at', 1);
      if (psList.length > 0) {
        const ps = psList[0];
        // psNum: retorna o valor configurado se > 0, ou null se zero/não configurado.
        // Null = "meta não aplicável" — o motor NÃO usa fallback, apenas ignora a regra.
        // psRequired: para campos operacionais obrigatórios (bids, pcts) usa fallback.
        const psNum = (v: any): number | null => { const n = Number(v); return n > 0 ? n : null; };
        const psReq = (v: any, fb: number): number => { const n = Number(v); return n > 0 ? n : fb; };
        settings = {
          source: 'PerformanceSettings', source_id: ps.id,
          target_acos: psNum(ps.target_acos),       // null = não avaliar ACoS
          max_acos: psNum(ps.max_acos),              // null = não bloquear por ACoS máximo
          target_roas: psNum(ps.target_roas),        // null = não avaliar ROAS
          target_tacos: psNum(ps.target_tacos),      // null = não avaliar TACoS
          min_bid: psReq(ps.min_bid, FB.MIN_BID),
          max_bid: psReq(ps.max_bid, FB.MAX_BID),
          max_cpc: Number(ps.max_cpc ?? 0),
          max_bid_increase_pct: psReq(ps.max_bid_increase_pct, FB.MAX_INCREASE_PCT * 100) / 100,
          max_bid_decrease_pct: psReq(ps.max_bid_decrease_pct, FB.MAX_DECREASE_PCT * 100) / 100,
          daily_budget_cap: psReq(ps.daily_budget_limit, FB.DAILY_BUDGET_CAP),
          min_campaign_budget: psReq(ps.minimum_campaign_budget, 15),
          pacing_enabled: Boolean(ps.pacing_enabled ?? true),
          safety_factor: FB.SAFETY_FACTOR,
          min_confidence: FB.MIN_CONFIDENCE,
          cooldown_hours: FB.COOLDOWN_HOURS,
          maturation_hours: FB.MATURATION_HOURS,
          min_stock_days: FB.MIN_STOCK_DAYS,
          fallback_cvr: psReq(ps.fallback_conversion_rate, 0.05),
        };
      }
    } catch {}

    if (!settings) {
      try {
        const apList = await base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: aid }, null, 1);
        if (apList.length > 0) {
          const cfg = apList[0];
          settings = {
            source: 'AutopilotConfig', source_id: cfg.id,
            target_acos: Number(cfg.target_acos ?? FB.TARGET_ACOS),
            max_acos: Number(cfg.maximum_acos ?? FB.MAX_ACOS),
            target_roas: Number(cfg.target_roas ?? FB.TARGET_ROAS),
            target_tacos: Number(cfg.target_tacos ?? FB.TARGET_TACOS),
            min_bid: Number(cfg.min_bid ?? FB.MIN_BID),
            max_bid: Number(cfg.max_bid ?? FB.MAX_BID),
            max_cpc: Number(cfg.maximum_cpc ?? 0),
            max_bid_increase_pct: Number(cfg.max_bid_increase_pct ?? FB.MAX_INCREASE_PCT * 100) / 100,
            max_bid_decrease_pct: Number(cfg.max_bid_decrease_pct ?? FB.MAX_DECREASE_PCT * 100) / 100,
            daily_budget_cap: Number(cfg.total_daily_budget ?? cfg.daily_budget_limit ?? FB.DAILY_BUDGET_CAP),
            min_campaign_budget: 15,
            pacing_enabled: true,
            safety_factor: FB.SAFETY_FACTOR,
            min_confidence: FB.MIN_CONFIDENCE,
            cooldown_hours: FB.COOLDOWN_HOURS,
            maturation_hours: FB.MATURATION_HOURS,
            min_stock_days: FB.MIN_STOCK_DAYS,
            fallback_cvr: 0.05,
          };
        }
      } catch {}
    }

    if (!settings) {
      settings = {
        source: 'system_defaults', source_id: null,
        target_acos: FB.TARGET_ACOS, max_acos: FB.MAX_ACOS,
        target_roas: FB.TARGET_ROAS, target_tacos: FB.TARGET_TACOS,
        min_bid: FB.MIN_BID, max_bid: FB.MAX_BID, max_cpc: 0,
        max_bid_increase_pct: FB.MAX_INCREASE_PCT,
        max_bid_decrease_pct: FB.MAX_DECREASE_PCT,
        daily_budget_cap: FB.DAILY_BUDGET_CAP,
        min_campaign_budget: 15, pacing_enabled: true,
        safety_factor: FB.SAFETY_FACTOR,
        min_confidence: FB.MIN_CONFIDENCE,
        cooldown_hours: FB.COOLDOWN_HOURS,
        maturation_hours: FB.MATURATION_HOURS,
        min_stock_days: FB.MIN_STOCK_DAYS,
        fallback_cvr: 0.05,
      };
    }

    const settingsSnapshot = JSON.stringify({ ...settings, captured_at: now });

    // ── 1. Validar qualidade dos dados ────────────────────────────────────
    const dataAge = account.last_sync_at
      ? (Date.now() - new Date(account.last_sync_at).getTime()) / 3600000 : 999;
    const dataFreshness: 'fresh' | 'acceptable' | 'stale' =
      dataAge <= 24 ? 'fresh' : dataAge <= 48 ? 'acceptable' : 'stale';

    if (dataAge > MRC.DATA_STALE_HOURS) {
      return Response.json({
        ok: false, skipped: true, correlationId,
        reason: `Dados desatualizados (${Math.round(dataAge)}h). Dados stale bloqueiam aumentos. Execute sync primeiro.`,
        data_freshness: dataFreshness,
        mrc_note: 'Cliques líquidos pós-GIVT/SIVT podem estar desatualizados.'
      });
    }

    // ── 2. Carregar dados em paralelo ─────────────────────────────────────
    const cutoff14d = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
    const cutoff30d = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const cutoff7d  = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const cutoff3d  = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

    const [keywords, campaigns, products, metricsRaw, salesDailyRaw,
           termBankRaw, suggestionRaw, profitLearnings, recentExecs
    ] = await Promise.all([
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: aid }, '-spend', 500),
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid }, null, 200),
      base44.asServiceRole.entities.Product.filter({ amazon_account_id: aid }, null, 100),
      base44.asServiceRole.entities.CampaignMetricsDaily.filter({ amazon_account_id: aid }, '-date', 300).catch(() => []),
      base44.asServiceRole.entities.SalesDaily.filter({ amazon_account_id: aid }, '-date', 500).catch(() => []),
      base44.asServiceRole.entities.TermBank.filter({ amazon_account_id: aid, status: 'active' }, '-score', 200).catch(() => []),
      base44.asServiceRole.entities.KeywordSuggestion.filter({ amazon_account_id: aid, status: 'ranked' }, null, 200).catch(() => []),
      base44.asServiceRole.entities.ProductProfitabilityLearning.filter({ amazon_account_id: aid }, null, 200).catch(() => []),
      base44.asServiceRole.entities.RuleExecution.filter({ amazon_account_id: aid }, '-created_date', 500).catch(() => []),
    ]);

    // ── 3. Construir índices ───────────────────────────────────────────────
    const productMap = new Map(products.map((p: any) => [p.asin, p]));

    // Mapear campaign_id → asin
    const campaignAsinMap = new Map<string, string>();
    for (const c of campaigns) {
      if (c.campaign_id && c.asin) campaignAsinMap.set(c.campaign_id, c.asin);
      if (c.amazon_campaign_id && c.asin) campaignAsinMap.set(c.amazon_campaign_id, c.asin);
    }

    // TermBank: asin → keyword[]
    const termBankByAsin = new Map<string, any[]>();
    for (const t of termBankRaw) {
      if (!t.asin) continue;
      if (!termBankByAsin.has(t.asin)) termBankByAsin.set(t.asin, []);
      termBankByAsin.get(t.asin)!.push(t);
    }

    // Suggestions: asin → keyword[]
    const suggestionsByAsin = new Map<string, any[]>();
    for (const s of suggestionRaw) {
      if (!s.asin) continue;
      if (!suggestionsByAsin.has(s.asin)) suggestionsByAsin.set(s.asin, []);
      suggestionsByAsin.get(s.asin)!.push(s);
    }

    // Profitability learnings: asin/sku → learning
    const profitByAsin = new Map<string, any>();
    for (const pl of profitLearnings) {
      if (pl.asin) profitByAsin.set(pl.asin, pl);
    }

    // ── 4. Agregar métricas por janelas (3d, 7d, 14d, 30d) por keyword ───
    // Também por ASIN para meta dinâmica
    const kwMetrics = new Map<string, any>();
    for (const m of metricsRaw) {
      if (!m.campaign_id) continue;
      const asin = campaignAsinMap.get(m.campaign_id) || null;
      const kws = keywords.filter((k: any) => k.campaign_id === m.campaign_id || k.campaign_id === m.campaign_id);
      // Agregar por campanha → usar ASIN para correlacionar
      // (Métricas por keyword viram de AdsBidChangeLog, métricas por campanha de CampaignMetricsDaily)
    }

    // Agregar por campanha por janela
    const campMetrics = new Map<string, { d3: any; d7: any; d14: any; d30: any }>();
    for (const m of metricsRaw) {
      if (!m.campaign_id || !m.date) continue;
      const key = m.campaign_id;
      if (!campMetrics.has(key)) campMetrics.set(key, {
        d3: { spend: 0, sales: 0, clicks: 0, orders: 0, impressions: 0 },
        d7: { spend: 0, sales: 0, clicks: 0, orders: 0, impressions: 0 },
        d14: { spend: 0, sales: 0, clicks: 0, orders: 0, impressions: 0 },
        d30: { spend: 0, sales: 0, clicks: 0, orders: 0, impressions: 0 },
      });
      const cm = campMetrics.get(key)!;
      const addTo = (obj: any) => {
        obj.spend += m.spend || 0;
        obj.sales += m.sales || 0;
        obj.clicks += m.clicks || 0;
        obj.orders += m.orders || 0;
        obj.impressions += m.impressions || 0;
      };
      if (m.date >= cutoff3d) addTo(cm.d3);
      if (m.date >= cutoff7d) addTo(cm.d7);
      if (m.date >= cutoff14d) addTo(cm.d14);
      if (m.date >= cutoff30d) addTo(cm.d30);
    }

    // Calcular métricas derivadas por janela
    const campWindowMetrics = new Map<string, any>();
    for (const [cid, wm] of campMetrics.entries()) {
      const derive = (w: any) => ({
        ...w,
        acos: w.sales > 0 ? (w.spend / w.sales) * 100 : null,
        roas: w.spend > 0 ? w.sales / w.spend : 0,
        cpc: w.clicks > 0 ? w.spend / w.clicks : 0,
        cvr: w.clicks > 0 ? w.orders / w.clicks : 0,
        ctr: w.impressions > 0 ? w.clicks / w.impressions : 0,
      });
      const d3 = derive(wm.d3), d14 = derive(wm.d14), d30 = derive(wm.d30);
      // Tendências: variação relativa
      const trend_3_vs_14 = d14.sales > 0 ? (d3.sales / (d14.sales / (14 / 3)) - 1) : 0;
      const trend_7_vs_30 = (() => {
        const d7 = derive(wm.d7);
        return d30.sales > 0 ? (d7.sales / (d30.sales / (30 / 7)) - 1) : 0;
      })();
      const trend_14_vs_30 = d30.sales > 0 ? (d14.sales / (d30.sales / 2) - 1) : 0;
      campWindowMetrics.set(cid, { d3, d7: derive(wm.d7), d14, d30, trend_3_vs_14, trend_7_vs_30, trend_14_vs_30 });
    }

    // ── 4b. Comparação ACoS Real vs ACoS Alvo por campanha ───────────────
    // Alimenta decisões com o gap real e orienta escala/redução
    const acosComparisonByCampaign = new Map<string, {
      campaign_id: string; campaign_name: string; asin: string | null;
      real_acos_14d: number | null; real_acos_7d: number | null;
      target_acos: number | null; gap_pct: number | null;
      status: 'below_target' | 'on_target' | 'above_target' | 'critical' | 'no_data';
      sales_14d: number; spend_14d: number; orders_14d: number;
    }>();
    for (const c of campaigns) {
      const cid = c.campaign_id || c.amazon_campaign_id;
      if (!cid) continue;
      const st = String(c.state || c.status || '').toLowerCase();
      if (st === 'archived') continue;
      const wm = campWindowMetrics.get(cid);
      const asin = c.asin || campaignAsinMap.get(cid) || null;
      const asinMeta = asin ? acosByAsin.get(asin) : null;
      const effectiveTarget = asinMeta?.target ?? settings.target_acos;
      const real14d = wm?.d14?.acos ?? null;
      const real7d = wm?.d7?.acos ?? null;
      let compStatus: 'below_target' | 'on_target' | 'above_target' | 'critical' | 'no_data' = 'no_data';
      let gap_pct: number | null = null;
      if (real14d !== null && effectiveTarget !== null) {
        gap_pct = real14d - effectiveTarget; // positivo = acima da meta (ruim), negativo = abaixo (bom)
        if (real14d <= effectiveTarget * 0.75) compStatus = 'below_target';
        else if (real14d <= effectiveTarget * 1.05) compStatus = 'on_target';
        else if (real14d <= effectiveTarget * 1.5) compStatus = 'above_target';
        else compStatus = 'critical';
      }
      acosComparisonByCampaign.set(cid, {
        campaign_id: cid, campaign_name: c.campaign_name || c.name || cid,
        asin, real_acos_14d: real14d, real_acos_7d: real7d,
        target_acos: effectiveTarget, gap_pct, status: compStatus,
        sales_14d: wm?.d14?.sales ?? 0, spend_14d: wm?.d14?.spend ?? 0, orders_14d: wm?.d14?.orders ?? 0,
      });
    }

    // ── 5. Métricas por ASIN (para TACoS e metas dinâmicas) ───────────────
    const salesByAsin = new Map<string, { revenue: number; units: number; days: Set<string> }>();
    for (const s of salesDailyRaw) {
      if (!s.asin || !s.date || s.date < cutoff30d) continue;
      if (!salesByAsin.has(s.asin)) salesByAsin.set(s.asin, { revenue: 0, units: 0, days: new Set() });
      const e = salesByAsin.get(s.asin)!;
      e.revenue += s.ordered_product_sales || 0;
      e.units += s.units_ordered || 0;
      if (s.date) e.days.add(s.date);
    }

    // ── 6. Meta econômica dinâmica por produto ─────────────────────────────
    // break_even_acos = contribution_margin_pct
    // target_acos_asin = break_even_acos * safety_factor
    const acosByAsin = new Map<string, { target: number; break_even: number; safe_max_cpc: number; confidence: string }>();
    for (const p of products) {
      if (!p.asin) continue;
      const pl = profitByAsin.get(p.asin);
      const margin = Number(p.break_even_acos_pct || pl?.gross_margin_pct || p.net_margin_percent || 0);
      if (margin > 0) {
        const break_even = margin; // margem bruta % = break-even ACoS %
        const target = Math.min(FB.MAX_ACOS * 2, Math.max(5, break_even * settings.safety_factor));
        // Estimar safe_max_cpc
        const selling_price = Number(p.price || 0);
        const salesM = salesByAsin.get(p.asin);
        const cvr = salesM && salesM.units > 0 && salesM.days.size > 3
          ? salesM.units / (salesM.units + 50) // estimativa conservadora
          : settings.fallback_cvr;
        const safe_cpc = calcSafeMaxCpc({ selling_price, gross_margin_pct: margin, cvr_estimate: cvr, safety_factor: settings.safety_factor });
        acosByAsin.set(p.asin, {
          target: Math.round(target * 10) / 10,
          break_even: Math.round(break_even * 10) / 10,
          safe_max_cpc: safe_cpc,
          confidence: pl ? 'confirmed' : margin > 0 ? 'estimated' : 'fallback',
        });
      }
    }

    // Persistir metas calculadas (fire-and-forget)
    const productUpdates: any[] = [];
    for (const [asin, meta] of acosByAsin.entries()) {
      const p = productMap.get(asin);
      if (p?.id && Math.abs((p.break_even_acos_pct || 0) - meta.target) > 0.5) {
        productUpdates.push({ id: p.id, break_even_acos_pct: meta.target, break_even_acos: meta.break_even });
      }
    }
    if (productUpdates.length > 0) {
      base44.asServiceRole.entities.Product.bulkUpdate(productUpdates).catch(() => {});
    }

    // ── 7. Gasto real de ontem (guardrail de orçamento) ────────────────────
    // Somar apenas registros com data de ontem (não acumulado histórico)
    const realSpendYesterday = metricsRaw
      .filter((m: any) => m.date === yesterday && (m.spend || 0) > 0)
      .reduce((s: number, m: any) => s + (m.spend || 0), 0);
    // Fallback: se não há dados de ontem, não bloquear por orçamento
    const budgetGuardrailActive = realSpendYesterday > 0 && realSpendYesterday > settings.daily_budget_cap;

    // ── 8. Contexto sazonal ────────────────────────────────────────────────
    const seasonal = getSeasonalContext(today);

    // ── 9. Índice de cooldown (RuleExecution + OptimizationDecision) ───────
    const usedIdemKeys = new Set<string>(
      recentExecs
        .filter((e: any) => (e.created_date || '').slice(0, 10) === today)
        .map((e: any) => e.idempotency_key)
        .filter(Boolean)
    );
    const lastExecByRuleEntity = new Map<string, any>();
    for (const ex of recentExecs) {
      const k = `${ex.rule_key || ex.action_type}|${ex.entity_id || ex.keyword_id}`;
      if (!lastExecByRuleEntity.has(k)) lastExecByRuleEntity.set(k, ex);
    }

    // ── 10. Gerar decisões ────────────────────────────────────────────────
    const decisions: any[] = [];
    const skipped: any[] = [];
    const entityChangedThisCycle = new Map<string, string>();
    const stats = {
      evaluated: 0, protected: 0, held: 0,
      bid_increase: 0, bid_reduce: 0, paused: 0, skipped_stock: 0,
      skipped_margin: 0, skipped_cooldown: 0, skipped_confidence: 0,
      skipped_data: 0, created_campaign: 0,
    };

    // ── 10a. Keywords: regras estratégicas ────────────────────────────────
    for (const kw of keywords) {
      const entityId = kw.keyword_id || kw.id;
      if (!entityId) continue;
      if (entityChangedThisCycle.has(entityId)) continue;

      stats.evaluated++;

      const resolvedAsin = kw.asin || campaignAsinMap.get(kw.campaign_id) || null;
      const product = resolvedAsin ? productMap.get(resolvedAsin) : null;

      // ── Guardrail: estoque ────────────────────────────────────────────
      const stockQty = product?.fba_inventory || 0;
      const salesM = resolvedAsin ? salesByAsin.get(resolvedAsin) : null;
      const realUnits30d = salesM?.units || 0;
      const stockVelocity = realUnits30d / 30;
      const stockCovDays = stockVelocity > 0 ? stockQty / stockVelocity : (stockQty > 0 ? 999 : 0);

      if (stockQty <= 0) {
        // Estoque zero: bid mínimo obrigatório
        const currentBid = kw.bid || kw.current_bid || 0.25;
        if (currentBid > settings.min_bid) {
          const iKey = `stock_zero|${aid}|${entityId}|${today}`;
          if (!usedIdemKeys.has(iKey)) {
            decisions.push(buildDecision(aid, correlationId, {
              decision_type: 'bid_change', entity_type: 'keyword', entity_id: entityId,
              campaign_id: kw.campaign_id, keyword_id: kw.keyword_id, asin: resolvedAsin,
              keyword_text: kw.keyword_text, action: 'set_bid',
              value_before: currentBid, value_after: settings.min_bid,
              rationale: `Estoque zerado. Bid reduzido ao mínimo R$${settings.min_bid} para preservar ranking sem desperdício.`,
              rule_key: 'stock_zero',
              risk: 'low', priority: PRIORITY.stock,
              search_intent: kw.keyword_text ? classifySearchIntent(kw.keyword_text) : null,
              settings_source: settings.source, settings_snapshot: settingsSnapshot,
              idempotency_key: iKey, stock_coverage_days: 0, stock_qty: 0,
            }));
            entityChangedThisCycle.set(entityId, 'stock_zero');
            stats.skipped_stock++;
          }
        }
        continue;
      }

      // Encontrar campanha para métricas por janela
      const campForKw = campaigns.find((c: any) =>
        c.campaign_id === kw.campaign_id || c.amazon_campaign_id === kw.campaign_id
      );
      const wm = campForKw
        ? (campWindowMetrics.get(campForKw.campaign_id) || campWindowMetrics.get(campForKw.amazon_campaign_id))
        : null;

      // Métricas da keyword
      const currentBid = kw.bid || kw.current_bid || 0.25;
      const kw_acos = kw.acos || (wm?.d14?.acos ?? null);
      const kw_clicks = kw.clicks || (wm?.d14?.clicks ?? 0);
      const kw_impressions = kw.impressions || (wm?.d14?.impressions ?? 0);
      const kw_spend = kw.spend || (wm?.d14?.spend ?? 0);
      const kw_orders = kw.orders || (wm?.d14?.orders ?? 0);
      const kw_sales = kw.sales || (wm?.d14?.sales ?? 0);
      const kw_cvr = kw_clicks > 0 ? kw_orders / kw_clicks : 0;
      const kw_cpc = kw_clicks > 0 ? kw_spend / kw_clicks : 0;

      // Meta por produto ou global
      // Quando meta global é null (zerada), usa meta dinâmica do produto ou desativa a regra
      const asinMeta = resolvedAsin ? acosByAsin.get(resolvedAsin) : null;
      const effectiveTargetAcos = asinMeta?.target ?? settings.target_acos; // null se ambos ausentes
      // Gap ACoS real vs alvo para usar no rationale e score
      const campComp = kw.campaign_id ? acosComparisonByCampaign.get(kw.campaign_id) : null;
      const acosGapLabel = campComp?.gap_pct != null
        ? (campComp.gap_pct > 0 ? `+${campComp.gap_pct.toFixed(1)}pp acima da meta` : `${campComp.gap_pct.toFixed(1)}pp abaixo da meta`)
        : '';
      const acosCompStatus = campComp?.status || 'no_data';
      const effectiveMaxAcos = asinMeta
        ? Math.min(asinMeta.break_even, (settings.max_acos ?? FB.MAX_ACOS) * 1.5)
        : settings.max_acos; // null se não configurado e sem meta de produto
      const effectiveSafeMaxCpc = asinMeta?.safe_max_cpc || (settings.max_cpc > 0 ? settings.max_cpc : 0);

      // Verificar proteção de alta performance
      const protection = isHighPerformanceProtected(kw, settings, wm ? {
        acos_14d: wm.d14.acos, acos_30d: wm.d30.acos,
        roas_14d: wm.d14.roas, orders_14d: wm.d14.orders, orders_30d: wm.d30.orders,
      } : null);

      // Classificar intenção de busca da keyword
      const kwIntent = kw.keyword_text ? classifySearchIntent(kw.keyword_text) : null;

      // Verificar cooldown
      const lastExec = lastExecByRuleEntity.get(`bid_change|${entityId}`);
      if (lastExec) {
        const lastTs = lastExec.created_date || lastExec.executed_at;
        if (lastTs && (Date.now() - new Date(lastTs).getTime()) / 3600000 < settings.cooldown_hours) {
          stats.skipped_cooldown++;
          continue;
        }
      }

      // ── Regra: Estoque crítico (< 7 dias) ─────────────────────────────
      if (stockCovDays > 0 && stockCovDays < 7) {
        const newBid = Math.max(settings.min_bid, currentBid * (1 - settings.max_bid_decrease_pct * 0.75));
        const iKey = `stock_critical|${aid}|${entityId}|${today}`;
        if (!usedIdemKeys.has(iKey) && newBid < currentBid) {
          decisions.push(buildDecision(aid, correlationId, {
            decision_type: 'bid_change', entity_type: 'keyword', entity_id: entityId,
            campaign_id: kw.campaign_id, keyword_id: kw.keyword_id, asin: resolvedAsin,
            keyword_text: kw.keyword_text, action: 'set_bid',
            value_before: currentBid, value_after: newBid,
            rationale: `Estoque crítico: ${Math.round(stockCovDays)}d de cobertura. Bid reduzido para preservar margem restante.`,
            rule_key: 'stock_critical',
            risk: 'low', priority: PRIORITY.stock,
            search_intent: kwIntent, settings_source: settings.source, settings_snapshot: settingsSnapshot,
            idempotency_key: iKey, stock_coverage_days: stockCovDays, stock_qty: stockQty,
          }));
          entityChangedThisCycle.set(entityId, 'stock_critical');
          stats.skipped_stock++;
          continue;
        }
      }

      // ── Guardrail: margem ─────────────────────────────────────────────
      if (asinMeta && asinMeta.confidence !== 'fallback') {
        const marginPositive = asinMeta.break_even > 0;
        if (!marginPositive && kw_spend > 5) {
          stats.skipped_margin++;
          skipped.push({ entity_id: entityId, reason: 'negative_margin_blocks_expansion', asin: resolvedAsin });
          continue;
        }
      }

      // ── Evidência mínima para decisão ─────────────────────────────────
      const hasMinEvidence = kw_clicks >= MRC.MIN_CLICKS && kw_impressions >= MRC.MIN_IMPRESSIONS && kw_spend >= MRC.MIN_SPEND;
      const hasCtrQuality = kw_impressions > 0 && (kw_clicks / kw_impressions) >= MRC.MIN_CTR;

      // ── Campanha/keyword protegida: não pode receber redução agressiva ──
      if (protection.protected) {
        stats.protected++;
        // Só permite aumento suave quando há estoque saudável
        if (stockCovDays >= settings.min_stock_days && kw_acos !== null && effectiveTargetAcos !== null && kw_acos <= effectiveTargetAcos * 0.7) {
          const maxIncrease = settings.max_bid_increase_pct * 0.50; // metade do máximo para protegida
          const newBid = clamp(currentBid * (1 + maxIncrease), settings.min_bid, settings.max_bid);
          if (newBid > currentBid * 1.02 && !seasonal.is_high_demand === false) {
            const iKey = `protect_scale|${aid}|${entityId}|${today}`;
            if (!usedIdemKeys.has(iKey)) {
              decisions.push(buildDecision(aid, correlationId, {
                decision_type: 'bid_change', entity_type: 'keyword', entity_id: entityId,
                campaign_id: kw.campaign_id, keyword_id: kw.keyword_id, asin: resolvedAsin,
                keyword_text: kw.keyword_text, action: 'set_bid',
                value_before: currentBid, value_after: newBid,
                rationale: `Campanha protegida em escala segura: ACoS ${kw_acos?.toFixed(1)}% vs meta ${effectiveTargetAcos}%. Aumento suave ${Math.round(maxIncrease * 100)}%.`,
                rule_key: 'protected_scale',
                risk: 'low', priority: PRIORITY.protect_high_performance,
                search_intent: kwIntent, settings_source: settings.source, settings_snapshot: settingsSnapshot,
                idempotency_key: iKey, stock_coverage_days: stockCovDays,
              }));
              entityChangedThisCycle.set(entityId, 'protected_scale');
              stats.bid_increase++;
            }
          }
        }
        continue; // protegida: não aplica outras regras
      }

      // ── Dados insuficientes: hold ─────────────────────────────────────
      if (!hasMinEvidence || !hasCtrQuality) {
        stats.held++;
        // Verificar se estoque baixo e sem impressões (estrutural)
        if (kw_impressions < 50 && kw_spend < 1 && stockCovDays >= settings.min_stock_days) {
          // Possível problema de bid muito baixo
          if (currentBid < settings.min_bid * 1.2) {
            const iKey = `calibrate_bid|${aid}|${entityId}|${today}`;
            if (!usedIdemKeys.has(iKey)) {
              decisions.push(buildDecision(aid, correlationId, {
                decision_type: 'bid_change', entity_type: 'keyword', entity_id: entityId,
                campaign_id: kw.campaign_id, keyword_id: kw.keyword_id, asin: resolvedAsin,
                keyword_text: kw.keyword_text, action: 'set_bid',
                value_before: currentBid, value_after: settings.min_bid * 1.1,
                rationale: `Sem impressões suficientes para análise. Bid calibrado para ${(settings.min_bid * 1.1).toFixed(2)} para gerar dados mínimos.`,
                rule_key: 'calibrate_no_impressions',
                risk: 'low', priority: PRIORITY.maintenance,
                search_intent: kwIntent, settings_source: settings.source, settings_snapshot: settingsSnapshot,
                idempotency_key: iKey,
              }));
              entityChangedThisCycle.set(entityId, 'calibrate');
              stats.bid_increase++;
            }
          }
        }
        continue;
      }

      // ── Regra: ACoS acima do break-even → reduzir ────────────────────
      // Só aplica se effectiveMaxAcos foi configurado (não null)
      if (kw_acos !== null && effectiveMaxAcos !== null && kw_acos > effectiveMaxAcos && kw_spend >= MRC.MIN_SPEND) {
        const reductionPct = kw_acos > effectiveMaxAcos * 1.5
          ? settings.max_bid_decrease_pct
          : settings.max_bid_decrease_pct * 0.5;
        const newBid = clamp(currentBid * (1 - reductionPct), settings.min_bid, settings.max_bid);
        const iKey = `acos_above_max|${aid}|${entityId}|${today}`;
        if (!usedIdemKeys.has(iKey) && newBid < currentBid - 0.01) {
          const intent_label = kwIntent ? `Intenção: ${kwIntent.intent_type} (${kwIntent.purchase_intent})` : '';
          decisions.push(buildDecision(aid, correlationId, {
            decision_type: 'bid_change', entity_type: 'keyword', entity_id: entityId,
            campaign_id: kw.campaign_id, keyword_id: kw.keyword_id, asin: resolvedAsin,
            keyword_text: kw.keyword_text, action: 'set_bid',
            value_before: currentBid, value_after: newBid,
            rationale: `ACoS real ${kw_acos.toFixed(1)}% ACIMA do máximo econômico ${effectiveMaxAcos.toFixed(1)}% (alvo: ${effectiveTargetAcos ?? 'N/A'}%, break-even: ${asinMeta?.break_even?.toFixed(1) || 'N/A'}%). Gap: ${acosGapLabel}. CVR: ${(kw_cvr * 100).toFixed(2)}%. ${intent_label}. Bid reduzido ${Math.round(reductionPct * 100)}% para proteger margem.`,
            rule_key: 'acos_above_max',
            risk: kw_acos > effectiveMaxAcos * 2 ? 'high' : 'medium',
            priority: PRIORITY.margin,
            search_intent: kwIntent, settings_source: settings.source, settings_snapshot: settingsSnapshot,
            idempotency_key: iKey, trend_3_vs_14: wm?.trend_3_vs_14,
          }));
          entityChangedThisCycle.set(entityId, 'acos_reduce');
          stats.bid_reduce++;
        }
        continue;
      }

      // ── Regra: Gasto sem conversão (desperdício) ───────────────────────
      if (kw_spend >= MRC.MIN_SPEND && kw_orders === 0 && kw_clicks >= MRC.MIN_CLICKS) {
        const iKey = `no_conversion|${aid}|${entityId}|${today}`;
        if (!usedIdemKeys.has(iKey)) {
          // Verificar se a intenção é fraca — se sim, sugerir pausa
          const shouldPause = (kwIntent?.purchase_intent === 'low' || kwIntent?.intent_type === 'informational')
            && kw_spend >= MRC.MIN_SPEND * 2;
          const newBid = shouldPause ? settings.min_bid : clamp(currentBid * (1 - settings.max_bid_decrease_pct * 0.7), settings.min_bid, settings.max_bid);
          decisions.push(buildDecision(aid, correlationId, {
            decision_type: shouldPause ? 'pause' : 'bid_change',
            entity_type: 'keyword', entity_id: entityId,
            campaign_id: kw.campaign_id, keyword_id: kw.keyword_id, asin: resolvedAsin,
            keyword_text: kw.keyword_text,
            action: shouldPause ? 'pause_keyword' : 'set_bid',
            value_before: currentBid, value_after: newBid,
            rationale: `${kw_clicks} cliques, R$${kw_spend.toFixed(2)} gastos, ZERO conversões. ${kwIntent ? `Intenção: ${kwIntent.intent_type} (${kwIntent.purchase_intent})` : ''}. ${shouldPause ? 'Intenção fraca — pausar keyword para evitar desperdício.' : 'Bid reduzido para reduzir custo de descoberta.'}`,
            rule_key: shouldPause ? 'no_conversion_pause' : 'no_conversion_reduce',
            risk: 'medium', priority: PRIORITY.waste_reduction,
            search_intent: kwIntent, settings_source: settings.source, settings_snapshot: settingsSnapshot,
            idempotency_key: iKey,
          }));
          entityChangedThisCycle.set(entityId, 'no_conversion');
          if (shouldPause) stats.paused++; else stats.bid_reduce++;
        }
        continue;
      }

      // ── Regra: ACoS abaixo do alvo + vendas → escalar ────────────────
      // Só aplica se effectiveTargetAcos foi configurado (não null)
      if (kw_acos !== null && effectiveTargetAcos !== null && kw_acos <= effectiveTargetAcos * 0.75 && kw_orders >= 1 && kw_sales > 0) {
        // Guardrails de escala
        const cpcOk = effectiveSafeMaxCpc <= 0 || kw_cpc <= effectiveSafeMaxCpc;
        const roasOk = settings.target_roas === null || (kw_spend > 0 && kw_sales / kw_spend >= settings.target_roas * 0.85);
        const stockOk = stockCovDays >= settings.min_stock_days;
        const trendOk = !wm || (wm.trend_3_vs_14 >= -0.15); // não em queda recente

        if (!cpcOk) { skipped.push({ entity_id: entityId, reason: 'cpc_above_safe_max', cpc: kw_cpc, safe_max: effectiveSafeMaxCpc }); continue; }
        if (!stockOk) { stats.skipped_stock++; continue; }

        // Intenção influencia o tamanho do aumento
        const intentBonus = kwIntent?.purchase_intent === 'high' ? 1.0
          : kwIntent?.purchase_intent === 'medium' ? 0.75 : 0.50;
        const baseIncrease = settings.max_bid_increase_pct * intentBonus;
        // Tendência positiva permite aumento maior
        const trendBonus = wm && wm.trend_3_vs_14 > 0.10 ? 1.15 : 1.0;
        const finalIncrease = Math.min(settings.max_bid_increase_pct, baseIncrease * trendBonus);

        const newBid = clamp(currentBid * (1 + finalIncrease), settings.min_bid, settings.max_bid);
        const iKey = `acos_scale|${aid}|${entityId}|${today}`;
        if (!usedIdemKeys.has(iKey) && newBid > currentBid * 1.02) {
          const intentLabel = kwIntent ? `Intenção: ${kwIntent.intent_type} (${kwIntent.purchase_intent}) · Cluster: ${kwIntent.cluster}` : '';
          decisions.push(buildDecision(aid, correlationId, {
            decision_type: 'bid_change', entity_type: 'keyword', entity_id: entityId,
            campaign_id: kw.campaign_id, keyword_id: kw.keyword_id, asin: resolvedAsin,
            keyword_text: kw.keyword_text, action: 'set_bid',
            value_before: currentBid, value_after: newBid,
            rationale: `ACoS real ${kw_acos.toFixed(1)}% ≪ meta ${effectiveTargetAcos}% (gap: ${acosGapLabel}). ${kw_orders}p vendidos. CVR ${(kw_cvr * 100).toFixed(2)}%. ${intentLabel}. Vendas confirmadas — escala segura +${Math.round(finalIncrease * 100)}%.`,
            rule_key: 'acos_scale',
            risk: 'low', priority: PRIORITY.scale,
            search_intent: kwIntent, settings_source: settings.source, settings_snapshot: settingsSnapshot,
            idempotency_key: iKey, trend_3_vs_14: wm?.trend_3_vs_14,
          }));
          entityChangedThisCycle.set(entityId, 'acos_scale');
          stats.bid_increase++;
        }
        continue;
      }

      // ── Regra: CPC acima do safe_max_cpc configurado ───────────────────
      if (effectiveSafeMaxCpc > 0 && kw_cpc > effectiveSafeMaxCpc && kw_clicks >= MRC.MIN_CLICKS) {
        const newBid = clamp(currentBid * (1 - Math.min(settings.max_bid_decrease_pct, 0.20)), settings.min_bid, settings.max_bid);
        const iKey = `cpc_above_safe|${aid}|${entityId}|${today}`;
        if (!usedIdemKeys.has(iKey) && newBid < currentBid - 0.01) {
          decisions.push(buildDecision(aid, correlationId, {
            decision_type: 'bid_change', entity_type: 'keyword', entity_id: entityId,
            campaign_id: kw.campaign_id, keyword_id: kw.keyword_id, asin: resolvedAsin,
            keyword_text: kw.keyword_text, action: 'set_bid',
            value_before: currentBid, value_after: newBid,
            rationale: `CPC R$${kw_cpc.toFixed(2)} ACIMA do máximo seguro R$${effectiveSafeMaxCpc.toFixed(2)} (calculado por break-even + CVR). Margem em risco. Bid reduzido.`,
            rule_key: 'cpc_above_safe_max',
            risk: 'medium', priority: PRIORITY.margin,
            search_intent: kwIntent, settings_source: settings.source, settings_snapshot: settingsSnapshot,
            idempotency_key: iKey,
          }));
          entityChangedThisCycle.set(entityId, 'cpc_safe');
          stats.bid_reduce++;
        }
      }
    }

    // ── 10b. Guardrail global de orçamento ────────────────────────────────
    // Só bloqueia se temos dados reais de ontem E excedeu o cap
    if (budgetGuardrailActive) {
      decisions.forEach((d: any) => {
        if (d.action === 'set_bid' && d.value_after > d.value_before) {
          d.approval_status = 'blocked_budget_cap';
          d.rationale += ` [BLOQUEADO: gasto real ontem R$${realSpendYesterday.toFixed(2)} excedeu cap R$${settings.daily_budget_cap}]`;
        }
      });
    }

    // ── 10c. Priorização das decisões ────────────────────────────────────
    decisions.sort((a: any, b: any) => {
      // Prioridade principal: hierarquia
      if (a.priority !== b.priority) return a.priority - b.priority;
      // Secundário: score de decisão
      return (b.decision_priority_score || 0) - (a.decision_priority_score || 0);
    });

    // ── 11. Gravar OptimizationDecision (fila oficial) ──────────────────
    let saved = 0, savedDecisionIds: string[] = [];
    for (let i = 0; i < decisions.length; i += 50) {
      const batch = decisions.slice(i, i + 50);
      const created = await base44.asServiceRole.entities.OptimizationDecision.bulkCreate(
        batch.map((d: any) => ({
          amazon_account_id: aid,
          run_id: correlationId,
          decision_type: d.decision_type || 'bid_change',
          entity_type: d.entity_type || 'keyword',
          entity_id: d.entity_id,
          campaign_id: d.campaign_id,
          keyword_id: d.keyword_id,
          keyword_text: d.keyword_text,
          asin: d.asin,
          action: d.action,
          value_before: d.value_before,
          value_after: d.value_after,
          rationale: d.rationale,
          risk: d.risk || 'medium',
          confidence: d.confidence || Math.round((d.final_confidence || 0.80) * 100),
          status: 'approved',
          approval_status: d.approval_status || 'auto_approved',
          autopilot_authorized: true,
          requires_approval: false,
          idempotency_key: d.idempotency_key,
          source_function: 'runDeterministicDecisionEngine_v4',
          created_at: now,
          // Campos estratégicos
          search_intent_type: d.search_intent?.intent_type,
          search_intent_cluster: d.search_intent?.cluster,
          purchase_intent: d.search_intent?.purchase_intent,
          purchase_intent_score: d.search_intent?.purchase_intent_score,
          settings_source: d.settings_source,
          data_quality: dataFreshness,
          stock_coverage_days: d.stock_coverage_days,
        }))
      ).catch(() => []);
      saved += batch.length;
      savedDecisionIds.push(...(Array.isArray(created) ? created.map((c: any) => c.id).filter(Boolean) : []));
    }

    // ── 12. Gravar RuleExecution (auditoria) ─────────────────────────────
    const auditRecords = decisions.slice(0, 100).map((d: any) => ({
      amazon_account_id: aid,
      correlation_id: correlationId,
      rule_key: d.rule_key || d.decision_type,
      rule_version: 4,
      entity_type: d.entity_type || 'keyword',
      entity_id: d.entity_id,
      campaign_id: d.campaign_id,
      keyword_id: d.keyword_id,
      asin: d.asin,
      action_type: d.action,
      value_before: d.value_before,
      value_after: d.value_after,
      idempotency_key: d.idempotency_key,
      status: 'pending',
      reason: d.rationale?.slice(0, 500),
      search_intent_type: d.search_intent?.intent_type,
      settings_source: d.settings_source,
    }));
    if (auditRecords.length > 0) {
      await base44.asServiceRole.entities.RuleExecution.bulkCreate(auditRecords).catch(() => {});
    }

    // ── 13. Classificar produtos por estado estratégico ──────────────────
    const productStates: any[] = [];
    for (const p of products) {
      if (!p.asin) continue;
      const salesM = salesByAsin.get(p.asin);
      const campIds = campaigns
        .filter((c: any) => c.asin === p.asin)
        .map((c: any) => c.campaign_id || c.amazon_campaign_id)
        .filter(Boolean);
      const wms = campIds.map((cid: string) => campWindowMetrics.get(cid)).filter(Boolean);
      const agg14d = wms.reduce((acc: any, wm: any) => ({
        acos: wm.d14.acos !== null ? ((acc.acos_sum || 0) + wm.d14.acos) : acc.acos,
        acos_sum: (acc.acos_sum || 0) + (wm.d14.acos || 0),
        roas: acc.roas + wm.d14.roas,
        orders: acc.orders + wm.d14.orders,
        spend: acc.spend + wm.d14.spend,
        cnt: (acc.cnt || 0) + 1,
      }), { acos: 0, acos_sum: 0, roas: 0, orders: 0, spend: 0, cnt: 0 });

      const asinMeta = acosByAsin.get(p.asin);
      const state = classifyProductState({
        stock: p.fba_inventory || 0,
        stock_days: asinMeta ? ((p.fba_inventory || 0) / Math.max(0.01, (salesM?.units || 0) / 30)) : 999,
        has_campaign: (p.has_campaign || campIds.length > 0),
        days_since_launch: p.days_since_launch || 0,
        acos_14d: agg14d.cnt > 0 ? agg14d.acos_sum / agg14d.cnt : null,
        target_acos: asinMeta?.target || settings.target_acos,
        roas_14d: agg14d.cnt > 0 ? agg14d.roas / agg14d.cnt : 0,
        target_roas: settings.target_roas,
        margin_positive: asinMeta ? asinMeta.break_even > 0 : true,
        spend_14d: agg14d.spend,
        orders_14d: agg14d.orders,
        trend_3_vs_14: wms[0]?.trend_3_vs_14 || 0,
      });
      productStates.push({ asin: p.asin, state, acos_target: asinMeta?.target, break_even: asinMeta?.break_even });
    }

    // ── Resposta final ────────────────────────────────────────────────────
    return Response.json({
      ok: true,
      engine: 'unified-strategic-v4',
      correlationId,
      data_freshness: dataFreshness,
      data_age_hours: Math.round(dataAge),

      performance_settings: {
        source: settings.source,
        target_acos: settings.target_acos,
        max_acos: settings.max_acos,
        target_roas: settings.target_roas,
        daily_budget_cap: settings.daily_budget_cap,
        min_bid: settings.min_bid,
        max_bid: settings.max_bid,
        safety_factor: settings.safety_factor,
      },

      economic_context: {
        products_with_dynamic_target: acosByAsin.size,
        real_spend_yesterday: Math.round(realSpendYesterday * 100) / 100,
        budget_cap: settings.daily_budget_cap,
        budget_guardrail_triggered: budgetGuardrailActive,
        products_updated: productUpdates.length,
        sample_dynamic_targets: Array.from(acosByAsin.entries()).slice(0, 5)
          .map(([asin, m]) => ({ asin, target_acos: m.target, break_even: m.break_even, confidence: m.confidence, safe_max_cpc: m.safe_max_cpc })),
      },

      search_intent_summary: {
        keywords_evaluated: stats.evaluated,
        keywords_protected: stats.protected,
        keywords_held_insufficient_data: stats.held,
        intent_distribution: (() => {
          const dist: any = {};
          for (const kw of keywords) {
            if (kw.keyword_text) {
              const intent = classifySearchIntent(kw.keyword_text);
              dist[intent.intent_type] = (dist[intent.intent_type] || 0) + 1;
            }
          }
          return dist;
        })(),
      },

      seasonal_context: seasonal,

      product_strategic_states: productStates,

      decisions_generated: decisions.length,
      decisions_saved: saved,
      stats,
      skipped_count: skipped.length,

      mrc_data_quality: {
        attribution_window_days: MRC.ATTRIBUTION_WINDOW,
        min_clicks_threshold: MRC.MIN_CLICKS,
        min_impressions_threshold: MRC.MIN_IMPRESSIONS,
        min_spend_threshold: MRC.MIN_SPEND,
        data_stale_threshold_hours: MRC.DATA_STALE_HOURS,
      },

      acos_comparison_summary: {
        total_campaigns_analyzed: acosComparisonByCampaign.size,
        below_target: Array.from(acosComparisonByCampaign.values()).filter(c => c.status === 'below_target').length,
        on_target: Array.from(acosComparisonByCampaign.values()).filter(c => c.status === 'on_target').length,
        above_target: Array.from(acosComparisonByCampaign.values()).filter(c => c.status === 'above_target').length,
        critical: Array.from(acosComparisonByCampaign.values()).filter(c => c.status === 'critical').length,
        no_data: Array.from(acosComparisonByCampaign.values()).filter(c => c.status === 'no_data').length,
        worst_campaigns: Array.from(acosComparisonByCampaign.values())
          .filter(c => c.gap_pct !== null && c.gap_pct > 0 && c.spend_14d > 5)
          .sort((a, b) => (b.gap_pct ?? 0) - (a.gap_pct ?? 0))
          .slice(0, 5)
          .map(c => ({ campaign_name: c.campaign_name, real_acos: c.real_acos_14d, target_acos: c.target_acos, gap_pct: c.gap_pct, spend_14d: c.spend_14d, orders_14d: c.orders_14d })),
        best_campaigns: Array.from(acosComparisonByCampaign.values())
          .filter(c => c.gap_pct !== null && c.gap_pct < 0 && c.orders_14d > 0)
          .sort((a, b) => (a.gap_pct ?? 0) - (b.gap_pct ?? 0))
          .slice(0, 5)
          .map(c => ({ campaign_name: c.campaign_name, real_acos: c.real_acos_14d, target_acos: c.target_acos, gap_pct: c.gap_pct, sales_14d: c.sales_14d })),
      },

      note: 'Motor estratégico v4: ACoS real vs ACoS alvo + intenção de busca + metas econômicas dinâmicas + proteção de alta performance.',
    });

  } catch (error: any) {
    console.error('[runDeterministicDecisionEngine-v4]', error.message);
    return Response.json({ ok: false, error: error.message, correlationId }, { status: 500 });
  }
});

// ── Helper para construir decisão padronizada ─────────────────────────────────
function buildDecision(aid: string, correlationId: string, params: any): any {
  const intentScore = params.search_intent?.purchase_intent_score || 0.5;
  const stockFactor = params.stock_coverage_days != null
    ? Math.min(1, (params.stock_coverage_days || 0) / 30) : 1.0;

  const priorityFactor = 1 - ((params.priority || 9) / 13); // 0–1, maior = mais urgente
  const riskFactor = { low: 0.9, medium: 0.7, high: 0.5 }[params.risk as string] || 0.7;

  const decision_priority_score = calcDecisionScore({
    economic_impact: 0.8,
    confidence: 0.9,
    urgency: priorityFactor,
    data_quality: 1.0,
    inventory: stockFactor,
    search_intent: intentScore,
    goal_alignment: riskFactor,
  });

  return {
    ...params,
    amazon_account_id: aid,
    correlation_id: correlationId,
    priority: params.priority || 9,
    decision_priority_score,
    final_confidence: 0.85,
  };
}