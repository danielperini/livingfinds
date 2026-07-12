/**
 * runDeterministicDecisionEngine — Motor Estratégico Unificado v6
 *
 * FILOSOFIA v6:
 *   Busca simultânea de: lucro sustentável, crescimento de vendas, visibilidade,
 *   impression share, proteção de margem, distribuição de orçamento, expansão de
 *   vencedores e redução de desperdício.
 *
 *   Dados econômicos funcionam como: limite · proteção · fator de intensidade ·
 *   prioridade · indicador de risco — NÃO como bloqueio absoluto ao crescimento.
 *
 * NOVIDADES v6 vs v5:
 *   - Estados de oportunidade: low_visibility / emerging_opportunity /
 *     profitable_opportunity / high_growth_opportunity / budget_constrained /
 *     visibility_constrained / conversion_constrained / insufficient_data / no_opportunity
 *   - visibility_score (0–1) e visibility_opportunity_score
 *   - growth_tolerance_factor (1.05 padrão): permite teste até 5% além do limite
 *   - Custo parcial não bloqueia — permite aumento conservador (≤5%)
 *   - Cenários A–E de crescimento com intensidade graduada
 *   - simulate_growth: projeta CPA/ACoS esperado antes de aplicar
 *   - last_growth_action_at / growth_cooldown_until / growth_evaluation_due_at
 *   - Novos rule_keys de crescimento e novos decision_type labels
 *   - low_visibility ≠ low_performance (distinção explícita)
 *   - Aumento de budget para campanhas limitadas por orçamento
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

// ── Fallbacks do sistema ──────────────────────────────────────────────────────
const FB = {
  MIN_BID: 0.40, MAX_BID: 1.00,
  MAX_INCREASE_PCT: 0.15, MAX_DECREASE_PCT: 0.20,
  DAILY_BUDGET_CAP: 56,
  TARGET_ACOS: 10, MAX_ACOS: 15,
  TARGET_ROAS: 4, TARGET_TACOS: 5,
  SAFETY_FACTOR: 0.80,
  MIN_CONFIDENCE: 0.95,
  MIN_RELEVANCE: 0.95,
  COOLDOWN_HOURS: 48,               // bid_change_cooldown_hours = 48
  MATURATION_HOURS: 72,
  MIN_STOCK_DAYS: 7,
  // v6
  GROWTH_TOLERANCE_FACTOR: 1.05,
  MAX_GROWTH_FACTOR: 1.10,
  PARTIAL_COST_MAX_INCREASE: 0.05,
  GROWTH_COOLDOWN_HOURS: 48,        // alinhado ao bid_change_cooldown_hours
  // Sem vendas — revisão e pausa
  NO_SALES_FIRST_REVIEW_HOURS: 72,
  NO_SALES_SECOND_REVIEW_DAYS: 5,
  NO_SALES_CAMPAIGN_PAUSE_DAYS: 7,
  NEW_PRODUCT_MAX_LEARNING_DAYS: 14,
  // Zero impressões
  ZERO_IMP_FIRST_REVIEW_HOURS: 72,
  ZERO_IMP_KEYWORD_PAUSE_DAYS: 14,
  ZERO_IMP_CAMPAIGN_PAUSE_DAYS: 21,
  // Baixas impressões
  LOW_IMP_REVIEW_DAYS: 7,
  LOW_IMP_SECOND_REVIEW_DAYS: 14,
  LOW_IMP_KEYWORD_PAUSE_DAYS: 21,
  // Evidência mínima antes de pausar/agir
  MIN_CLICKS_BEFORE_PAUSE: 20,      // minimum_clicks_before_pause = 20
  MIN_CLICKS_FIRST_REVIEW: 10,      // minimum_clicks_first_review = 10
  MIN_CLICKS_SECOND_REVIEW: 15,     // minimum_clicks_second_review = 15
  MIN_IMP_BEFORE_PAUSE: 200,        // minimum_impressions_before_pause = 200
  // Thresholds de impressões por janela
  LOW_IMP_THRESHOLD_7D: 50,         // low_impressions_threshold_7d = 50
  LOW_IMP_THRESHOLD_14D: 150,       // low_impressions_threshold_14d = 150
  // Freshness e proteção
  MIN_DATA_FRESHNESS_HOURS: 36,     // minimum_data_freshness_hours = 36
  RECENT_SALE_PROTECTION_HOURS: 72, // recent_sale_protection_hours = 72
  WINNER_PROTECTION_ENABLED: true,  // winner_protection_enabled = true
  PAUSE_MOST_SPECIFIC_FIRST: true,  // pause_most_specific_entity_first = true
};

// ── MRC ────────────────────────────────────────────────────────────────────────
const MRC = {
  MIN_CLICKS: 20,                    // minimum_clicks_before_pause = 20
  MIN_IMPRESSIONS: 200,              // minimum_impressions_before_pause = 200
  MIN_SPEND: 12.0,                   // fallback; runtime usa maximum_profitable_cpa quando disponível
  MIN_CTR: 0.0005,
  ATTRIBUTION_WINDOW: 14,
  DATA_STABLE_DAYS: 30,
  DATA_STALE_HOURS: 36,              // minimum_data_freshness_hours = 36
  LOW_VISIBILITY_IMPRESSIONS: 50,   // = low_impressions_threshold_7d
  LOW_IMPRESSION_SHARE: 0.05,
};

// ── Hierarquia de prioridade ──────────────────────────────────────────────────
const PRIORITY = {
  account_security: 1, data_quality: 2, stock: 3, offer_availability: 4,
  margin: 5, profit_erosion: 5, budget_global: 6, protect_high_performance: 7,
  waste_reduction: 8, maintenance: 9,
  // v6 novos — crescimento tem menos prioridade que proteção mas mais que manutenção
  low_visibility_growth: 9, emerging_growth: 10, profitable_growth: 10,
  scale: 10, budget_increase: 10, high_growth: 11, expansion: 11, create_campaign: 12,
};

// ── Opportunity states ────────────────────────────────────────────────────────
type OpportunityState =
  | 'no_opportunity' | 'insufficient_data' | 'low_visibility'
  | 'emerging_opportunity' | 'profitable_opportunity' | 'high_growth_opportunity'
  | 'budget_constrained' | 'visibility_constrained' | 'conversion_constrained';

// ── Incrementos graduados por confiança ──────────────────────────────────────
function getGrowthIncrement(confidence: 'low' | 'moderate' | 'high' | 'very_high' | 'exceptional'): number {
  return { low: 0.03, moderate: 0.05, high: 0.08, very_high: 0.10, exceptional: 0.15 }[confidence];
}

// ── Calcular visibility score (0–1) ──────────────────────────────────────────
function calcVisibilityScore(params: {
  impressions_14d: number;
  impressions_30d: number;
  trend_3_vs_14: number; // positivo = crescendo
  cvr: number;
  stock_days: number;
  is_active: boolean;
  budget_consumed_pct: number; // 0–1
}): {
  visibility_score: number;
  visibility_status: 'very_low' | 'low' | 'moderate' | 'good' | 'high';
  is_low_visibility: boolean;
  trend_impressions: 'growing' | 'stable' | 'declining';
} {
  const { impressions_14d, impressions_30d, trend_3_vs_14, cvr, stock_days, is_active, budget_consumed_pct } = params;

  if (!is_active || stock_days <= 0) {
    return { visibility_score: 0, visibility_status: 'very_low', is_low_visibility: true, trend_impressions: 'stable' };
  }

  // Volume atual vs histórico (normalizado)
  const imp_norm = Math.min(1, impressions_14d / 5000); // 5000 impr/14d = máximo de referência
  // Trend
  const trend_score = trend_3_vs_14 > 0.10 ? 1.0 : trend_3_vs_14 > 0 ? 0.7 : trend_3_vs_14 > -0.10 ? 0.5 : 0.2;
  // CVR signal
  const cvr_score = cvr > 0.05 ? 1.0 : cvr > 0.02 ? 0.7 : cvr > 0 ? 0.4 : 0.2;
  // Budget não saturado = oportunidade
  const budget_score = budget_consumed_pct < 0.95 ? 1.0 : 0.3;
  // Estoque
  const stock_score = stock_days >= 21 ? 1.0 : stock_days >= 7 ? 0.6 : 0.2;

  const visibility_score = Math.round(
    (imp_norm * 0.35 + trend_score * 0.25 + cvr_score * 0.20 + budget_score * 0.10 + stock_score * 0.10) * 100
  ) / 100;

  const status = visibility_score < 0.20 ? 'very_low'
    : visibility_score < 0.40 ? 'low'
    : visibility_score < 0.60 ? 'moderate'
    : visibility_score < 0.80 ? 'good' : 'high';

  const trend_impressions = trend_3_vs_14 > 0.05 ? 'growing' : trend_3_vs_14 < -0.05 ? 'declining' : 'stable';

  return {
    visibility_score,
    visibility_status: status,
    is_low_visibility: impressions_14d < MRC.LOW_VISIBILITY_IMPRESSIONS || status === 'very_low' || status === 'low',
    trend_impressions,
  };
}

// ── Calcular opportunity score ────────────────────────────────────────────────
function calcOpportunityScore(params: {
  visibility_score: number;
  cvr: number;
  has_sales: boolean;
  acos_14d: number | null;
  target_acos: number | null;
  profit_protection_mode: string;
  stock_days: number;
  economic_confidence: 'complete' | 'partial' | 'none';
  impression_share: number; // 0–1, estimado
  cpc: number;
  safe_max_cpc: number;
  data_freshness: string;
}): {
  opportunity_score: number;
  opportunity_state: OpportunityState;
  growth_confidence: 'low' | 'moderate' | 'high' | 'very_high' | 'exceptional';
  can_grow: boolean;
  block_reason: string;
} {
  const {
    visibility_score, cvr, has_sales, acos_14d, target_acos, profit_protection_mode,
    stock_days, economic_confidence, impression_share, cpc, safe_max_cpc, data_freshness,
  } = params;

  // Hard blocks
  if (stock_days <= 0) return { opportunity_score: 0, opportunity_state: 'no_opportunity', growth_confidence: 'low', can_grow: false, block_reason: 'estoque_zero' };
  if (profit_protection_mode === 'paused') return { opportunity_score: 0, opportunity_state: 'no_opportunity', growth_confidence: 'low', can_grow: false, block_reason: 'lucro_negativo_confirmado' };
  if (data_freshness === 'stale') return { opportunity_score: 0, opportunity_state: 'insufficient_data', growth_confidence: 'low', can_grow: false, block_reason: 'dados_desatualizados' };

  // CPC acima do tolerado
  const cpc_ok = safe_max_cpc <= 0 || cpc <= safe_max_cpc * FB.GROWTH_TOLERANCE_FACTOR;
  if (!cpc_ok) return { opportunity_score: 0.1, opportunity_state: 'no_opportunity', growth_confidence: 'low', can_grow: false, block_reason: 'cpc_acima_do_limite' };

  // Lucro em erosão (defensive): crescimento conservador permitido
  const in_defensive = profit_protection_mode === 'defensive';
  const in_vigilant = profit_protection_mode === 'vigilant';

  // Factores do score
  const low_vis_factor = visibility_score < 0.4 ? (1 - visibility_score) : 0.2;
  const relevance_score = has_sales ? 0.9 : cvr > 0 ? 0.7 : 0.5;
  const conversion_factor = cvr > 0.05 ? 1.0 : cvr > 0.02 ? 0.8 : cvr > 0 ? 0.6 : has_sales ? 0.5 : 0.3;
  const inventory_factor = stock_days >= 21 ? 1.0 : stock_days >= 7 ? 0.6 : 0.2;
  const econ_viability = economic_confidence === 'complete' ? 1.0
    : economic_confidence === 'partial' ? 0.7 : 0.4;
  const data_confidence = data_freshness === 'fresh' ? 1.0 : data_freshness === 'acceptable' ? 0.7 : 0.3;
  const impression_factor = impression_share < MRC.LOW_IMPRESSION_SHARE ? 0.9 : impression_share < 0.20 ? 0.7 : 0.5;

  // ACoS factor
  let acos_factor = 0.5;
  if (acos_14d !== null && target_acos !== null && target_acos > 0) {
    acos_factor = acos_14d <= target_acos * 0.75 ? 1.0
      : acos_14d <= target_acos ? 0.8
      : acos_14d <= target_acos * 1.2 ? 0.5 : 0.2;
  }

  const visibility_opportunity_score =
    low_vis_factor * relevance_score * conversion_factor * inventory_factor * econ_viability * data_confidence;

  const opportunity_score = Math.min(1.0, Math.round(
    (visibility_opportunity_score * 0.4 + acos_factor * 0.3 + impression_factor * 0.2 + (has_sales ? 0.1 : 0)) * 100
  ) / 100);

  // Determinar estado
  let opportunity_state: OpportunityState;
  if (opportunity_score < 0.15 || (!has_sales && cvr === 0)) {
    opportunity_state = 'no_opportunity';
  } else if (!has_sales && cvr === 0) {
    opportunity_state = 'insufficient_data';
  } else if (visibility_score < 0.35 && has_sales) {
    opportunity_state = acos_14d !== null && target_acos !== null && acos_14d <= target_acos
      ? 'profitable_opportunity' : 'low_visibility';
  } else if (acos_14d !== null && target_acos !== null && acos_14d <= target_acos * 0.75 && has_sales) {
    const is_high_margin = econ_viability >= 0.8 && conversion_factor >= 0.8 && stock_days >= 21;
    opportunity_state = is_high_margin ? 'high_growth_opportunity' : 'profitable_opportunity';
  } else if (cvr > 0 && has_sales && visibility_score < 0.45) {
    opportunity_state = 'emerging_opportunity';
  } else if (visibility_score < 0.4 && !has_sales && cvr > 0) {
    opportunity_state = 'visibility_constrained';
  } else {
    opportunity_state = 'insufficient_data';
  }

  // Nível de confiança
  let growth_confidence: 'low' | 'moderate' | 'high' | 'very_high' | 'exceptional';
  if (opportunity_score >= 0.80 && economic_confidence === 'complete' && stock_days >= 21) {
    growth_confidence = 'exceptional';
  } else if (opportunity_score >= 0.65 && economic_confidence !== 'none') {
    growth_confidence = 'very_high';
  } else if (opportunity_score >= 0.50) {
    growth_confidence = 'high';
  } else if (opportunity_score >= 0.35) {
    growth_confidence = 'moderate';
  } else {
    growth_confidence = 'low';
  }

  // Defensivo e vigilante: rebaixar confiança
  if (in_defensive) growth_confidence = growth_confidence === 'exceptional' ? 'moderate' : growth_confidence === 'very_high' ? 'moderate' : 'low';
  if (in_vigilant) growth_confidence = growth_confidence === 'exceptional' ? 'high' : growth_confidence === 'very_high' ? 'moderate' : growth_confidence;

  const can_grow = opportunity_score >= 0.20 && stock_days > 0 && profit_protection_mode !== 'paused';
  const block_reason = can_grow ? '' : `opportunity_score ${opportunity_score} insuficiente`;

  return { opportunity_score, opportunity_state, growth_confidence, can_grow, block_reason };
}

// ── Simular crescimento ────────────────────────────────────────────────────────
function simulateGrowth(params: {
  current_bid: number;
  increase_pct: number;
  current_impressions: number;
  cvr: number;
  cpc: number;
  avg_order_value: number;
  contribution_margin_amount: number;
  safe_max_cpc: number;
  growth_tolerance_factor: number;
}): {
  proposed_bid: number;
  expected_impression_gain: number;
  expected_additional_orders: number;
  expected_additional_revenue: number;
  expected_additional_spend: number;
  expected_cpa: number;
  expected_acos: number | null;
  expected_profit: number;
  risk_score: number;
  approved: boolean;
  experimental: boolean;
  reason: string;
} {
  const {
    current_bid, increase_pct, current_impressions, cvr, cpc,
    avg_order_value, contribution_margin_amount, safe_max_cpc, growth_tolerance_factor,
  } = params;

  const proposed_bid = Math.round(current_bid * (1 + increase_pct) * 100) / 100;
  // Estimativa simples: aumento de bid proporcional a impressões esperadas
  const impression_multiplier = 1 + increase_pct * 2; // cada 1% de bid = ~2% de impressão extra (simplificado)
  const expected_impressions = current_impressions * impression_multiplier;
  const expected_impression_gain = expected_impressions - current_impressions;

  // CTR médio do mercado brasileiro de 0.4% (fallback)
  const estimated_ctr = current_impressions > 0 ? Math.min(0.05, cpc / (proposed_bid * 1000 + 1)) : 0.004;
  const expected_additional_clicks = expected_impression_gain * estimated_ctr;
  const expected_additional_orders = Math.round(expected_additional_clicks * cvr * 100) / 100;
  const expected_additional_revenue = expected_additional_orders * avg_order_value;
  const expected_additional_spend = expected_additional_clicks * proposed_bid;
  const expected_cpa = expected_additional_orders > 0 ? expected_additional_spend / expected_additional_orders : expected_additional_spend;
  const expected_acos = expected_additional_revenue > 0 ? (expected_additional_spend / expected_additional_revenue) * 100 : null;
  const expected_profit = contribution_margin_amount > 0
    ? (contribution_margin_amount - expected_cpa) * expected_additional_orders
    : -expected_additional_spend;

  const cpc_limit = safe_max_cpc * growth_tolerance_factor;
  const approved = proposed_bid <= cpc_limit || safe_max_cpc <= 0;
  const experimental = !approved || expected_additional_orders < 0.5;
  const risk_score = Math.min(1.0, (proposed_bid / Math.max(0.01, safe_max_cpc > 0 ? safe_max_cpc : proposed_bid)));
  const reason = approved
    ? `Bid proposto R$${proposed_bid.toFixed(2)} abaixo do limite R$${cpc_limit.toFixed(2)}. CPA esperado: R$${expected_cpa.toFixed(2)}.`
    : `Bid proposto R$${proposed_bid.toFixed(2)} excede limite econômico R$${cpc_limit.toFixed(2)}.`;

  return {
    proposed_bid, expected_impression_gain, expected_additional_orders,
    expected_additional_revenue, expected_additional_spend,
    expected_cpa, expected_acos, expected_profit,
    risk_score, approved, experimental, reason,
  };
}

// ── Calcular funil econômico ───────────────────────────────────────────────────
function calcFunnel(params: {
  impressions: number; clicks: number; orders: number;
  spend: number; sales: number;
  contribution_margin_amount: number;
  minimum_profit_per_order?: number;
}): {
  ctr: number; cvr: number; cpc: number; actual_cpa: number; expected_cpa: number;
  ecpm: number; impressions_per_order: number;
  maximum_profitable_cpa: number;
  profit_after_ads: number; profit_after_ads_percent: number;
  is_economically_sustainable: boolean;
  ad_spend_per_order: number;
} {
  const { impressions, clicks, orders, spend, sales, contribution_margin_amount, minimum_profit_per_order = 0 } = params;
  const ctr = impressions > 0 ? clicks / impressions : 0;
  const cvr = clicks > 0 ? orders / clicks : 0;
  const cpc = clicks > 0 ? spend / clicks : 0;
  const actual_cpa = orders > 0 ? spend / orders : 0;
  const ecpm = impressions > 0 ? (spend / impressions) * 1000 : 0;
  const impressions_per_order = orders > 0 ? impressions / orders : 0;
  const expected_cpa = cvr > 0 ? cpc / cvr : (cpc > 0 ? cpc * 20 : 0);
  const maximum_profitable_cpa = Math.max(0, contribution_margin_amount - minimum_profit_per_order);
  const ad_spend_per_order = orders > 0 ? spend / orders : spend > 0 ? spend : 0;
  const profit_after_ads = contribution_margin_amount - (orders > 0 ? ad_spend_per_order : 0);
  const profit_after_ads_percent = sales > 0 ? (profit_after_ads / (sales / Math.max(1, orders))) * 100 : 0;
  const is_economically_sustainable = maximum_profitable_cpa > 0
    && (orders > 0 ? actual_cpa <= maximum_profitable_cpa : expected_cpa <= maximum_profitable_cpa);
  return { ctr, cvr, cpc, actual_cpa, expected_cpa, ecpm, impressions_per_order, maximum_profitable_cpa, profit_after_ads, profit_after_ads_percent, is_economically_sustainable, ad_spend_per_order };
}

// ── Calcular Lucro Pós-ADS por janela ─────────────────────────────────────────
function calcProfitAfterAds(params: {
  contribution_margin_amount: number;
  spend: number;
  orders: number;
}): { profit_after_ads: number; ad_spend_per_order: number } {
  if (params.orders <= 0) return { profit_after_ads: params.contribution_margin_amount, ad_spend_per_order: 0 };
  const ad_spend_per_order = params.spend / params.orders;
  return { profit_after_ads: params.contribution_margin_amount - ad_spend_per_order, ad_spend_per_order };
}

// ── Classificar status econômico ──────────────────────────────────────────────
function classifyEconomicStatus(econ: any | null): {
  status: 'complete' | 'partial' | 'missing_cost' | 'missing_price' | 'negative_margin' | 'unknown';
  economic_data_incomplete: boolean;
  block_expansion: boolean; // v6: apenas bloqueia em negativo confirmado
  allow_conservative_growth: boolean; // v6: custo parcial pode crescer com limite
  economic_confidence: 'complete' | 'partial' | 'none';
  block_reason: string;
} {
  if (!econ) return {
    status: 'missing_cost', economic_data_incomplete: true, block_expansion: false,
    allow_conservative_growth: true, economic_confidence: 'none',
    block_reason: 'economic_data_incomplete: custo não cadastrado — crescimento conservador permitido',
  };
  if (!econ.unit_cost || Number(econ.unit_cost) <= 0) return {
    status: 'missing_cost', economic_data_incomplete: true, block_expansion: false,
    allow_conservative_growth: true, economic_confidence: 'none',
    block_reason: 'unit_cost ausente — teste conservador ≤5% permitido',
  };
  if (!econ.current_price || Number(econ.current_price) <= 0) return {
    status: 'missing_price', economic_data_incomplete: true, block_expansion: false,
    allow_conservative_growth: true, economic_confidence: 'partial',
    block_reason: 'preço ausente — crescimento conservador permitido',
  };
  const margin = Number(econ.contribution_margin_amount || 0);
  if (margin < 0) return {
    status: 'negative_margin', economic_data_incomplete: false, block_expansion: true,
    allow_conservative_growth: false, economic_confidence: 'complete',
    block_reason: `Margem negativa confirmada R$${margin.toFixed(2)} — crescimento bloqueado`,
  };
  if (margin === 0) return {
    status: 'partial', economic_data_incomplete: false, block_expansion: false,
    allow_conservative_growth: true, economic_confidence: 'partial',
    block_reason: 'Margem zero — somente crescimento conservador',
  };
  if (!econ.amazon_fee_amount && !econ.amazon_fee_percent) return {
    status: 'partial', economic_data_incomplete: false, block_expansion: false,
    allow_conservative_growth: true, economic_confidence: 'partial', block_reason: '',
  };
  return {
    status: 'complete', economic_data_incomplete: false, block_expansion: false,
    allow_conservative_growth: true, economic_confidence: 'complete', block_reason: '',
  };
}

// ── Classificar proteção de lucro ─────────────────────────────────────────────
function classifyProfitProtection(params: {
  profit_after_ads_14d: number;
  profit_after_ads_3d: number;
  profit_before_ads: number;
}): { mode: 'normal' | 'vigilant' | 'defensive' | 'paused'; erosion_velocity: number; alert: boolean; reason: string } {
  const { profit_after_ads_14d, profit_after_ads_3d, profit_before_ads } = params;
  if (profit_before_ads <= 0) return { mode: 'normal', erosion_velocity: 0, alert: false, reason: 'no_margin_data' };
  const erosion_velocity = (profit_after_ads_3d - profit_after_ads_14d) / profit_before_ads;
  if (profit_after_ads_3d < 0) return { mode: 'paused', erosion_velocity, alert: true, reason: `Lucro pós-ADS negativo: R$${profit_after_ads_3d.toFixed(2)}/pedido em 3d` };
  if (erosion_velocity < -0.30 && profit_after_ads_14d > 0) return { mode: 'defensive', erosion_velocity, alert: true, reason: `Erosão de ${Math.abs(erosion_velocity * 100).toFixed(0)}% da margem em 3d vs 14d` };
  if (profit_after_ads_14d < profit_before_ads * 0.20 && profit_after_ads_14d >= 0) return { mode: 'vigilant', erosion_velocity, alert: false, reason: `Lucro pós-ADS baixo: R$${profit_after_ads_14d.toFixed(2)}/pedido` };
  return { mode: 'normal', erosion_velocity, alert: false, reason: 'margin_healthy' };
}

// ── Score de decisão ─────────────────────────────────────────────────────────
function calcDecisionScore(factors: {
  opportunity: number; economic_impact: number; confidence: number;
  visibility_gap: number; inventory: number; conversion: number; goal_alignment: number;
}): number {
  return factors.opportunity * factors.economic_impact * factors.confidence
    * factors.visibility_gap * factors.inventory * factors.conversion * factors.goal_alignment;
}

// ── Intenção de busca ─────────────────────────────────────────────────────────
type IntentType = 'brand' | 'category' | 'problem' | 'benefit' | 'feature' | 'comparison'
  | 'competitor' | 'commercial' | 'transactional' | 'informational' | 'long_tail' | 'product_specific';
type PurchaseIntent = 'high' | 'medium' | 'low';

function classifySearchIntent(term: string): {
  intent_type: IntentType; purchase_intent: PurchaseIntent;
  purchase_intent_score: number; is_long_tail: boolean;
  word_count: number; has_size: boolean; has_material: boolean;
  has_brand: boolean; has_qualifier: boolean; cluster: string;
} {
  const t = (term || '').toLowerCase().trim();
  const words = t.split(/\s+/).filter(Boolean);
  const wc = words.length;
  const buySignals = ['comprar', 'melhor', 'barato', 'preço', 'oferta', 'kit', 'conjunto', 'com', 'sem', 'para'];
  const sizeWords = ['litro', 'litros', 'ml', 'cm', 'metro', 'metros', 'kg', 'polegada', '10l', '11l', '12l', '13l', '18l', '20l', '30l', '50l', 'pequeno', 'grande', 'médio', 'mini', 'maxi'];
  const materialWords = ['inox', 'aço', 'plástico', 'alumínio', 'metal', 'madeira', 'vidro', 'silicone', 'borracha'];
  const problemWords = ['antiodor', 'anti-odor', 'antivazamento', 'silencioso', 'vedado', 'hermético'];
  const benefitWords = ['automático', 'automática', 'sensor', 'inteligente', 'smart', 'wifi', 'bluetooth', 'recarregável', 'touch'];
  const locationWords = ['banheiro', 'cozinha', 'escritório', 'quarto', 'sala', 'jardim', 'externo', 'interno', 'pet'];
  const infoWords = ['como', 'o que é', 'qual', 'quando', 'por que', 'tutorial', 'review', 'avaliação', 'comparação'];
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
  let intent_type: IntentType, purchase_intent: PurchaseIntent, purchase_intent_score: number;
  if (hasInfo) { intent_type = 'informational'; purchase_intent = 'low'; purchase_intent_score = 0.20; }
  else if (hasCompetitor) { intent_type = 'comparison'; purchase_intent = 'medium'; purchase_intent_score = 0.50; }
  else if (wc >= 3 && (hasSize || hasMaterial) && (hasBenefit || hasProblem || hasLocation)) { intent_type = 'long_tail'; purchase_intent = 'high'; purchase_intent_score = 0.95; }
  else if (wc >= 3 && hasQualifier) { intent_type = hasBenefit ? 'benefit' : hasProblem ? 'problem' : hasLocation ? 'feature' : 'commercial'; purchase_intent = 'high'; purchase_intent_score = 0.88; }
  else if (wc >= 2 && (hasSize || hasMaterial || hasLocation)) { intent_type = hasSize ? 'feature' : 'commercial'; purchase_intent = 'high'; purchase_intent_score = 0.82; }
  else if (hasBenefit && wc >= 2) { intent_type = 'benefit'; purchase_intent = 'medium'; purchase_intent_score = 0.70; }
  else if (wc === 1 || (wc === 2 && !hasQualifier && !hasBuySignal)) { intent_type = 'category'; purchase_intent = 'low'; purchase_intent_score = 0.35; }
  else { intent_type = 'commercial'; purchase_intent = 'medium'; purchase_intent_score = 0.60; }
  let cluster = 'categoria';
  if (hasSize) cluster = 'tamanho';
  else if (hasMaterial) cluster = 'material';
  else if (hasProblem) cluster = 'problema';
  else if (hasBenefit) cluster = 'beneficio';
  else if (hasLocation) cluster = 'uso';
  else if (hasCompetitor) cluster = 'comparacao';
  else if (intent_type === 'long_tail') cluster = 'cauda_longa';
  else if (intent_type === 'informational') cluster = 'informacional';
  return { intent_type, purchase_intent, purchase_intent_score, is_long_tail: wc >= 3 && hasQualifier, word_count: wc, has_size: hasSize, has_material: hasMaterial, has_brand: false, has_qualifier: hasQualifier, cluster };
}

// ── Proteção de alta performance ──────────────────────────────────────────────
function isHighPerformanceProtected(kw: any, settings: any, windows: any): { protected: boolean; reason: string } {
  const target = settings.target_acos;
  const targetRoas = settings.target_roas;
  if (!((kw.orders || 0) > 0 || (kw.sales || 0) > 0)) return { protected: false, reason: 'no_sales' };
  if ((kw.acos || 0) === 0 && (kw.orders || 0) === 0) return { protected: false, reason: 'acos_zero_no_sales' };
  const acos14d = windows?.acos_14d ?? kw.acos ?? 999;
  const acos30d = windows?.acos_30d ?? kw.acos ?? 999;
  const roas14d = windows?.roas_14d ?? kw.roas ?? 0;
  const orders14d = windows?.orders_14d ?? kw.orders ?? 0;
  const orders30d = windows?.orders_30d ?? kw.orders ?? 0;
  const acosOk14d = target !== null && target > 0 && acos14d <= target;
  const acosOk30d = target !== null && target > 0 && acos30d <= target * 1.1;
  const roasOk = targetRoas !== null && targetRoas > 0 && roas14d >= targetRoas * 0.85;
  const salesConsistent = orders14d >= 2 && orders30d >= 4;
  if (acosOk14d && acosOk30d && salesConsistent) return { protected: true, reason: `consistent_performer: ${orders30d}p/30d, ACoS ${acos14d.toFixed(0)}%` };
  if (roasOk && salesConsistent) return { protected: true, reason: `high_roas_performer: ROAS ${roas14d.toFixed(2)}x, ${orders14d}p/14d` };
  return { protected: false, reason: 'criteria_not_met' };
}

// ── safe_max_cpc ──────────────────────────────────────────────────────────────
function calcSafeMaxCpc(params: { selling_price: number; gross_margin_pct: number; cvr_estimate: number; safety_factor: number }): number {
  if (params.selling_price <= 0 || params.gross_margin_pct <= 0) return 0;
  return Math.round(params.selling_price * (params.gross_margin_pct / 100) * params.safety_factor * params.cvr_estimate * 100) / 100;
}

// ── Calendário sazonal ────────────────────────────────────────────────────────
function getBrazilEvents(year: number) {
  function lastFriNov(y: number) { const d = new Date(y, 11, 0); while (d.getDay() !== 5) d.setDate(d.getDate() - 1); return d.toISOString().slice(0, 10); }
  function nthSunday(y: number, month: number, n: number) { const d = new Date(y, month - 1, 1); let s = 0; while (s < n) { if (d.getDay() === 0) s++; if (s < n) d.setDate(d.getDate() + 1); } return d.toISOString().slice(0, 10); }
  const bf = lastFriNov(year); const cm = new Date(bf); cm.setDate(cm.getDate() + 3);
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
  const date = new Date(dateStr + 'T12:00:00'); const year = date.getFullYear();
  const events = [...getBrazilEvents(year - 1), ...getBrazilEvents(year), ...getBrazilEvents(year + 1)];
  for (const ev of events) {
    const evDate = new Date(ev.date + 'T12:00:00');
    if (date >= new Date(evDate.getTime() - ev.pre * 86400000) && date <= new Date(evDate.getTime() + ev.post * 86400000)) {
      return { event: ev.name, demand: ev.demand, days_to: Math.round((evDate.getTime() - date.getTime()) / 86400000), is_high_demand: ['very_high_peak', 'high_peak'].includes(ev.demand) };
    }
  }
  const dow = date.getDay();
  return { event: null, demand: (dow === 0 || dow === 6) ? 'uncertain' : 'normal', days_to: null, is_high_demand: false };
}

// ── Utilitários ───────────────────────────────────────────────────────────────
function uuid(): string { return `${Date.now()}-${Math.random().toString(36).slice(2)}`; }
function clamp(v: number, min: number, max: number): number { return Math.min(max, Math.max(min, v)); }

// ── HANDLER PRINCIPAL ─────────────────────────────────────────────────────────
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
    if (!account) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({}, '-created_date', 1);
      account = accs[0];
    }
    if (!account) return Response.json({ ok: false, error: 'Conta não encontrada.' });
    const aid = account.id;

    // ── 0. Carregar Metas de Performance ─────────────────────────────────
    let settings: any = null;
    try {
      const psList = await base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id: aid }, '-updated_at', 1);
      if (psList.length > 0) {
        const ps = psList[0];
        const psNum = (v: any): number | null => { const n = Number(v); return n > 0 ? n : null; };
        const psReq = (v: any, fb: number): number => { const n = Number(v); return n > 0 ? n : fb; };
        settings = {
          source: 'PerformanceSettings', source_id: ps.id,
          target_acos: psNum(ps.target_acos),
          max_acos: psNum(ps.max_acos),
          target_roas: psNum(ps.target_roas),
          target_tacos: psNum(ps.target_tacos),
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
          growth_tolerance_factor: FB.GROWTH_TOLERANCE_FACTOR,
          growth_cooldown_hours: FB.GROWTH_COOLDOWN_HOURS,
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
            min_campaign_budget: 15, pacing_enabled: true,
            safety_factor: FB.SAFETY_FACTOR, min_confidence: FB.MIN_CONFIDENCE,
            cooldown_hours: FB.COOLDOWN_HOURS, maturation_hours: FB.MATURATION_HOURS,
            min_stock_days: FB.MIN_STOCK_DAYS, fallback_cvr: 0.05,
            growth_tolerance_factor: FB.GROWTH_TOLERANCE_FACTOR,
            growth_cooldown_hours: FB.GROWTH_COOLDOWN_HOURS,
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
        safety_factor: FB.SAFETY_FACTOR, min_confidence: FB.MIN_CONFIDENCE,
        cooldown_hours: FB.COOLDOWN_HOURS, maturation_hours: FB.MATURATION_HOURS,
        min_stock_days: FB.MIN_STOCK_DAYS, fallback_cvr: 0.05,
        growth_tolerance_factor: FB.GROWTH_TOLERANCE_FACTOR,
        growth_cooldown_hours: FB.GROWTH_COOLDOWN_HOURS,
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
        reason: `Dados desatualizados (${Math.round(dataAge)}h). Execute sync primeiro.`,
        data_freshness: dataFreshness,
      });
    }

    // ── 1b. Carregar guard de escopo autorizado ───────────────────────────
    // Produtos com ads_scope_status=authorized e ads_eligibility_status=eligible
    // Qualquer outro estado bloqueia crescimento/criação de campanha.
    const authorizedEligibleAsins = new Set<string>();
    const authorizedIneligibleAsins = new Set<string>(); // authorized mas temp. inelegível
    {
      const scopedProducts = await base44.asServiceRole.entities.Product.filter({ amazon_account_id: aid }, null, 500).catch(() => []);
      for (const sp of scopedProducts) {
        if (!sp.asin) continue;
        const scope = sp.ads_scope_status || 'not_authorized';
        const elig = sp.ads_eligibility_status || 'unknown';
        if (scope === 'authorized' && elig === 'eligible') authorizedEligibleAsins.add(sp.asin);
        else if (scope === 'authorized') authorizedIneligibleAsins.add(sp.asin);
      }
    }

    // ── 2. Carregar dados em paralelo ─────────────────────────────────────
    const cutoff14d = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
    const cutoff30d = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const cutoff7d  = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const cutoff3d  = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

    const [keywords, campaigns, products, metricsRaw, salesDailyRaw,
           termBankRaw, profitLearnings, recentExecs, productEconomicsRaw
    ] = await Promise.all([
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: aid }, '-spend', 500),
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid }, null, 200),
      base44.asServiceRole.entities.Product.filter({ amazon_account_id: aid }, null, 100),
      base44.asServiceRole.entities.CampaignMetricsDaily.filter({ amazon_account_id: aid }, '-date', 300).catch(() => []),
      base44.asServiceRole.entities.SalesDaily.filter({ amazon_account_id: aid }, '-date', 500).catch(() => []),
      base44.asServiceRole.entities.TermBank.filter({ amazon_account_id: aid, status: 'active' }, '-score', 200).catch(() => []),
      base44.asServiceRole.entities.ProductProfitabilityLearning.filter({ amazon_account_id: aid }, null, 200).catch(() => []),
      base44.asServiceRole.entities.RuleExecution.filter({ amazon_account_id: aid }, '-created_date', 500).catch(() => []),
      base44.asServiceRole.entities.ProductEconomics.filter({ amazon_account_id: aid }, null, 200).catch(() => []),
    ]);

    // ── 3. Construir índices ───────────────────────────────────────────────
    const productMap = new Map(products.map((p: any) => [p.asin, p]));
    const campaignAsinMap = new Map<string, string>();
    for (const c of campaigns) {
      if (c.campaign_id && c.asin) campaignAsinMap.set(c.campaign_id, c.asin);
      if (c.amazon_campaign_id && c.asin) campaignAsinMap.set(c.amazon_campaign_id, c.asin);
    }
    const profitByAsin = new Map<string, any>();
    for (const pl of profitLearnings) { if (pl.asin) profitByAsin.set(pl.asin, pl); }
    const normSku = (s: string) => (s || '').trim().toUpperCase().replace(/\s+/g, '-').replace(/-{2,}/g, '-');
    const econByNsku = new Map<string, any>();
    for (const e of productEconomicsRaw) {
      if (e.sku) econByNsku.set(normSku(e.sku), e);
      if (e.asin) econByNsku.set(`ASIN:${e.asin}`, e);
    }

    // ── 4. Agregar métricas por campanha e janela ─────────────────────────
    const campMetrics = new Map<string, { d3: any; d7: any; d14: any; d30: any }>();
    for (const m of metricsRaw) {
      if (!m.campaign_id || !m.date) continue;
      if (!campMetrics.has(m.campaign_id)) campMetrics.set(m.campaign_id, {
        d3: { spend: 0, sales: 0, clicks: 0, orders: 0, impressions: 0 },
        d7: { spend: 0, sales: 0, clicks: 0, orders: 0, impressions: 0 },
        d14: { spend: 0, sales: 0, clicks: 0, orders: 0, impressions: 0 },
        d30: { spend: 0, sales: 0, clicks: 0, orders: 0, impressions: 0 },
      });
      const cm = campMetrics.get(m.campaign_id)!;
      const addTo = (obj: any) => {
        obj.spend += m.spend || 0; obj.sales += m.sales || 0;
        obj.clicks += m.clicks || 0; obj.orders += m.orders || 0; obj.impressions += m.impressions || 0;
      };
      if (m.date >= cutoff3d) addTo(cm.d3);
      if (m.date >= cutoff7d) addTo(cm.d7);
      if (m.date >= cutoff14d) addTo(cm.d14);
      if (m.date >= cutoff30d) addTo(cm.d30);
    }

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
      const trend_3_vs_14 = d14.sales > 0 ? (d3.sales / (d14.sales / (14 / 3)) - 1) : 0;
      const trend_14_vs_30 = d30.sales > 0 ? (d14.sales / (d30.sales / 2) - 1) : 0;
      campWindowMetrics.set(cid, { d3, d7: derive(wm.d7), d14, d30, trend_3_vs_14, trend_14_vs_30 });
    }

    // ── 5. Métricas por ASIN ──────────────────────────────────────────────
    const salesByAsin = new Map<string, { revenue: number; units: number; days: Set<string> }>();
    for (const s of salesDailyRaw) {
      if (!s.asin || !s.date || s.date < cutoff30d) continue;
      if (!salesByAsin.has(s.asin)) salesByAsin.set(s.asin, { revenue: 0, units: 0, days: new Set() });
      const e = salesByAsin.get(s.asin)!;
      e.revenue += s.ordered_product_sales || 0;
      e.units += s.units_ordered || 0;
      e.days.add(s.date);
    }

    // ── 6. Meta econômica dinâmica + Lucro Pós-ADS por ASIN ──────────────
    const acosByAsin = new Map<string, any>();

    for (const p of products) {
      if (!p.asin) continue;
      const pl = profitByAsin.get(p.asin);
      const econ = econByNsku.get(normSku(p.sku || '')) || econByNsku.get(`ASIN:${p.asin}`) || null;
      const margin = Number(econ?.contribution_margin_percent || p.break_even_acos_pct || pl?.gross_margin_pct || 0);
      const contribution_margin_amount = Number(econ?.contribution_margin_amount || 0);

      if (margin > 0) {
        const break_even = margin;
        const target = Math.min(FB.MAX_ACOS * 2, Math.max(5, break_even * settings.safety_factor));
        const selling_price = Number(econ?.current_price || p.price || 0);
        const salesM = salesByAsin.get(p.asin);
        const cvr = salesM && salesM.units > 0 && salesM.days.size > 3
          ? salesM.units / (salesM.units + 50) : settings.fallback_cvr;
        const safe_cpc = calcSafeMaxCpc({ selling_price, gross_margin_pct: margin, cvr_estimate: cvr, safety_factor: settings.safety_factor });

        const campIds = campaigns.filter((c: any) => c.asin === p.asin).map((c: any) => c.campaign_id || c.amazon_campaign_id).filter(Boolean);
        let spend14d = 0, orders14d = 0, spend3d = 0, orders3d = 0;
        for (const cid of campIds) {
          const wm = campWindowMetrics.get(cid);
          if (wm) { spend14d += wm.d14.spend || 0; orders14d += wm.d14.orders || 0; spend3d += wm.d3.spend || 0; orders3d += wm.d3.orders || 0; }
        }

        const r14 = calcProfitAfterAds({ contribution_margin_amount, spend: spend14d, orders: orders14d });
        const r3 = calcProfitAfterAds({ contribution_margin_amount, spend: spend3d, orders: orders3d });
        const profit_protection = classifyProfitProtection({
          profit_after_ads_14d: r14.profit_after_ads,
          profit_after_ads_3d: r3.profit_after_ads,
          profit_before_ads: contribution_margin_amount,
        });

        acosByAsin.set(p.asin, {
          target: Math.round(target * 10) / 10,
          break_even: Math.round(break_even * 10) / 10,
          safe_max_cpc: safe_cpc,
          confidence: econ ? 'confirmed' : pl ? 'confirmed' : 'estimated',
          contribution_margin_amount,
          profit_after_ads_14d: r14.profit_after_ads,
          profit_after_ads_3d: r3.profit_after_ads,
          profit_protection,
          selling_price: Number(econ?.current_price || p.price || 0),
        });
      }
    }

    // Persistir profit_protection (fire-and-forget)
    const econUpdates: any[] = [];
    for (const [asin, meta] of acosByAsin.entries()) {
      const econ = econByNsku.get(`ASIN:${asin}`) || null;
      if (econ?.id && meta.profit_protection) {
        econUpdates.push({
          id: econ.id,
          profit_after_ads_14d: Math.round(meta.profit_after_ads_14d * 100) / 100,
          profit_after_ads_3d: Math.round(meta.profit_after_ads_3d * 100) / 100,
          profit_erosion_velocity: Math.round(meta.profit_protection.erosion_velocity * 1000) / 1000,
          profit_erosion_alert: meta.profit_protection.alert,
          profit_protection_mode: meta.profit_protection.mode,
          profit_protection_reason: meta.profit_protection.reason,
          last_calculated_at: now,
        });
      }
    }
    if (econUpdates.length > 0) base44.asServiceRole.entities.ProductEconomics.bulkUpdate(econUpdates).catch(() => {});

    // Persistir metas calculadas (fire-and-forget)
    const productUpdates: any[] = [];
    for (const [asin, meta] of acosByAsin.entries()) {
      const p = productMap.get(asin);
      if (p?.id && Math.abs((p.break_even_acos_pct || 0) - meta.target) > 0.5) {
        productUpdates.push({ id: p.id, break_even_acos_pct: meta.target, break_even_acos: meta.break_even });
      }
    }
    if (productUpdates.length > 0) base44.asServiceRole.entities.Product.bulkUpdate(productUpdates).catch(() => {});

    // ── 7. Gasto real de ontem ────────────────────────────────────────────
    const maxSingleCampSpend = settings.daily_budget_cap * 2;
    const realSpendYesterday = metricsRaw
      .filter((m: any) => m.date === yesterday && (m.spend || 0) > 0 && (m.spend || 0) <= maxSingleCampSpend)
      .reduce((s: number, m: any) => s + (m.spend || 0), 0);
    const budgetGuardrailActive = realSpendYesterday > 0 && realSpendYesterday > settings.daily_budget_cap;

    // ── 8. Contexto sazonal ───────────────────────────────────────────────
    const seasonal = getSeasonalContext(today);

    // ── 9. Cooldown index ─────────────────────────────────────────────────
    const usedIdemKeys = new Set<string>(
      recentExecs.filter((e: any) => (e.created_date || '').slice(0, 10) === today)
        .map((e: any) => e.idempotency_key).filter(Boolean)
    );
    const lastExecByRuleEntity = new Map<string, any>();
    for (const ex of recentExecs) {
      const k = `${ex.rule_key || ex.action_type}|${ex.entity_id || ex.keyword_id}`;
      if (!lastExecByRuleEntity.has(k)) lastExecByRuleEntity.set(k, ex);
    }

    // Cooldown de crescimento por entidade (72h após qualquer aumento)
    const lastGrowthByEntity = new Map<string, number>();
    for (const ex of recentExecs) {
      const entityId = ex.entity_id || ex.keyword_id;
      if (!entityId) continue;
      const rk = ex.rule_key || '';
      if (rk.includes('growth') || rk.includes('scale') || rk.includes('visibility') || rk.includes('budget_inc')) {
        const ts = new Date(ex.created_date || 0).getTime();
        const existing = lastGrowthByEntity.get(entityId) || 0;
        if (ts > existing) lastGrowthByEntity.set(entityId, ts);
      }
    }

    // ── 10. Gerar decisões ────────────────────────────────────────────────
    const decisions: any[] = [];
    const opportunities: any[] = []; // v6: painel de oportunidades para UI
    const skipped: any[] = [];
    const entityChangedThisCycle = new Map<string, string>();
    const stats = {
      evaluated: 0, protected: 0, held: 0,
      bid_increase: 0, bid_reduce: 0, budget_increase: 0, paused: 0,
      skipped_stock: 0, skipped_margin: 0, skipped_cooldown: 0,
      skipped_confidence: 0, skipped_data: 0, created_campaign: 0,
      // v6
      low_visibility_growth: 0, emerging_growth: 0, profitable_growth: 0,
      high_growth: 0, conservative_growth: 0, partial_cost_growth: 0,
    };

    // ── 10a. Keywords ─────────────────────────────────────────────────────
    for (const kw of keywords) {
      const entityId = kw.keyword_id || kw.id;
      if (!entityId) continue;
      if (entityChangedThisCycle.has(entityId)) continue;
      stats.evaluated++;

      const resolvedAsin = kw.asin || campaignAsinMap.get(kw.campaign_id) || null;
      const product = resolvedAsin ? productMap.get(resolvedAsin) : null;

      // ── Guard de escopo: bloquear crescimento/criação para não-autorizados ──
      if (resolvedAsin) {
        const isEligible = authorizedEligibleAsins.has(resolvedAsin);
        const isTempIneligible = authorizedIneligibleAsins.has(resolvedAsin);
        if (!isEligible && !isTempIneligible) {
          // not_authorized ou mapping_conflict: nenhuma ação de crescimento
          skipped.push({ entity_id: entityId, reason: 'ads_scope_not_authorized', asin: resolvedAsin });
          continue;
        }
        if (isTempIneligible) {
          // Autorizado mas temp. inelegível: apenas operações de pausa/monitoramento, não crescimento
          skipped.push({ entity_id: entityId, reason: 'ads_scope_temporarily_ineligible', asin: resolvedAsin });
          continue;
        }
      }

      // Estoque
      const stockQty = product?.fba_inventory || 0;
      const salesM = resolvedAsin ? salesByAsin.get(resolvedAsin) : null;
      const realUnits30d = salesM?.units || 0;
      const stockVelocity = realUnits30d / 30;
      const stockCovDays = stockVelocity > 0 ? stockQty / stockVelocity : (stockQty > 0 ? 999 : 0);

      // ── Guardrail: estoque zero ──────────────────────────────────────
      if (stockQty <= 0) {
        const currentBid = kw.bid || kw.current_bid || 0.25;
        if (currentBid > settings.min_bid) {
          const iKey = `stock_zero|${aid}|${entityId}|${today}`;
          if (!usedIdemKeys.has(iKey)) {
            decisions.push(buildDecision(aid, correlationId, {
              decision_type: 'bid_change', entity_type: 'keyword', entity_id: entityId,
              campaign_id: kw.campaign_id, keyword_id: kw.keyword_id, asin: resolvedAsin,
              keyword_text: kw.keyword_text, action: 'set_bid',
              value_before: currentBid, value_after: settings.min_bid,
              rationale: `Estoque zerado. Bid reduzido ao mínimo R$${settings.min_bid}.`,
              rule_key: 'stock_zero', risk: 'low', priority: PRIORITY.stock,
              search_intent: kw.keyword_text ? classifySearchIntent(kw.keyword_text) : null,
              settings_source: settings.source, settings_snapshot: settingsSnapshot,
              idempotency_key: iKey, stock_coverage_days: 0, stock_qty: 0,
              opportunity_state: 'no_opportunity',
            }));
            entityChangedThisCycle.set(entityId, 'stock_zero');
            stats.skipped_stock++;
          }
        }
        continue;
      }

      // Métricas da campanha
      const campForKw = campaigns.find((c: any) => c.campaign_id === kw.campaign_id || c.amazon_campaign_id === kw.campaign_id);
      const wm = campForKw
        ? (campWindowMetrics.get(campForKw.campaign_id) || campWindowMetrics.get(campForKw.amazon_campaign_id))
        : null;

      const currentBid = kw.bid || kw.current_bid || 0.25;
      const kw_impressions = kw.impressions || (wm?.d14?.impressions ?? 0);
      const kw_impressions_3d = wm?.d3?.impressions ?? 0;
      const kw_clicks = kw.clicks || (wm?.d14?.clicks ?? 0);
      const kw_spend = kw.spend || (wm?.d14?.spend ?? 0);
      const kw_orders = kw.orders || (wm?.d14?.orders ?? 0);
      const kw_sales = kw.sales || (wm?.d14?.sales ?? 0);
      const kw_acos = kw.acos || (wm?.d14?.acos ?? null);
      const kw_cvr = kw_clicks > 0 ? kw_orders / kw_clicks : 0;
      const kw_cpc = kw_clicks > 0 ? kw_spend / kw_clicks : 0;
      const kw_ctr = kw_impressions > 0 ? kw_clicks / kw_impressions : 0;

      const asinMeta = resolvedAsin ? acosByAsin.get(resolvedAsin) : null;
      const effectiveTargetAcos = asinMeta?.target ?? settings.target_acos;
      const effectiveMaxAcos = asinMeta
        ? Math.min(asinMeta.break_even, (settings.max_acos ?? FB.MAX_ACOS) * 1.5)
        : settings.max_acos;
      const effectiveSafeMaxCpc = asinMeta?.safe_max_cpc || (settings.max_cpc > 0 ? settings.max_cpc : 0);

      // Dados econômicos
      const econForProduct = resolvedAsin
        ? (econByNsku.get(normSku(product?.sku || '')) || econByNsku.get(`ASIN:${resolvedAsin}`) || null)
        : null;
      const econStatus = classifyEconomicStatus(econForProduct);

      // Proteção de alta performance
      const protection = isHighPerformanceProtected(kw, settings, wm ? {
        acos_14d: wm.d14.acos, acos_30d: wm.d30.acos,
        roas_14d: wm.d14.roas, orders_14d: wm.d14.orders, orders_30d: wm.d30.orders,
      } : null);

      const kwIntent = kw.keyword_text ? classifySearchIntent(kw.keyword_text) : null;

      // Cooldown por regra bid (genérico)
      const lastExec = lastExecByRuleEntity.get(`bid_change|${entityId}`);
      if (lastExec) {
        const lastTs = lastExec.created_date || lastExec.executed_at;
        if (lastTs && (Date.now() - new Date(lastTs).getTime()) / 3600000 < settings.cooldown_hours) {
          stats.skipped_cooldown++;
          continue;
        }
      }

      // Cooldown de crescimento v6 (72h após aumento de crescimento)
      const lastGrowthTs = lastGrowthByEntity.get(entityId) || 0;
      const growthCooldownActive = lastGrowthTs > 0 && (Date.now() - lastGrowthTs) / 3600000 < settings.growth_cooldown_hours;

      // ── Guardrail: estoque crítico < 7d ─────────────────────────────
      if (stockCovDays > 0 && stockCovDays < 7) {
        const newBid = Math.max(settings.min_bid, currentBid * (1 - settings.max_bid_decrease_pct * 0.75));
        const iKey = `stock_critical|${aid}|${entityId}|${today}`;
        if (!usedIdemKeys.has(iKey) && newBid < currentBid) {
          decisions.push(buildDecision(aid, correlationId, {
            decision_type: 'bid_change', entity_type: 'keyword', entity_id: entityId,
            campaign_id: kw.campaign_id, keyword_id: kw.keyword_id, asin: resolvedAsin,
            keyword_text: kw.keyword_text, action: 'set_bid',
            value_before: currentBid, value_after: newBid,
            rationale: `Estoque crítico: ${Math.round(stockCovDays)}d de cobertura. Bid reduzido.`,
            rule_key: 'stock_critical', risk: 'low', priority: PRIORITY.stock,
            search_intent: kwIntent, settings_source: settings.source, settings_snapshot: settingsSnapshot,
            idempotency_key: iKey, stock_coverage_days: stockCovDays,
            opportunity_state: 'no_opportunity',
          }));
          entityChangedThisCycle.set(entityId, 'stock_critical');
          stats.skipped_stock++;
          continue;
        }
      }

      // ── Guardrail: margem negativa confirmada ────────────────────────
      if (econStatus.block_expansion) {
        stats.skipped_margin++;
        skipped.push({ entity_id: entityId, reason: 'negative_margin_confirmed', asin: resolvedAsin, block_reason: econStatus.block_reason });
        continue;
      }

      // ── Guardrail: lucro pós-ads negativo (paused) ───────────────────
      if (asinMeta?.profit_protection?.mode === 'paused' && kw_spend >= MRC.MIN_SPEND * 0.5) {
        const newBid = clamp(currentBid * (1 - settings.max_bid_decrease_pct), settings.min_bid, settings.max_bid);
        const iKey = `profit_eroded_paused|${aid}|${entityId}|${today}`;
        if (!usedIdemKeys.has(iKey) && newBid < currentBid - 0.01) {
          decisions.push(buildDecision(aid, correlationId, {
            decision_type: 'bid_change', entity_type: 'keyword', entity_id: entityId,
            campaign_id: kw.campaign_id, keyword_id: kw.keyword_id, asin: resolvedAsin,
            keyword_text: kw.keyword_text, action: 'set_bid',
            value_before: currentBid, value_after: newBid,
            rationale: `🚨 LUCRO PÓS-ADS NEGATIVO: R$${asinMeta.profit_after_ads_3d.toFixed(2)}/pedido em 3d. Bid reduzido ${Math.round(settings.max_bid_decrease_pct * 100)}% para deter evasão.`,
            rule_key: 'profit_erosion_paused', risk: 'high', priority: PRIORITY.profit_erosion,
            search_intent: kwIntent, settings_source: settings.source, settings_snapshot: settingsSnapshot,
            idempotency_key: iKey, opportunity_state: 'no_opportunity',
          }));
          entityChangedThisCycle.set(entityId, 'profit_eroded');
          stats.bid_reduce++;
        }
        continue;
      }

      // ── Guardrail: erosão defensiva ──────────────────────────────────
      if (asinMeta?.profit_protection?.mode === 'defensive' && kw_spend >= MRC.MIN_SPEND) {
        const reductionPct = settings.max_bid_decrease_pct * 0.6;
        const newBid = clamp(currentBid * (1 - reductionPct), settings.min_bid, settings.max_bid);
        const iKey = `profit_erosion_defensive|${aid}|${entityId}|${today}`;
        if (!usedIdemKeys.has(iKey) && newBid < currentBid - 0.01) {
          decisions.push(buildDecision(aid, correlationId, {
            decision_type: 'bid_change', entity_type: 'keyword', entity_id: entityId,
            campaign_id: kw.campaign_id, keyword_id: kw.keyword_id, asin: resolvedAsin,
            keyword_text: kw.keyword_text, action: 'set_bid',
            value_before: currentBid, value_after: newBid,
            rationale: `⚠️ EVASÃO DE LUCRO: ${asinMeta.profit_protection.reason}. Bid reduzido ${Math.round(reductionPct * 100)}%.`,
            rule_key: 'profit_erosion_defensive', risk: 'medium', priority: PRIORITY.profit_erosion,
            search_intent: kwIntent, settings_source: settings.source, settings_snapshot: settingsSnapshot,
            idempotency_key: iKey, opportunity_state: 'no_opportunity',
          }));
          entityChangedThisCycle.set(entityId, 'profit_defensive');
          stats.bid_reduce++;
        }
        continue;
      }

      // ── v6: Calcular visibility score ────────────────────────────────
      const visSc = calcVisibilityScore({
        impressions_14d: kw_impressions,
        impressions_30d: wm?.d30?.impressions ?? kw_impressions,
        trend_3_vs_14: wm?.trend_3_vs_14 ?? 0,
        cvr: kw_cvr,
        stock_days: stockCovDays,
        is_active: stockQty > 0,
        budget_consumed_pct: campForKw?.daily_budget > 0
          ? Math.min(1, (wm?.d3?.spend ?? 0) / (campForKw.daily_budget * 3)) : 0.5,
      });

      // ── v6: Calcular opportunity score ───────────────────────────────
      const opp = calcOpportunityScore({
        visibility_score: visSc.visibility_score,
        cvr: kw_cvr,
        has_sales: kw_orders > 0,
        acos_14d: kw_acos,
        target_acos: effectiveTargetAcos,
        profit_protection_mode: asinMeta?.profit_protection?.mode || 'normal',
        stock_days: stockCovDays,
        economic_confidence: econStatus.economic_confidence,
        impression_share: kw_impressions > 0 ? Math.min(1, kw_impressions / 20000) : 0,
        cpc: kw_cpc,
        safe_max_cpc: effectiveSafeMaxCpc,
        data_freshness: dataFreshness,
      });

      // Registrar oportunidade no painel (v6 UI)
      opportunities.push({
        entity_id: entityId,
        keyword_text: kw.keyword_text,
        asin: resolvedAsin,
        campaign_id: kw.campaign_id,
        visibility_score: visSc.visibility_score,
        visibility_status: visSc.visibility_status,
        opportunity_state: opp.opportunity_state,
        opportunity_score: opp.opportunity_score,
        growth_confidence: opp.growth_confidence,
        can_grow: opp.can_grow && !growthCooldownActive,
        current_bid: currentBid,
        impressions_14d: kw_impressions,
        ctr: Math.round(kw_ctr * 10000) / 100,
        cvr: Math.round(kw_cvr * 10000) / 100,
        cpc: Math.round(kw_cpc * 100) / 100,
        acos: kw_acos !== null ? Math.round(kw_acos * 10) / 10 : null,
        orders: kw_orders,
        profit_after_ads: asinMeta?.profit_after_ads_14d,
        stock_days: Math.round(stockCovDays),
        safe_max_cpc: effectiveSafeMaxCpc,
        partial_cost: econStatus.allow_conservative_growth && econStatus.economic_data_incomplete,
      });

      // ── Proteção de vencedores + crescimento priorizado ──────────────
      if (protection.protected) {
        stats.protected++;
        if (stockCovDays >= settings.min_stock_days && opp.can_grow && !growthCooldownActive) {
          const increase = getGrowthIncrement('moderate') * 0.5; // metade para protegida
          const proposed = clamp(currentBid * (1 + increase), settings.min_bid, settings.max_bid);
          if (proposed > currentBid * 1.02 && econStatus.economic_confidence !== 'none') {
            const iKey = `protect_winner_growth|${aid}|${entityId}|${today}`;
            if (!usedIdemKeys.has(iKey)) {
              decisions.push(buildDecision(aid, correlationId, {
                decision_type: 'increase_bid_profitable_growth', entity_type: 'keyword', entity_id: entityId,
                campaign_id: kw.campaign_id, keyword_id: kw.keyword_id, asin: resolvedAsin,
                keyword_text: kw.keyword_text, action: 'set_bid',
                value_before: currentBid, value_after: proposed,
                rationale: `🏆 WINNER PROTEGIDO: ${protection.reason}. Visibilidade ${visSc.visibility_status}. Aumento suave +${Math.round(increase * 100)}% para ampliar exposição do vencedor.`,
                rule_key: 'protect_winner_growth', risk: 'low', priority: PRIORITY.protect_high_performance,
                search_intent: kwIntent, settings_source: settings.source, settings_snapshot: settingsSnapshot,
                idempotency_key: iKey, stock_coverage_days: stockCovDays,
                opportunity_state: 'profitable_opportunity',
                growth_evaluation_due_at: new Date(Date.now() + FB.GROWTH_COOLDOWN_HOURS * 3600000).toISOString(),
              }));
              entityChangedThisCycle.set(entityId, 'protect_winner_growth');
              stats.bid_increase++;
            }
          }
        }
        continue;
      }

      // ── Proteção de venda recente (recent_sale_protection_hours = 72) ──
      // Se houve venda nas últimas 72h, bloquear qualquer pausa destrutiva
      const recentSaleProtected = (() => {
        if (!FB.WINNER_PROTECTION_ENABLED) return false;
        const lastSaleTs = kw.last_sale_at || kw.last_order_at;
        if (!lastSaleTs) return false;
        return (Date.now() - new Date(lastSaleTs).getTime()) / 3600000 < FB.RECENT_SALE_PROTECTION_HOURS;
      })();

      // ── Evidência mínima ─────────────────────────────────────────────
      // Exige: min 20 cliques E min 200 impressões E spend >= max_profitable_cpa (ou fallback)
      const hasMinEvidence = kw_clicks >= FB.MIN_CLICKS_BEFORE_PAUSE && kw_impressions >= FB.MIN_IMP_BEFORE_PAUSE && kw_spend >= MRC.MIN_SPEND;
      const hasCtrQuality = kw_impressions > 0 && kw_ctr >= MRC.MIN_CTR;

      // ── Dados insuficientes: calibrar se baixíssimas impressões ─────
      if (!hasMinEvidence) {
        stats.held++;
        if (kw_impressions < 50 && kw_spend < 1 && stockCovDays >= settings.min_stock_days && !growthCooldownActive) {
          if (currentBid <= settings.min_bid * 1.2) {
            const iKey = `calibrate_bid|${aid}|${entityId}|${today}`;
            if (!usedIdemKeys.has(iKey)) {
              decisions.push(buildDecision(aid, correlationId, {
                decision_type: 'bid_change', entity_type: 'keyword', entity_id: entityId,
                campaign_id: kw.campaign_id, keyword_id: kw.keyword_id, asin: resolvedAsin,
                keyword_text: kw.keyword_text, action: 'set_bid',
                value_before: currentBid, value_after: settings.min_bid * 1.1,
                rationale: `Sem impressões suficientes. Bid calibrado para gerar dados mínimos.`,
                rule_key: 'calibrate_no_impressions', risk: 'low', priority: PRIORITY.maintenance,
                search_intent: kwIntent, settings_source: settings.source, settings_snapshot: settingsSnapshot,
                idempotency_key: iKey, opportunity_state: 'insufficient_data',
              }));
              entityChangedThisCycle.set(entityId, 'calibrate');
              stats.bid_increase++;
            }
          }
        }
        continue;
      }

      // ── Funil econômico ──────────────────────────────────────────────
      const funnel = calcFunnel({
        impressions: kw_impressions, clicks: kw_clicks, orders: kw_orders,
        spend: kw_spend, sales: kw_sales,
        contribution_margin_amount: asinMeta?.contribution_margin_amount || 0,
      });

      // ── REGRAS DE PROTEÇÃO (redução) — avaliadas antes do crescimento ─

      // CPA acima do máximo lucrável
      // minimum_spend_before_pause = maximum_profitable_cpa | minimum_clicks = 20 | minimum_impressions = 200
      const minSpendBeforePause = funnel.maximum_profitable_cpa > 0 ? funnel.maximum_profitable_cpa : MRC.MIN_SPEND;
      if (!recentSaleProtected && funnel.maximum_profitable_cpa > 0 && kw_orders >= 2
          && funnel.actual_cpa > funnel.maximum_profitable_cpa
          && kw_spend >= minSpendBeforePause && kw_clicks >= FB.MIN_CLICKS_BEFORE_PAUSE
          && kw_impressions >= FB.MIN_IMP_BEFORE_PAUSE) {
        const reductionPct = funnel.actual_cpa > funnel.maximum_profitable_cpa * 1.5 ? settings.max_bid_decrease_pct : settings.max_bid_decrease_pct * 0.5;
        const newBid = clamp(currentBid * (1 - reductionPct), settings.min_bid, settings.max_bid);
        const iKey = `cpa_above_max|${aid}|${entityId}|${today}`;
        if (!usedIdemKeys.has(iKey) && newBid < currentBid - 0.01) {
          decisions.push(buildDecision(aid, correlationId, {
            decision_type: 'bid_change', entity_type: 'keyword', entity_id: entityId,
            campaign_id: kw.campaign_id, keyword_id: kw.keyword_id, asin: resolvedAsin,
            keyword_text: kw.keyword_text, action: 'set_bid',
            value_before: currentBid, value_after: newBid,
            rationale: `CPA R$${funnel.actual_cpa.toFixed(2)} > máximo lucrável R$${funnel.maximum_profitable_cpa.toFixed(2)}. Bid reduzido ${Math.round(reductionPct * 100)}%.`,
            rule_key: 'cpa_above_profitable_limit', risk: 'high', priority: PRIORITY.margin,
            search_intent: kwIntent, settings_source: settings.source, settings_snapshot: settingsSnapshot,
            idempotency_key: iKey,
            economic_audit: { actual_cpa: funnel.actual_cpa, maximum_profitable_cpa: funnel.maximum_profitable_cpa, ecpm: funnel.ecpm, cvr: funnel.cvr, contribution_margin: asinMeta?.contribution_margin_amount },
            opportunity_state: 'no_opportunity',
          }));
          entityChangedThisCycle.set(entityId, 'cpa_reduce');
          stats.bid_reduce++;
        }
        continue;
      }

      // ACoS acima do break-even
      if (kw_acos !== null && effectiveMaxAcos !== null && kw_acos > effectiveMaxAcos && kw_spend >= MRC.MIN_SPEND) {
        const reductionPct = kw_acos > effectiveMaxAcos * 1.5 ? settings.max_bid_decrease_pct : settings.max_bid_decrease_pct * 0.5;
        const newBid = clamp(currentBid * (1 - reductionPct), settings.min_bid, settings.max_bid);
        const iKey = `acos_above_max|${aid}|${entityId}|${today}`;
        if (!usedIdemKeys.has(iKey) && newBid < currentBid - 0.01) {
          decisions.push(buildDecision(aid, correlationId, {
            decision_type: 'bid_change', entity_type: 'keyword', entity_id: entityId,
            campaign_id: kw.campaign_id, keyword_id: kw.keyword_id, asin: resolvedAsin,
            keyword_text: kw.keyword_text, action: 'set_bid',
            value_before: currentBid, value_after: newBid,
            rationale: `ACoS ${kw_acos.toFixed(1)}% acima do break-even ${effectiveMaxAcos.toFixed(1)}%. Bid reduzido ${Math.round(reductionPct * 100)}%.`,
            rule_key: 'acos_above_max', risk: kw_acos > effectiveMaxAcos * 2 ? 'high' : 'medium',
            priority: PRIORITY.margin,
            search_intent: kwIntent, settings_source: settings.source, settings_snapshot: settingsSnapshot,
            idempotency_key: iKey,
            economic_audit: { actual_cpa: funnel.actual_cpa, maximum_profitable_cpa: funnel.maximum_profitable_cpa, ecpm: funnel.ecpm, acos: kw_acos, break_even_acos: asinMeta?.break_even },
            opportunity_state: 'no_opportunity',
          }));
          entityChangedThisCycle.set(entityId, 'acos_reduce');
          stats.bid_reduce++;
        }
        continue;
      }

      // Gasto sem conversão
      // REGRA: tempo sozinho NUNCA pausa. Pausa exige conjuntamente:
      //   1. Tempo mínimo de exposição (no_sales_first_review_hours = 72h desde criação da campanha)
      //   2. Amostra estatística válida (≥20 cliques + ≥200 impressões)
      //   3. Gasto mínimo = maximum_profitable_cpa (ou fallback)
      //   4. Zero vendas
      //   5. Dados frescos e econômicos válidos (economic_confidence ≠ none + dataFreshness ≠ stale)
      //   6. Sem venda recente nas últimas 72h (recent_sale_protection)
      const noConvMinSpend = funnel.maximum_profitable_cpa > 0 ? funnel.maximum_profitable_cpa : MRC.MIN_SPEND;
      const noConvDataValid = econStatus.economic_confidence !== 'none' && dataFreshness !== 'stale';
      // Tempo mínimo desde criação da campanha (72h = no_sales_first_review_hours)
      const campCreatedAt = campForKw?.created_at || campForKw?.created_date || null;
      const campAgeHours = campCreatedAt ? (Date.now() - new Date(campCreatedAt).getTime()) / 3600000 : 999;
      const hasMinExposureTime = campAgeHours >= FB.NO_SALES_FIRST_REVIEW_HOURS;
      // Determinar fase de ação baseada na idade da campanha
      // 72h: primeira revisão — redução de bid (não pausa)
      // 5 dias: segunda revisão — redução maior
      // 7 dias: campanha pode ser pausada
      const campAgeDays = campAgeHours / 24;
      const canPauseCampaign = campAgeDays >= FB.NO_SALES_CAMPAIGN_PAUSE_DAYS;
      const isSecondReview = campAgeDays >= FB.NO_SALES_SECOND_REVIEW_DAYS;
      const isNewProduct = product?.is_new_asin === true || campAgeDays < FB.NEW_PRODUCT_MAX_LEARNING_DAYS;

      if (!recentSaleProtected && hasMinExposureTime && kw_spend >= noConvMinSpend
          && kw_orders === 0 && kw_clicks >= FB.MIN_CLICKS_BEFORE_PAUSE
          && kw_impressions >= FB.MIN_IMP_BEFORE_PAUSE && noConvDataValid) {
        const iKey = `no_conversion|${aid}|${entityId}|${today}`;
        if (!usedIdemKeys.has(iKey)) {
          // Produto novo em learning: nunca pausar, apenas reduzir conservadoramente
          // pause_most_specific_entity_first=true: pausa keyword antes da campanha
          const isLowIntent = kwIntent?.purchase_intent === 'low' || kwIntent?.intent_type === 'informational';
          // Pausa: exige 7+ dias + baixa intenção + gasto dobrado + não é produto novo em learning
          const shouldPause = canPauseCampaign && isLowIntent && kw_spend >= noConvMinSpend * 2 && !isNewProduct;
          const reductionPct = isSecondReview ? settings.max_bid_decrease_pct : settings.max_bid_decrease_pct * 0.5;
          const newBid = shouldPause
            ? settings.min_bid
            : clamp(currentBid * (1 - reductionPct), settings.min_bid, settings.max_bid);
          const phase = canPauseCampaign ? '3ª revisão (7d+)' : isSecondReview ? '2ª revisão (5d+)' : '1ª revisão (72h+)';
          decisions.push(buildDecision(aid, correlationId, {
            decision_type: shouldPause ? 'reduce_waste' : 'bid_change',
            entity_type: 'keyword', entity_id: entityId,
            campaign_id: kw.campaign_id, keyword_id: kw.keyword_id, asin: resolvedAsin,
            keyword_text: kw.keyword_text, action: shouldPause ? 'pause_keyword' : 'set_bid',
            value_before: currentBid, value_after: newBid,
            rationale: `[${phase}] ${kw_clicks} cliques, ${kw_impressions} impr, R$${kw_spend.toFixed(2)} gastos (≥ CPA máx R$${noConvMinSpend.toFixed(2)}), ZERO conversões, campanha com ${Math.round(campAgeDays)}d. Intenção: ${kwIntent?.intent_type || 'desconhecida'}. ${shouldPause ? 'PAUSA — todos os critérios atendidos.' : `Bid reduzido ${Math.round(reductionPct * 100)}%.`}`,
            rule_key: shouldPause ? 'no_conversion_pause' : 'no_conversion_reduce',
            risk: shouldPause ? 'medium' : 'low', priority: PRIORITY.waste_reduction,
            search_intent: kwIntent, settings_source: settings.source, settings_snapshot: settingsSnapshot,
            idempotency_key: iKey, opportunity_state: 'no_opportunity',
          }));
          entityChangedThisCycle.set(entityId, 'no_conversion');
          if (shouldPause) stats.paused++; else stats.bid_reduce++;
        }
        continue;
      }

      // ── CPC acima do safe max ────────────────────────────────────────
      if (effectiveSafeMaxCpc > 0 && kw_cpc > effectiveSafeMaxCpc && kw_clicks >= MRC.MIN_CLICKS) {
        const newBid = clamp(currentBid * (1 - Math.min(settings.max_bid_decrease_pct, 0.20)), settings.min_bid, settings.max_bid);
        const iKey = `cpc_above_safe|${aid}|${entityId}|${today}`;
        if (!usedIdemKeys.has(iKey) && newBid < currentBid - 0.01) {
          decisions.push(buildDecision(aid, correlationId, {
            decision_type: 'bid_change', entity_type: 'keyword', entity_id: entityId,
            campaign_id: kw.campaign_id, keyword_id: kw.keyword_id, asin: resolvedAsin,
            keyword_text: kw.keyword_text, action: 'set_bid',
            value_before: currentBid, value_after: newBid,
            rationale: `CPC R$${kw_cpc.toFixed(2)} acima do safe max R$${effectiveSafeMaxCpc.toFixed(2)}. Bid reduzido.`,
            rule_key: 'cpc_above_safe_max', risk: 'medium', priority: PRIORITY.margin,
            search_intent: kwIntent, settings_source: settings.source, settings_snapshot: settingsSnapshot,
            idempotency_key: iKey, opportunity_state: 'no_opportunity',
          }));
          entityChangedThisCycle.set(entityId, 'cpc_safe');
          stats.bid_reduce++;
        }
        continue;
      }

      // ── v6: REGRAS DE CRESCIMENTO ──────────────────────────────────────
      if (growthCooldownActive) {
        skipped.push({ entity_id: entityId, reason: 'growth_cooldown_active', asin: resolvedAsin });
        continue;
      }

      if (!opp.can_grow || opp.opportunity_score < 0.20) {
        skipped.push({ entity_id: entityId, reason: 'no_growth_opportunity', opportunity_score: opp.opportunity_score, asin: resolvedAsin });
        continue;
      }

      // Custo parcial: teto conservador de 5%
      const isPartialCost = econStatus.economic_data_incomplete;
      const maxGrowthPct = isPartialCost ? FB.PARTIAL_COST_MAX_INCREASE : getGrowthIncrement(opp.growth_confidence);
      const growthPct = Math.min(maxGrowthPct, FB.MAX_GROWTH_FACTOR - 1);

      // Simular crescimento antes de aprovar
      const sim = simulateGrowth({
        current_bid: currentBid,
        increase_pct: growthPct,
        current_impressions: kw_impressions,
        cvr: kw_cvr > 0 ? kw_cvr : settings.fallback_cvr,
        cpc: kw_cpc,
        avg_order_value: kw_orders > 0 ? kw_sales / kw_orders : (asinMeta?.selling_price || 50),
        contribution_margin_amount: asinMeta?.contribution_margin_amount || 0,
        safe_max_cpc: effectiveSafeMaxCpc,
        growth_tolerance_factor: settings.growth_tolerance_factor,
      });

      if (!sim.approved && !isPartialCost) {
        skipped.push({ entity_id: entityId, reason: 'simulation_rejected', sim_reason: sim.reason, asin: resolvedAsin });
        continue;
      }

      const proposed_bid = clamp(sim.proposed_bid, settings.min_bid, settings.max_bid);
      if (proposed_bid <= currentBid * 1.005) {
        skipped.push({ entity_id: entityId, reason: 'proposed_bid_no_change', asin: resolvedAsin });
        continue;
      }

      // Determinar cenário de crescimento e rationale
      let growthScenario = 'A';
      let ruleKey = 'increase_bid_profitable_growth';
      let decisionType = 'increase_bid_profitable_growth';
      let rationale = '';
      let growthRisk: 'low' | 'medium' | 'high' = 'low';

      if (visSc.is_low_visibility && kw_orders > 0 && kw_acos !== null && effectiveTargetAcos !== null && kw_acos <= effectiveTargetAcos) {
        // Cenário A: Lucrativo com baixa visibilidade
        growthScenario = 'A';
        ruleKey = 'increase_bid_low_visibility';
        decisionType = 'increase_bid_low_visibility';
        growthRisk = 'low';
        rationale = `📈 CENÁRIO A — Keyword com ACoS ${kw_acos.toFixed(1)}% ≤ meta ${effectiveTargetAcos}% e baixa visibilidade (${kw_impressions} impr/14d, score ${visSc.visibility_score.toFixed(2)}). Bid aumentado +${Math.round(growthPct * 100)}% para ampliar exposição. CPC projetado R$${proposed_bid.toFixed(2)}, abaixo do limite econômico. ${sim.reason}`;
        stats.low_visibility_growth++;
      } else if (kw_cvr > settings.fallback_cvr * 1.2 && kw_orders >= 1 && visSc.is_low_visibility) {
        // Cenário B: Alta conversão com baixo volume
        growthScenario = 'B';
        ruleKey = 'increase_bid_high_conversion';
        decisionType = 'increase_bid_profitable_growth';
        growthRisk = 'low';
        rationale = `📈 CENÁRIO B — Keyword com CVR ${(kw_cvr * 100).toFixed(2)}% acima da média e baixa exposição (${kw_impressions} impr/14d). ${kw_orders} venda(s). Bid aumentado +${Math.round(growthPct * 100)}% para testar crescimento de volume. ${sim.reason}`;
        stats.emerging_growth++;
      } else if (kw_acos !== null && effectiveTargetAcos !== null && kw_acos <= effectiveTargetAcos * 0.75 && kw_orders >= 1) {
        // Cenário A(2): Lucrativo com ACoS muito baixo
        growthScenario = 'A2';
        ruleKey = 'increase_bid_profitable_growth';
        decisionType = 'increase_bid_profitable_growth';
        growthRisk = 'low';
        rationale = `📈 CENÁRIO A — ACoS ${kw_acos.toFixed(1)}% muito abaixo da meta ${effectiveTargetAcos}%. ${kw_orders}p vendidos, CPA R$${funnel.actual_cpa.toFixed(2)} vs máx. lucrável R$${funnel.maximum_profitable_cpa.toFixed(2)}. Lucro pós-ADS: R$${(asinMeta?.profit_after_ads_14d || 0).toFixed(2)}/ped. Bid +${Math.round(growthPct * 100)}% para escalar. ${sim.reason}`;
        stats.profitable_growth++;
      } else if (opp.opportunity_state === 'high_growth_opportunity') {
        // Cenário high_growth
        growthScenario = 'HG';
        ruleKey = 'increase_bid_high_growth';
        decisionType = 'increase_bid_profitable_growth';
        growthRisk = 'medium';
        rationale = `🚀 ALTA OPORTUNIDADE — Produto lucrativo, ${kw_orders}+ vendas, CVR ${(kw_cvr * 100).toFixed(2)}%, visibilidade limitada. Margem: R$${(asinMeta?.contribution_margin_amount || 0).toFixed(2)}. Bid +${Math.round(growthPct * 100)}% para crescimento sustentado. ${sim.reason}`;
        stats.high_growth++;
      } else if (isPartialCost && kw_orders >= 1) {
        // Custo parcial com venda: conservador
        growthScenario = 'PC';
        ruleKey = 'conservative_growth_partial_cost';
        decisionType = 'experimental_growth';
        growthRisk = 'medium';
        rationale = `🔬 TESTE CONSERVADOR — Produto com custo parcial (economic_data_partial), ${kw_orders} venda(s), CPC R$${kw_cpc.toFixed(2)} controlado. Sem prejuízo confirmado. Aumento conservador +${Math.round(growthPct * 100)}% para manter visibilidade. Reavaliação em 72h. ${sim.reason}`;
        stats.partial_cost_growth++;
        stats.conservative_growth++;
      } else {
        // Oportunidade emergente genérica
        growthScenario = 'E';
        ruleKey = 'emerging_opportunity_growth';
        decisionType = sim.experimental ? 'experimental_growth' : 'increase_bid_profitable_growth';
        growthRisk = 'medium';
        rationale = `📊 OPORTUNIDADE EMERGENTE — opportunity_score ${opp.opportunity_score.toFixed(2)}, confiança ${opp.growth_confidence}. Bid +${Math.round(growthPct * 100)}% para teste de crescimento. ${sim.reason}`;
        stats.emerging_growth++;
      }

      const iKey = `${ruleKey}|${aid}|${entityId}|${today}`;
      if (!usedIdemKeys.has(iKey)) {
        decisions.push(buildDecision(aid, correlationId, {
          decision_type: decisionType, entity_type: 'keyword', entity_id: entityId,
          campaign_id: kw.campaign_id, keyword_id: kw.keyword_id, asin: resolvedAsin,
          keyword_text: kw.keyword_text, action: 'set_bid',
          value_before: currentBid, value_after: proposed_bid,
          rationale,
          rule_key: ruleKey, risk: growthRisk,
          priority: opp.opportunity_state === 'high_growth_opportunity' ? PRIORITY.high_growth : PRIORITY.profitable_growth,
          search_intent: kwIntent, settings_source: settings.source, settings_snapshot: settingsSnapshot,
          idempotency_key: iKey, stock_coverage_days: stockCovDays,
          opportunity_state: opp.opportunity_state,
          opportunity_score: opp.opportunity_score,
          growth_scenario: growthScenario,
          growth_confidence: opp.growth_confidence,
          visibility_score: visSc.visibility_score,
          visibility_status: visSc.visibility_status,
          growth_evaluation_due_at: new Date(Date.now() + FB.GROWTH_COOLDOWN_HOURS * 3600000).toISOString(),
          partial_cost: isPartialCost,
          simulation: {
            proposed_bid: sim.proposed_bid,
            expected_impression_gain: Math.round(sim.expected_impression_gain),
            expected_additional_orders: Math.round(sim.expected_additional_orders * 100) / 100,
            expected_cpa: Math.round(sim.expected_cpa * 100) / 100,
            expected_acos: sim.expected_acos !== null ? Math.round(sim.expected_acos * 10) / 10 : null,
            expected_profit: Math.round(sim.expected_profit * 100) / 100,
            risk_score: Math.round(sim.risk_score * 100) / 100,
            experimental: sim.experimental,
          },
          economic_audit: {
            actual_cpa: funnel.actual_cpa, maximum_profitable_cpa: funnel.maximum_profitable_cpa,
            ecpm: funnel.ecpm, cvr: funnel.cvr,
            contribution_margin: asinMeta?.contribution_margin_amount,
            break_even_acos: asinMeta?.break_even,
            target_acos: asinMeta?.target,
            profit_after_ads: asinMeta?.profit_after_ads_14d,
          },
        }));
        entityChangedThisCycle.set(entityId, ruleKey);
        stats.bid_increase++;
      }
    }

    // ── 10e. Motor de redução de ACoS por keyword (fire-and-forget) ──────
    // Invocado como etapa do motor determinístico — não bloqueia resposta.
    // runAcosBidReductionEngine é o único responsável pela regra de ACoS gradual.
    base44.asServiceRole.functions.invoke('runAcosBidReductionEngine', {
      amazon_account_id: aid,
      _service_role: true,
      source_function: 'runDeterministicDecisionEngine',
    }).catch(() => {});

    // ── 10b. Budget increase para campanhas limitadas (Cenário C) ─────────
    const campaignBudgetDecisions: any[] = [];
    if (!budgetGuardrailActive) {
      for (const camp of campaigns) {
        const cid = camp.campaign_id || camp.amazon_campaign_id;
        if (!cid) continue;
        if (String(camp.state || camp.status || '').toLowerCase() === 'archived') continue;

        const wm = campWindowMetrics.get(cid);
        if (!wm) continue;

        const d14 = wm.d14;
        if (d14.spend < 5 || d14.orders === 0) continue; // sem dados suficientes

        const asin = camp.asin || campaignAsinMap.get(cid) || null;
        const asinMeta = asin ? acosByAsin.get(asin) : null;
        const targetAcos = asinMeta?.target ?? settings.target_acos;

        // ACoS sustentável
        if (d14.acos === null || targetAcos === null || d14.acos > targetAcos * 1.2) continue;

        // Verificar se parece budget-constrained: spend 3d > 90% do budget diário * 3
        const dailyBudget = Number(camp.daily_budget || camp.budget || 0);
        if (dailyBudget <= 0) continue;
        const budget_consumed_ratio = d14.spend / (dailyBudget * 14);
        if (budget_consumed_ratio < 0.85) continue; // não está limitado

        const increaseP = 0.10; // 10% padrão para budget
        const newBudget = Math.round(dailyBudget * (1 + increaseP) * 100) / 100;

        // Limite global: soma de todos os budgets não deve ultrapassar o cap diário
        const totalCurrentBudget = campaigns.reduce((s: number, c: any) => s + Number(c.daily_budget || c.budget || 0), 0);
        if (totalCurrentBudget + (newBudget - dailyBudget) > settings.daily_budget_cap * 1.2) continue;

        const iKey = `budget_increase|${aid}|${cid}|${today}`;
        if (usedIdemKeys.has(iKey) || entityChangedThisCycle.has(cid)) continue;

        campaignBudgetDecisions.push(buildDecision(aid, correlationId, {
          decision_type: 'increase_budget_constrained', entity_type: 'campaign', entity_id: cid,
          campaign_id: cid, asin,
          action: 'set_budget',
          value_before: dailyBudget, value_after: newBudget,
          rationale: `💰 CENÁRIO C — Campanha convertendo (ACoS ${d14.acos?.toFixed(1)}% ≤ meta ${targetAcos}%), orçamento consumido ${Math.round(budget_consumed_ratio * 100)}% nos últimos 14d. Budget aumentado +10% de R$${dailyBudget.toFixed(2)} para R$${newBudget.toFixed(2)}.`,
          rule_key: 'budget_increase_constrained', risk: 'low', priority: PRIORITY.budget_increase,
          search_intent: null, settings_source: settings.source, settings_snapshot: settingsSnapshot,
          idempotency_key: iKey, opportunity_state: 'budget_constrained',
          growth_evaluation_due_at: new Date(Date.now() + FB.GROWTH_COOLDOWN_HOURS * 3600000).toISOString(),
        }));
        entityChangedThisCycle.set(cid, 'budget_increase');
        stats.budget_increase++;
      }
    }

    // ── 10c. Guardrail global de orçamento ────────────────────────────────
    if (budgetGuardrailActive) {
      decisions.forEach((d: any) => {
        if ((d.action === 'set_bid' || d.action === 'set_budget') && d.value_after > d.value_before) {
          d.approval_status = 'blocked_budget_cap';
          d.rationale += ` [BLOQUEADO: gasto R$${realSpendYesterday.toFixed(2)} excedeu cap R$${settings.daily_budget_cap}]`;
        }
      });
    }

    // Combinar decisões
    const allDecisions = [...decisions, ...campaignBudgetDecisions];

    // ── 10d. Priorização ──────────────────────────────────────────────────
    allDecisions.sort((a: any, b: any) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return (b.decision_priority_score || 0) - (a.decision_priority_score || 0);
    });

    // ── 11. Gravar OptimizationDecision ──────────────────────────────────
    let saved = 0;
    for (let i = 0; i < allDecisions.length; i += 50) {
      const batch = allDecisions.slice(i, i + 50);
      await base44.asServiceRole.entities.OptimizationDecision.bulkCreate(
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
          confidence: d.confidence || Math.round((d.opportunity_score || 0.80) * 100),
          status: 'approved',
          approval_status: d.approval_status || 'auto_approved',
          autopilot_authorized: true,
          requires_approval: false,
          idempotency_key: d.idempotency_key,
          source_function: 'runDeterministicDecisionEngine_v6',
          created_at: now,
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
    }

    // ── 12. RuleExecution (auditoria) ─────────────────────────────────────
    const auditRecords = allDecisions.slice(0, 100).map((d: any) => ({
      amazon_account_id: aid,
      correlation_id: correlationId,
      rule_key: d.rule_key || d.decision_type,
      rule_version: 6,
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
    if (auditRecords.length > 0) await base44.asServiceRole.entities.RuleExecution.bulkCreate(auditRecords).catch(() => {});

    // ── Resposta final ────────────────────────────────────────────────────
    const topOpportunities = opportunities
      .filter(o => o.can_grow && o.opportunity_score >= 0.30)
      .sort((a, b) => b.opportunity_score - a.opportunity_score)
      .slice(0, 20);

    return Response.json({
      ok: true,
      engine: 'unified-strategic-v6',
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
        growth_tolerance_factor: settings.growth_tolerance_factor,
        growth_cooldown_hours: settings.growth_cooldown_hours,
      },

      growth_policy: {
        description: 'v6: dados econômicos como fator, não bloqueio absoluto',
        partial_cost_max_increase_pct: FB.PARTIAL_COST_MAX_INCREASE * 100,
        growth_tolerance_factor: settings.growth_tolerance_factor,
        scenarios: ['A: lucrativo+baixa_vis', 'B: alta_cvr+baixo_volume', 'C: budget_constrained', 'D: produto_novo+sinal', 'E: top_search'],
        increments: { low: '3%', moderate: '5%', high: '8%', very_high: '10%', exceptional: '15%' },
      },

      economic_context: {
        products_with_dynamic_target: acosByAsin.size,
        real_spend_yesterday: Math.round(realSpendYesterday * 100) / 100,
        budget_cap: settings.daily_budget_cap,
        budget_guardrail_triggered: budgetGuardrailActive,
        products_updated: productUpdates.length,
        econ_records_updated: econUpdates.length,
      },

      opportunity_summary: {
        total_keywords_evaluated: opportunities.length,
        can_grow: opportunities.filter(o => o.can_grow).length,
        by_state: opportunities.reduce((acc: any, o) => { acc[o.opportunity_state] = (acc[o.opportunity_state] || 0) + 1; return acc; }, {}),
        top_opportunities: topOpportunities,
      },

      profit_after_ads_summary: {
        products_analyzed: acosByAsin.size,
        mode_normal: Array.from(acosByAsin.values()).filter(m => m.profit_protection?.mode === 'normal').length,
        mode_vigilant: Array.from(acosByAsin.values()).filter(m => m.profit_protection?.mode === 'vigilant').length,
        mode_defensive: Array.from(acosByAsin.values()).filter(m => m.profit_protection?.mode === 'defensive').length,
        mode_paused: Array.from(acosByAsin.values()).filter(m => m.profit_protection?.mode === 'paused').length,
        erosion_alerts: Array.from(acosByAsin.entries())
          .filter(([, m]) => m.profit_protection?.alert)
          .map(([asin, m]) => ({
            asin, mode: m.profit_protection.mode, reason: m.profit_protection.reason,
            profit_after_ads_14d: Math.round(m.profit_after_ads_14d * 100) / 100,
            profit_after_ads_3d: Math.round(m.profit_after_ads_3d * 100) / 100,
          })),
      },

      seasonal_context: seasonal,

      decisions_generated: allDecisions.length,
      decisions_saved: saved,
      stats,
      skipped_count: skipped.length,

      acos_comparison_summary: {
        total_campaigns_analyzed: campWindowMetrics.size,
        budget_increase_decisions: stats.budget_increase,
      },

      note: 'Motor v6: crescimento + visibilidade + oportunidade · custo parcial não bloqueia · growth_tolerance_factor 1.05 · simulação antes de aprovar · cooldown 48h pós-aumento · min 20 cliques + 200 impressões + CPA máximo antes de pausar · proteção de venda recente 72h · dados frescos ≤36h',
    });

  } catch (error: any) {
    console.error('[runDeterministicDecisionEngine-v6]', error.message);
    return Response.json({ ok: false, error: error.message, correlationId }, { status: 500 });
  }
});

// ── Helper buildDecision ──────────────────────────────────────────────────────
function buildDecision(aid: string, correlationId: string, params: any): any {
  const intentScore = params.search_intent?.purchase_intent_score || 0.5;
  const stockFactor = params.stock_coverage_days != null ? Math.min(1, (params.stock_coverage_days || 0) / 30) : 1.0;
  const priorityFactor = 1 - ((params.priority || 9) / 13);
  const riskFactor = { low: 0.9, medium: 0.7, high: 0.5 }[params.risk as string] || 0.7;
  const opportunityFactor = params.opportunity_score || 0.5;

  const decision_priority_score = calcDecisionScore({
    opportunity: opportunityFactor,
    economic_impact: 0.8,
    confidence: 0.9,
    visibility_gap: params.visibility_score != null ? (1 - params.visibility_score) : 0.5,
    inventory: stockFactor,
    conversion: params.simulation?.expected_additional_orders > 0 ? 1.0 : intentScore,
    goal_alignment: riskFactor,
  });

  return {
    ...params,
    amazon_account_id: aid,
    correlation_id: correlationId,
    priority: params.priority || 9,
    decision_priority_score,
    final_confidence: params.opportunity_score || 0.80,
  };
}