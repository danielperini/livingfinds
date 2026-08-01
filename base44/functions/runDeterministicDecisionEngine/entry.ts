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
import { runImmediateBudgetRescue } from '../../shared/immediateBudgetRescue.ts';
import { calculateInventoryCoverage, calculateObservedWindowDays } from '../../shared/decisionMetrics.ts';
import {
  assessNoConversionEvidence,
  calculateExpectedClicksPerOrder,
  calculateMaximumEconomicCpc,
} from '../../shared/bidDecisionEvidence.ts';
import {
  detectSequentialDeterioration,
  estimateMatureClicks,
} from '../../shared/decisionStatistics.ts';
import { estimateCpcAuctionState } from '../../shared/auctionStateEstimator.ts';
import { classifySkuEconomicState } from '../../shared/economicDecisionState.ts';
import { resolveGoalPolicy } from '../../shared/goalPolicyResolver.ts';
import { classifyExecutionPolicy } from '../../shared/decisionExecutionPolicy.ts';
import { validateAmazonAction } from '../../shared/amazonActionRegistry.ts';

// ═══════════════════════════════════════════════════════════════════════════════
// HIERARQUIA CANÔNICA DE DECISÃO v7
// P1: Segurança (token, dados, estoque, listing, estrutura)
// P2: Proteção de Rentabilidade (ACoS, margem, lucro pós-ads, winners)
// P3: Meta Principal ACoS 10–15%
//     <10%: preservar eficiência, não forçar escala
//     10–15%: zona ideal, manter
//     15–break-even: redução gradual
//     >break-even: reduzir ou pausar entidade específica
// P4: Crescimento (somente após P2)
// P5: Visibilidade (somente se não comprometer ACoS)
// P6: Experimentação
//
// GUARDRAILS DETERMINÍSTICOS (executados antes de qualquer lote de pausas):
//   account_campaign_floor_guardrail: nunca zerar campanhas se há estoque
//   pause_batch_guard: >30% exige force_batch=true; >50% bloqueia
//   winner_protection: orders_14d>0 AND acos_14d<=target → nunca pausar
//   stale_decision_guard: revalidar decisões obsoletas antes de executar
// ═══════════════════════════════════════════════════════════════════════════════

// ── Guardrail: zero campanhas ─────────────────────────────────────────────────
function checkZeroCampaignGuard(
  planned_pauses: any[],
  all_campaigns: any[],
  products: any[],
  force_batch = false,
): { allowed: boolean; reason: string } {
  const active = all_campaigns.filter(c => {
    const s = String(c.state || c.status || '').toLowerCase();
    return s === 'enabled';
  }).length;

  if (active === 0) return { allowed: true, reason: 'no_active_campaigns' }; // nada para proteger

  const activeAfter = active - planned_pauses.length;
  const hasStock = products.some((p: any) => Number(p.fba_inventory || 0) > 0);

  if (activeAfter <= 0 && hasStock) {
    return { allowed: false, reason: `ZERO_CAMPAIGN_GUARD: pausar ${planned_pauses.length} reduziria ativas de ${active} para ${activeAfter}. Estoque presente — bloqueado.` };
  }

  const pct = active > 0 ? planned_pauses.length / active : 0;
  if (pct > 0.50) {
    return { allowed: false, reason: `BATCH_PAUSE_GUARD_50PCT: ${planned_pauses.length}/${active} (${Math.round(pct * 100)}%) excede 50% — bloqueado automaticamente.` };
  }
  if (pct > 0.30 && !force_batch) {
    return { allowed: false, reason: `BATCH_PAUSE_GUARD_30PCT: ${planned_pauses.length}/${active} (${Math.round(pct * 100)}%) excede 30% — requer force_batch=true.` };
  }

  return { allowed: true, reason: 'ok' };
}

// ── Guardrail: winner protection ──────────────────────────────────────────────
function checkWinnerProtection(params: {
  orders_14d: number;
  acos_14d: number | null;
  target_acos: number | null;
  orders_30d?: number;
  roas_30d?: number;
  target_roas?: number;
  last_sale_at?: string | null;
  protected_high_performance?: boolean;
  recent_sale_protection_hours: number;
}): { protected: boolean; reason: string } {
  const {
    orders_14d, acos_14d, target_acos,
    orders_30d = 0, roas_30d = 0, target_roas = 0,
    last_sale_at, protected_high_performance = false,
    recent_sale_protection_hours,
  } = params;

  if (protected_high_performance) return { protected: true, reason: 'protected_high_performance_flag' };

  if (orders_14d > 0 && acos_14d !== null && target_acos !== null && acos_14d <= target_acos) {
    return { protected: true, reason: `winner_14d: ${orders_14d}p, ACoS ${acos_14d.toFixed(1)}% ≤ meta ${target_acos}%` };
  }

  if ((orders_30d ?? 0) >= 2 && target_roas > 0 && roas_30d >= target_roas) {
    return { protected: true, reason: `winner_30d: ${orders_30d}p/30d, ROAS ${roas_30d.toFixed(2)}x ≥ meta` };
  }

  if (last_sale_at) {
    const hoursAgo = (Date.now() - new Date(last_sale_at).getTime()) / 3600000;
    if (hoursAgo <= recent_sale_protection_hours) {
      return { protected: true, reason: `recent_sale: última venda há ${hoursAgo.toFixed(1)}h (proteção ${recent_sale_protection_hours}h)` };
    }
  }

  return { protected: false, reason: 'no_winner_criteria_met' };
}

// ── Fallbacks do sistema ──────────────────────────────────────────────────────
const FB = {
  MIN_BID: 0.25, MAX_BID: 0.70,
  MAX_INCREASE_PCT: 0.10, MAX_DECREASE_PCT: 0.20,
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
  NO_SALES_FIRST_REVIEW_HOURS: 7 * 24,
  NO_SALES_SECOND_REVIEW_DAYS: 10,
  NO_SALES_CAMPAIGN_PAUSE_DAYS: 14,
  NEW_PRODUCT_MAX_LEARNING_DAYS: 14,
  // Zero impressões
  ZERO_IMP_FIRST_REVIEW_HOURS: 7 * 24,
  ZERO_IMP_KEYWORD_PAUSE_DAYS: 15,
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
  const actual_cpa = orders > 0 ? spend / orders : spend;
  const ecpm = impressions > 0 ? (spend / impressions) * 1000 : 0;
  const impressions_per_order = orders > 0 ? impressions / orders : 0;
  const expected_cpa = cvr > 0 ? cpc / cvr : (cpc > 0 ? cpc * 20 : 0);
  const maximum_profitable_cpa = Math.max(0, contribution_margin_amount - minimum_profit_per_order);
  const ad_spend_per_order = orders > 0 ? spend / orders : spend > 0 ? spend : 0;
  const total_contribution = orders * contribution_margin_amount;
  const profit_after_ads = total_contribution - spend;
  const profit_after_ads_percent = sales > 0 ? (profit_after_ads / sales) * 100 : 0;
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
  const orders = Math.max(0, Number(params.orders || 0));
  const spend = Math.max(0, Number(params.spend || 0));
  const totalContribution = orders * Number(params.contribution_margin_amount || 0);
  const totalProfitAfterAds = totalContribution - spend;
  const ad_spend_per_order = orders > 0 ? spend / orders : spend;
  return { profit_after_ads: totalProfitAfterAds, ad_spend_per_order };
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

// ── CANONICAL_CONFIG v8 ───────────────────────────────────────────────────────
const CANONICAL_CONFIG = {
  ACCOUNT_TARGET_ACOS: 15,
  PREFERRED_ACOS_FLOOR: 10,
  MAX_BID_CHANGE_PCT: 0.20,   // ±20% máximo por ciclo
  DATA_FRESHNESS_MAX_HOURS: 36,
};

// PRD: target_roas SEMPRE derivado do target_acos — nunca valor independente
function deriveTargetRoas(target_acos: number): number {
  return target_acos > 0 ? Math.round((100 / target_acos) * 10000) / 10000 : FB.TARGET_ROAS;
}

// PRD: effective_target_acos = min(account_target, break_even_asin)
function effectiveTargetAcos_fn(account_target: number, break_even_asin: number | null): number {
  if (break_even_asin !== null && break_even_asin > 0 && break_even_asin < account_target) {
    return break_even_asin;
  }
  return account_target;
}

// PRD: ACoS ponderado = SUM(spend)/SUM(sales)*100 — NUNCA média simples
function calcWeightedAcos(items: { spend: number; sales: number }[]): number | null {
  const totalSpend = items.reduce((s, m) => s + (m.spend || 0), 0);
  const totalSales = items.reduce((s, m) => s + (m.sales || 0), 0);
  return totalSales > 0 ? Math.round((totalSpend / totalSales) * 10000) / 100 : null;
}

// PRD: Account ACoS Zone classification
function classifyAccountAcosZone(
  weighted_acos: number | null,
  floor: number,
  target: number,
  break_even: number,
): { zone: string; description: string; action: string } {
  if (weighted_acos === null) return { zone: 'no_data', description: 'Sem vendas — sem dados suficientes', action: 'aguardar dados' };
  if (weighted_acos < floor) return { zone: 'below_floor', description: `ACoS ${weighted_acos.toFixed(1)}% < ${floor}%`, action: 'identificar oportunidades seguras, não forçar escala' };
  if (weighted_acos <= target) return { zone: 'ideal', description: `ACoS ${weighted_acos.toFixed(1)}% dentro da zona ideal ${floor}–${target}%`, action: 'manter estratégia atual' };
  if (weighted_acos <= break_even) return { zone: 'above_target', description: `ACoS ${weighted_acos.toFixed(1)}% acima da meta ${target}% mas abaixo do break-even ${break_even.toFixed(1)}%`, action: 'reduzir entidades com pior marginal_acos primeiro' };
  return { zone: 'defensive', description: `ACoS ${weighted_acos.toFixed(1)}% acima do break-even ${break_even.toFixed(1)}% — modo defesa`, action: 'modo defesa ativo: reduzir piores campanhas imediatamente' };
}

// PRD: Portfolio ordering — classificar por marginal_acos descendente (piores primeiro)
function rankByMarginalAcos(items: { id: string; spend: number; sales: number; orders: number }[]): any[] {
  return items
    .filter(i => i.spend > 0)
    .map(i => ({
      ...i,
      marginal_acos: i.sales > 0 ? Math.round((i.spend / i.sales) * 10000) / 100 : 999,
    }))
    .sort((a, b) => b.marginal_acos - a.marginal_acos)
    .map((item, idx) => ({ ...item, rank: idx + 1 }));
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
    const force_batch = body.force_batch === true;

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
        const _psTargetAcos = psNum(ps.target_acos) ?? CANONICAL_CONFIG.ACCOUNT_TARGET_ACOS;
        settings = {
          source: 'PerformanceSettings', source_id: ps.id,
          objective: ps.objective || ps.primary_goal || 'profitability',
          target_acos: _psTargetAcos,
          max_acos: psNum(ps.max_acos),
          target_cpc: Number(ps.target_cpc ?? 0),
          target_roas: deriveTargetRoas(_psTargetAcos),
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
          top_of_search_limit: Number(ps.top_of_search_limit ?? 0),
          rest_of_search_limit: Number(ps.rest_of_search_limit ?? 0),
          product_page_limit: Number(ps.product_page_limit ?? 0),
        };
      }
    } catch {}

    if (!settings) {
      try {
        const apList = await base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: aid }, undefined, 1);
        if (apList.length > 0) {
          const cfg = apList[0];
          const _cfgTargetAcos = Number(cfg.target_acos ?? FB.TARGET_ACOS);
          settings = {
            source: 'AutopilotConfig', source_id: cfg.id,
            objective: cfg.objective || 'profitability',
            target_acos: _cfgTargetAcos,
            max_acos: Number(cfg.maximum_acos ?? FB.MAX_ACOS),
            target_cpc: Number(cfg.target_cpc ?? 0),
            target_roas: deriveTargetRoas(_cfgTargetAcos),
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
            top_of_search_limit: Number(cfg.top_of_search_limit ?? 0),
            rest_of_search_limit: Number(cfg.rest_of_search_limit ?? 0),
            product_page_limit: Number(cfg.product_page_limit ?? 0),
          };
        }
      } catch {}
    }

    if (!settings) {
      settings = {
        source: 'system_defaults', source_id: null,
        objective: 'profitability',
        target_acos: FB.TARGET_ACOS, max_acos: FB.MAX_ACOS,
        target_cpc: 0,
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
        top_of_search_limit: 0,
        rest_of_search_limit: 0,
        product_page_limit: 0,
      };
    }

    // Guardrails econômicos absolutos do portfólio. Configuração pode ser
    // mais conservadora, mas nunca ultrapassar estes limites.
    settings.max_bid = Math.min(Number(settings.max_bid || FB.MAX_BID), FB.MAX_BID);
    settings.min_bid = Math.min(Number(settings.min_bid || FB.MIN_BID), settings.max_bid);
    settings.max_bid_increase_pct = Math.min(
      Number(settings.max_bid_increase_pct || FB.MAX_INCREASE_PCT),
      FB.MAX_INCREASE_PCT,
    );
    settings.max_bid_decrease_pct = Math.min(
      Math.max(Number(settings.max_bid_decrease_pct || FB.MAX_DECREASE_PCT), 0.10),
      CANONICAL_CONFIG.MAX_BID_CHANGE_PCT,
    );

    const accountGoalPolicy = resolveGoalPolicy({
      objective: settings.objective,
      targetAcos: settings.target_acos,
      maximumAcos: settings.max_acos,
      targetAverageCpc: settings.target_cpc,
      hardMaximumCpc: settings.max_cpc,
      maximumDailySpend: settings.daily_budget_cap,
      maximumBidChangePct: Math.max(settings.max_bid_increase_pct, settings.max_bid_decrease_pct),
    });
    settings.target_acos = accountGoalPolicy.effectiveTargets.targetAcos;
    settings.max_acos = accountGoalPolicy.effectiveTargets.maximumAcos;
    settings.daily_budget_cap = accountGoalPolicy.effectiveTargets.maximumDailySpend;
    settings.max_bid_increase_pct = Math.min(
      settings.max_bid_increase_pct,
      accountGoalPolicy.constraints.maximumBidChangePct,
    );
    settings.max_bid_decrease_pct = Math.min(
      settings.max_bid_decrease_pct,
      accountGoalPolicy.constraints.maximumBidChangePct,
    );

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
    const authorizedEligibleAsins = new Set<string>();
    const authorizedIneligibleAsins = new Set<string>();
    {
      const scopedProducts = await base44.asServiceRole.entities.Product.filter({ amazon_account_id: aid }, undefined, 500).catch(() => []);
      for (const sp of scopedProducts) {
        if (!sp.asin) continue;
        const scope = sp.ads_scope_status || 'not_authorized';
        const elig = sp.ads_eligibility_status || 'unknown';
        if (scope === 'authorized' && elig === 'eligible') authorizedEligibleAsins.add(sp.asin);
        else if (scope === 'authorized') authorizedIneligibleAsins.add(sp.asin);
      }
    }

    // ── 1c. Carregar guardrails de dayparting e placement em paralelo ──────
    const brtNow = new Date(Date.now() - 3 * 3600000);
    const currentHourBRT = brtNow.getUTCHours();
    const currentDowBRT  = brtNow.getUTCDay();
    const todayBRT = brtNow.toISOString().slice(0, 10);

    const [hourlySalesRaw, daypartDecisionsRaw] = await Promise.all([
      base44.asServiceRole.entities.HourlySalesPattern.filter({ amazon_account_id: aid }, undefined, 500).catch(() => []),
      base44.asServiceRole.entities.DaypartingDecision.filter(
        { amazon_account_id: aid, cycle_date: todayBRT }, undefined, 500
      ).catch(() => []),
    ]);

    type SlotClassification = 'ELITE_TIME' | 'STRONG_TIME' | 'NORMAL_TIME' | 'WEAK_TIME' | 'LOSS_TIME' | 'INSUFFICIENT_DATA';
    const hourSlotMap = new Map<string, SlotClassification>();

    for (const hsp of hourlySalesRaw) {
      const key = `${hsp.day_of_week}|${hsp.hour}`;
      const cls: SlotClassification = hsp.classification === 'PEAK_ELITE' ? 'ELITE_TIME'
        : hsp.classification === 'PEAK_STRONG' ? 'STRONG_TIME'
        : hsp.classification === 'NORMAL' ? 'NORMAL_TIME'
        : hsp.classification === 'WEAK' ? 'WEAK_TIME'
        : hsp.classification === 'LOSS' ? 'LOSS_TIME'
        : 'INSUFFICIENT_DATA';
      hourSlotMap.set(key, cls);
    }

    for (const dd of daypartDecisionsRaw) {
      if (dd.hour == null || dd.day_of_week == null) continue;
      const key = `${dd.day_of_week}|${dd.hour}`;
      if (dd.slot_classification) hourSlotMap.set(key, dd.slot_classification as SlotClassification);
    }

    const currentSlotKey = `${currentDowBRT}|${currentHourBRT}`;
    const currentSlotClassification: SlotClassification = hourSlotMap.get(currentSlotKey) || 'INSUFFICIENT_DATA';

    // ── 2. Carregar dados em paralelo ─────────────────────────────────────
    const cutoff14d = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
    const cutoff30d = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const cutoff7d  = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const cutoff3d  = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

    const [keywords, campaigns, products, metricsRaw, salesDailyRaw,
           termBankRaw, profitLearnings, recentExecs, productEconomicsRaw, targetingMetricsRaw,
           unifiedAdsMetricsRaw
    ] = await Promise.all([
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: aid }, '-spend', 15000),
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid }, undefined, 5000),
      base44.asServiceRole.entities.Product.filter({ amazon_account_id: aid }, undefined, 3000),
      base44.asServiceRole.entities.CampaignMetricsDaily.filter({ amazon_account_id: aid }, '-date', 30000).catch(() => []),
      base44.asServiceRole.entities.SalesDaily.filter({ amazon_account_id: aid }, '-date', 10000).catch(() => []),
      base44.asServiceRole.entities.TermBank.filter({ amazon_account_id: aid, status: 'active' }, '-score', 10000).catch(() => []),
      base44.asServiceRole.entities.ProductProfitabilityLearning.filter({ amazon_account_id: aid }, undefined, 3000).catch(() => []),
      base44.asServiceRole.entities.RuleExecution.filter({ amazon_account_id: aid }, '-created_date', 10000).catch(() => []),
      base44.asServiceRole.entities.ProductEconomics.filter({ amazon_account_id: aid }, undefined, 3000).catch(() => []),
      base44.asServiceRole.entities.TargetingMetricsDaily.filter({ amazon_account_id: aid }, '-date', 5000).catch(() => []),
      base44.asServiceRole.entities.UnifiedAdsMetricsDaily.filter({ amazon_account_id: aid }, '-date', 30000).catch(() => []),
    ]);
    // Relatórios de atribuição são revisados para a mesma chave natural. Bases
    // antigas podem conter duplicatas de sincronizações anteriores; usar apenas
    // a versão mais recente evita dobrar spend, pedidos e CVR same-SKU.
    const unifiedByNaturalKey = new Map<string, any>();
    for (const row of unifiedAdsMetricsRaw) {
      const key = [row.date, row.campaign_id, row.ad_group_id, row.advertised_product_id, row.advertised_sku]
        .map((value) => String(value || '').trim()).join('|');
      const current = unifiedByNaturalKey.get(key);
      const rowTime = new Date(row.synced_at || row.updated_at || row.created_at || 0).getTime();
      const currentTime = new Date(current?.synced_at || current?.updated_at || current?.created_at || 0).getTime();
      if (!current || rowTime >= currentTime) unifiedByNaturalKey.set(key, row);
    }
    const unifiedAdsMetrics = Array.from(unifiedByNaturalKey.values());
    const latestMetricsDate = [...metricsRaw, ...targetingMetricsRaw, ...unifiedAdsMetrics]
      .map((row: any) => String(row.date || ''))
      .filter(Boolean)
      .sort()
      .at(-1) || yesterday;

    // Métricas granulares confirmadas têm precedência sobre agregados da entidade.
    // Isso permite reduzir o target ruim e preservar outro target vencedor na mesma campanha.
    const targetingByEntity = new Map<string, any>();
    const targetingHistoryByEntity = new Map<string, any[]>();
    for (const row of targetingMetricsRaw) {
      if (!row.date || row.date < cutoff30d) continue;
      const id = String(row.keyword_id || row.target_id || '');
      if (!id) continue;
      const aggregate = targetingByEntity.get(id) || {
        spend: 0, sales: 0, orders: 0, clicks: 0, impressions: 0,
        same_sku_orders: 0, same_sku_sales: 0, halo_orders: 0, halo_sales: 0,
        has_same_sku_attribution: false,
      };
      aggregate.spend += Number(row.spend || 0);
      aggregate.sales += Number(row.sales || 0);
      aggregate.orders += Number(row.orders || 0);
      aggregate.clicks += Number(row.clicks || 0);
      aggregate.impressions += Number(row.impressions || 0);
      if (row.same_sku_orders != null || row.same_sku_sales != null) {
        aggregate.same_sku_orders += Number(row.same_sku_orders || 0);
        aggregate.same_sku_sales += Number(row.same_sku_sales || 0);
        aggregate.halo_orders += Number(row.halo_orders || 0);
        aggregate.halo_sales += Number(row.halo_sales || 0);
        aggregate.has_same_sku_attribution = true;
      }
      targetingByEntity.set(id, aggregate);
      if (!targetingHistoryByEntity.has(id)) targetingHistoryByEntity.set(id, []);
      targetingHistoryByEntity.get(id)!.push(row);
    }
    for (const keyword of keywords) {
      const granular = targetingByEntity.get(String(keyword.keyword_id || keyword.id || ''));
      if (granular) Object.assign(keyword, granular, { metrics_source: 'TargetingMetricsDaily' });
    }

    // A CVR do SKU deve vir do produto promovido. Unidades orgânicas da SP-API
    // não são denominador de conversão publicitária.
    const sameSkuByProductKey = new Map<string, { clicks: number; orders: number; sales: number }>();
    for (const row of unifiedAdsMetrics) {
      if (!row.date || row.date < cutoff30d) continue;
      const keys = [row.advertised_product_id, row.advertised_sku].filter(Boolean).map(String);
      if (keys.length === 0 || (row.promoted_purchases == null && row.promoted_sales == null)) continue;
      for (const key of keys) {
        const aggregate = sameSkuByProductKey.get(key) || { clicks: 0, orders: 0, sales: 0 };
        aggregate.clicks += Number(row.clicks || 0);
        aggregate.orders += Number(row.promoted_purchases || 0);
        aggregate.sales += Number(row.promoted_sales || 0);
        sameSkuByProductKey.set(key, aggregate);
      }
    }

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
    const salesWindowDates = new Set<string>();
    for (const s of salesDailyRaw) {
      if (!s.asin || !s.date || s.date < cutoff30d) continue;
      if (!salesByAsin.has(s.asin)) salesByAsin.set(s.asin, { revenue: 0, units: 0, days: new Set() });
      const e = salesByAsin.get(s.asin)!;
      e.revenue += s.ordered_product_sales || 0;
      e.units += s.units_ordered || 0;
      e.days.add(s.date);
      salesWindowDates.add(s.date);
    }
    const observedSalesDays = calculateObservedWindowDays([...salesWindowDates]);
    const inventoryCoverageByAsin = new Map<string, ReturnType<typeof calculateInventoryCoverage>>();
    for (const product of products) {
      if (!product.asin) continue;
      const sales = salesByAsin.get(product.asin);
      const coverage = calculateInventoryCoverage({
        fbaInventory: product.fba_inventory,
        availableQuantity: product.available_quantity,
        reservedInventory: product.reserved_inventory,
        inboundInventory: product.inbound_inventory,
        unitsSold: sales?.units || 0,
        observedDays: observedSalesDays,
      });
      inventoryCoverageByAsin.set(product.asin, coverage);

      const changed = product.inventory_coverage_status !== coverage.status
        || Number(product.days_of_supply ?? -1) !== Number(coverage.days_of_supply ?? -1)
        || Number(product.days_of_supply_with_inbound ?? -1) !== Number(coverage.days_of_supply_with_inbound ?? -1)
        || Number(product.daily_sales_velocity_30d || 0) !== Number(coverage.daily_sales_velocity || 0)
        || product.inventory_signal_calculated_at?.slice(0, 10) !== today;
      if (changed) {
        await base44.asServiceRole.entities.Product.update(product.id, {
          daily_sales_velocity_30d: coverage.daily_sales_velocity,
          days_of_supply: coverage.days_of_supply,
          days_of_supply_with_inbound: coverage.days_of_supply_with_inbound,
          inventory_coverage_status: coverage.status,
          inventory_signal_quality: coverage.data_quality,
          inventory_signal_observed_days: coverage.observed_days,
          inventory_signal_calculated_at: now,
        }).catch(() => {});
      }
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
        const promoted = sameSkuByProductKey.get(String(p.asin))
          || sameSkuByProductKey.get(String(p.sku || ''));
        const cvr = promoted && promoted.clicks > 0
          ? promoted.orders / promoted.clicks
          : settings.fallback_cvr;
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
        const skuEconomicState = classifySkuEconomicState({
          realRevenue: salesByAsin.get(p.asin)?.revenue || 0,
          adSpend: spend14d,
          contributionBeforeAds: (promoted?.orders ?? orders14d) * contribution_margin_amount,
          targetAcosPercent: target,
          breakEvenAcosPercent: break_even,
          buyable: p.listing_buyable !== false,
          offerActive: p.offer_active !== false,
          listingSuppressed: p.listing_suppressed === true,
          adsEligible: !p.ads_eligibility_status || p.ads_eligibility_status === 'eligible',
        });
        if (skuEconomicState.state === 'LOSS_CONFIRMED' || skuEconomicState.state === 'NOT_BUYABLE') {
          profit_protection.mode = 'paused';
          profit_protection.alert = true;
          profit_protection.reason = skuEconomicState.state;
        } else if (skuEconomicState.state === 'DEFENSIVE') {
          profit_protection.mode = 'defensive';
          profit_protection.alert = true;
          profit_protection.reason = 'DEFENSIVE';
        } else if (skuEconomicState.state === 'VIGILANT') {
          profit_protection.mode = 'vigilant';
          profit_protection.reason = 'VIGILANT';
        } else {
          profit_protection.mode = 'normal';
        }

        acosByAsin.set(p.asin, {
          target: Math.round(target * 10) / 10,
          break_even: Math.round(break_even * 10) / 10,
          safe_max_cpc: safe_cpc,
          confidence: econ ? 'confirmed' : pl ? 'confirmed' : 'estimated',
          contribution_margin_amount,
          profit_after_ads_14d: r14.profit_after_ads,
          profit_after_ads_3d: r3.profit_after_ads,
          profit_protection,
          economic_state: skuEconomicState.state,
          block_growth: skuEconomicState.block_growth,
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

    // ── 7. Gasto real e recálculo dinâmico do daily_budget_cap ───────────
    const maxSingleCampSpend = settings.daily_budget_cap * 2;

    const cutoff24h = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const metrics24h = metricsRaw.filter((m: any) => m.date >= cutoff24h && (m.spend || 0) > 0 && (m.spend || 0) <= maxSingleCampSpend);
    const realSpendYesterday = metrics24h
      .filter((m: any) => m.date === yesterday)
      .reduce((s: number, m: any) => s + (m.spend || 0), 0);

    const spend24h = metrics24h.reduce((s: number, m: any) => s + (m.spend || 0), 0);
    const sales24h  = metrics24h.reduce((s: number, m: any) => s + (m.sales || 0), 0);
    const orders24h = metrics24h.reduce((s: number, m: any) => s + (m.orders || 0), 0);
    const acos24h   = sales24h > 0 ? (spend24h / sales24h) * 100 : null;
    const roas24h   = spend24h > 0 ? sales24h / spend24h : null;

    let userBudgetCap = settings.daily_budget_cap;
    try {
      const controllers = await base44.asServiceRole.entities.AccountDailySpendController.filter(
        { amazon_account_id: aid }, '-spend_date', 1
      ).catch(() => []);
      if (controllers.length > 0 && controllers[0].user_daily_spend_cap > 0) {
        userBudgetCap = controllers[0].user_daily_spend_cap;
      }
    } catch {}

    const MIN_BUDGET_CAP = 10;
    const effectiveUserCap = Math.max(MIN_BUDGET_CAP, userBudgetCap);
    const targetAcos24h = settings.target_acos ?? FB.TARGET_ACOS;
    const avgBreakEven = acosByAsin.size > 0
      ? Array.from(acosByAsin.values()).reduce((s: number, m: any) => s + (m.break_even || targetAcos24h), 0) / acosByAsin.size
      : targetAcos24h * 1.5;

    let recalculatedBudgetCap = settings.daily_budget_cap;
    let budgetAdjustReason = 'no_data';

    if (spend24h >= 5) {
      if (acos24h === null && spend24h > effectiveUserCap * 0.20) {
        recalculatedBudgetCap = Math.max(MIN_BUDGET_CAP, settings.daily_budget_cap * 0.90);
        budgetAdjustReason = `sem_vendas_24h: gasto R$${spend24h.toFixed(2)} sem retorno`;
      } else if (acos24h !== null && acos24h > avgBreakEven) {
        recalculatedBudgetCap = Math.max(MIN_BUDGET_CAP, settings.daily_budget_cap * 0.90);
        budgetAdjustReason = `acos_acima_breakeven_24h: ACoS ${acos24h.toFixed(1)}% > break-even ${avgBreakEven.toFixed(1)}%`;
      } else if (acos24h !== null && acos24h > targetAcos24h * 1.1) {
        recalculatedBudgetCap = Math.max(MIN_BUDGET_CAP, settings.daily_budget_cap * 0.95);
        budgetAdjustReason = `acos_acima_meta_24h: ACoS ${acos24h.toFixed(1)}% vs meta ${targetAcos24h}%`;
      } else if (acos24h !== null && acos24h <= targetAcos24h * 0.80) {
        recalculatedBudgetCap = Math.min(effectiveUserCap, settings.daily_budget_cap * 1.10);
        budgetAdjustReason = `acos_eficiente_24h: ACoS ${acos24h.toFixed(1)}% ≤ ${(targetAcos24h * 0.80).toFixed(1)}% (meta×0.8)`;
      } else {
        recalculatedBudgetCap = settings.daily_budget_cap;
        budgetAdjustReason = `acos_na_meta_24h: ACoS ${acos24h?.toFixed(1) ?? 'n/a'}% dentro do range aceitável`;
      }
    }

    recalculatedBudgetCap = Math.round(Math.min(effectiveUserCap, Math.max(MIN_BUDGET_CAP, recalculatedBudgetCap)) * 100) / 100;

    const budgetCapChanged = Math.abs(recalculatedBudgetCap - settings.daily_budget_cap) > 0.5;
    if (budgetCapChanged) {
      settings.daily_budget_cap = recalculatedBudgetCap;
      if (settings.source_id) {
        base44.asServiceRole.entities.PerformanceSettings.update(settings.source_id, {
          calculated_daily_budget: recalculatedBudgetCap,
          suggested_daily_budget: recalculatedBudgetCap,
          last_budget_recalculation: now,
        }).catch(() => {});
      }
    }

    const budgetGuardrailActive = realSpendYesterday > 0 && realSpendYesterday > settings.daily_budget_cap;

    // ── 7b. ACCOUNT ACoS CONTROL LOOP (PRD) ──────────────────────────────
    const allMetrics14d = metricsRaw.filter((m: any) => m.date >= cutoff14d && (m.spend || 0) > 0);
    const accountWeightedAcos = calcWeightedAcos(
      allMetrics14d.map((m: any) => ({ spend: m.spend || 0, sales: m.sales || 0 }))
    );
    const avgBreakEvenAccount = acosByAsin.size > 0
      ? Array.from(acosByAsin.values()).reduce((s: number, m: any) => s + (m.break_even || 30), 0) / acosByAsin.size
      : 30;
    const accountAcosZone = classifyAccountAcosZone(
      accountWeightedAcos,
      CANONICAL_CONFIG.PREFERRED_ACOS_FLOOR,
      CANONICAL_CONFIG.ACCOUNT_TARGET_ACOS,
      avgBreakEvenAccount
    );
    const portfolioRanking = (accountAcosZone.zone === 'above_target' || accountAcosZone.zone === 'defensive')
      ? rankByMarginalAcos(allMetrics14d.map((m: any) => ({
          id: m.campaign_id, spend: m.spend || 0, sales: m.sales || 0, orders: m.orders || 0,
        })))
      : [];

    // ── 8. Contexto sazonal ───────────────────────────────────────────────
    const seasonal = getSeasonalContext(today);

    // ── 9. Cooldown index ─────────────────────────────────────────────────
    const usedIdemKeys = new Set<string>();
    for (const execution of recentExecs) {
      const key = String(execution.idempotency_key || '');
      if (!key) continue;
      usedIdemKeys.add(key);
      usedIdemKeys.add(key.split('|window:')[0]);
    }
    const lastExecByRuleEntity = new Map<string, any>();
    for (const ex of recentExecs) {
      const k = `${ex.rule_key || ex.action_type}|${ex.entity_id || ex.keyword_id}`;
      if (!lastExecByRuleEntity.has(k)) lastExecByRuleEntity.set(k, ex);
    }

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

    // ── 10. Deduplicação de campanhas AUTO por ASIN ───────────────────────
    const autoDuplicatesArchived: any[] = [];
    {
      const autoCampaignsByAsin = new Map<string, any[]>();
      for (const c of campaigns) {
        const state = String(c.state || c.status || '').toLowerCase();
        if (state === 'archived') continue;
        if ((c.targeting_type || '').toUpperCase() !== 'AUTO') continue;
        const asin = c.asin || campaignAsinMap.get(c.campaign_id || c.amazon_campaign_id) || null;
        if (!asin) continue;
        if (!autoCampaignsByAsin.has(asin)) autoCampaignsByAsin.set(asin, []);
        autoCampaignsByAsin.get(asin)!.push(c);
      }

      const dupsToPause: any[] = [];
      for (const [asin, camps] of autoCampaignsByAsin.entries()) {
        if (camps.length <= 1) continue;

        const asinMeta = acosByAsin.get(asin);
        const targetAcos = asinMeta?.target ?? settings.target_acos ?? 15;
        const breakEvenAcos = asinMeta?.break_even ?? 30;

        const scoredCamps = camps.map((c: any) => {
          const cOrders = c.orders || 0;
          const cRoas = c.roas || 0;
          const cSales = c.sales || 0;
          const cAcos = c.acos || 0;
          const winnerScore =
            cOrders * 10
            + cRoas * 2
            + (cSales > 0 ? 5 : 0)
            + (cAcos > 0 && cAcos <= targetAcos ? 10 : 0)
            - (cAcos > breakEvenAcos ? 5 : 0);
          return { ...c, _winnerScore: winnerScore };
        }).sort((a: any, b: any) => b._winnerScore - a._winnerScore);

        for (let i = 1; i < scoredCamps.length; i++) {
          const dup = scoredCamps[i];
          const wm_dup = campWindowMetrics.get(dup.campaign_id || dup.amazon_campaign_id);
          const wpResult = checkWinnerProtection({
            orders_14d: wm_dup?.d14?.orders ?? dup.orders ?? 0,
            acos_14d: wm_dup?.d14?.acos ?? (dup.acos > 0 ? dup.acos : null),
            target_acos: targetAcos,
            orders_30d: wm_dup?.d30?.orders ?? dup.orders ?? 0,
            roas_30d: wm_dup?.d30?.roas ?? 0,
            target_roas: settings.target_roas ?? 4,
            last_sale_at: dup.last_sale_at || null,
            protected_high_performance: dup.is_operational === true,
            recent_sale_protection_hours: FB.RECENT_SALE_PROTECTION_HOURS,
          });
          if (wpResult.protected) {
            base44.asServiceRole.entities.OptimizationDecision.create({
              amazon_account_id: aid,
              decision_type: 'pause',
              entity_type: 'campaign',
              entity_id: dup.campaign_id || dup.amazon_campaign_id,
              campaign_id: dup.campaign_id || dup.amazon_campaign_id,
              asin,
              action: 'pause_campaign',
              status: 'cancelled',
              rationale: `winner_protection_blocked (dedup): ${wpResult.reason}`,
              rule_key: 'winner_protection_dedup',
              risk: 'low',
              source_function: 'runDeterministicDecisionEngine_v8',
              created_at: now,
            }).catch(() => {});
            continue;
          }

          const iKey = `auto_dedup_archive|${aid}|${dup.id}`;
          if (usedIdemKeys.has(iKey)) continue;
          const amazonCampaignId = dup.campaign_id || dup.amazon_campaign_id;
          if (amazonCampaignId) dupsToPause.push({ dup, asin, amazonCampaignId });
        }
      }

      if (dupsToPause.length > 0) {
        const guardResult = checkZeroCampaignGuard(dupsToPause.map(d => d.dup), campaigns, products, force_batch);
        if (!guardResult.allowed) {
          base44.asServiceRole.entities.SyncExecutionLog.create({
            amazon_account_id: aid,
            operation: 'zero_campaign_guard_blocked',
            status: 'warning',
            trigger_type: 'automatic',
            execution_date: today,
            started_at: now,
            result_summary: guardResult.reason,
          }).catch(() => {});
          dupsToPause.splice(0, dupsToPause.length);
        }
      }

      if (dupsToPause.length > 0) {
        const adsClientId = Deno.env.get('ADS_CLIENT_ID') || '';
        const adsClientSecret = Deno.env.get('ADS_CLIENT_SECRET') || '';
        const adsRegion = Deno.env.get('ADS_REGION') || 'na';
        const endpointMap: Record<string, string> = {
          na: 'https://advertising-api.amazon.com',
          eu: 'https://advertising-api-eu.amazon.com',
          fe: 'https://advertising-api-fe.amazon.com',
        };
        const adsEndpoint = endpointMap[adsRegion] || endpointMap.na;
        const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID') || '';
        const refreshToken = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN') || '';

        let adsAccessToken: string | null = null;
        if (refreshToken && adsClientId && profileId) {
          try {
            const tokenRes = await fetch('https://api.amazon.com/auth/o2/token', {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: refreshToken,
                client_id: adsClientId,
                client_secret: adsClientSecret,
              }).toString(),
            });
            if (tokenRes.ok) adsAccessToken = (await tokenRes.json()).access_token;
          } catch {}
        }

        const pausedOnAmazon: string[] = [];
        const failedOnAmazon: string[] = [];
        if (adsAccessToken) {
          for (let i = 0; i < dupsToPause.length; i += 10) {
            const batch = dupsToPause.slice(i, i + 10);
            try {
              const res = await fetch(`${adsEndpoint}/sp/campaigns`, {
                method: 'PUT',
                headers: {
                  'Amazon-Advertising-API-ClientId': adsClientId,
                  'Amazon-Advertising-API-Scope': profileId,
                  'Authorization': `Bearer ${adsAccessToken}`,
                  'Content-Type': 'application/vnd.spCampaign.v3+json',
                  'Accept': 'application/vnd.spCampaign.v3+json',
                },
                body: JSON.stringify({ campaigns: batch.map(b => ({ campaignId: b.amazonCampaignId, state: 'PAUSED' })) }),
              });
              if (res.ok) {
                const data = await res.json();
                (data?.campaigns?.success || []).forEach((s: any) => pausedOnAmazon.push(s.campaignId));
                (data?.campaigns?.error || []).forEach((e: any) => failedOnAmazon.push(e.campaignId));
              } else {
                batch.forEach(b => failedOnAmazon.push(b.amazonCampaignId));
              }
            } catch {
              batch.forEach(b => failedOnAmazon.push(b.amazonCampaignId));
            }
          }
        }

        for (const { dup, asin, amazonCampaignId } of dupsToPause) {
          base44.asServiceRole.entities.Campaign.update(dup.id, {
            state: 'archived', status: 'archived', updated_at: now,
          }).catch(() => {});
          autoDuplicatesArchived.push({
            asin,
            campaign_id: amazonCampaignId,
            name: dup.name || dup.campaign_name,
            id: dup.id,
            paused_on_amazon: adsAccessToken ? pausedOnAmazon.includes(amazonCampaignId) : null,
            amazon_pause_skipped: !adsAccessToken,
          });
        }
      }
    }

    // ── 10. Gerar decisões (motor principal) ─────────────────────────────
    const decisions: any[] = [];
    const opportunities: any[] = [];
    const skipped: any[] = [];
    const entityChangedThisCycle = new Map<string, string>();
    const stats = {
      evaluated: 0, protected: 0, held: 0,
      bid_increase: 0, bid_reduce: 0, budget_increase: 0, paused: 0,
      skipped_stock: 0, skipped_margin: 0, skipped_cooldown: 0,
      skipped_confidence: 0, skipped_data: 0, created_campaign: 0,
      auto_duplicates_archived: autoDuplicatesArchived.length,
      low_visibility_growth: 0, emerging_growth: 0, profitable_growth: 0,
      high_growth: 0, conservative_growth: 0, partial_cost_growth: 0,
    };

    // ── 10a. Carregar KeywordPrediction como contexto modificador ─────────
    const kwPredictionMap = new Map<string, any>();
    try {
      const kwPreds = await base44.asServiceRole.entities.KeywordPrediction.filter(
        { amazon_account_id: aid, status: { $nin: ['rejected', 'blocked', 'expired'] } },
        '-last_evaluated_at', 1000
      ).catch(() => []);
      for (const p of kwPreds) {
        if (!p.keyword || !p.asin) continue;
        const norm = (p.normalized_keyword || p.keyword || '').toLowerCase()
          .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
          .replace(/[^\w\s\-\.\/]/g, ' ').replace(/\s+/g, ' ').trim();
        const mapKey = `${norm}::${p.asin}`;
        if (!kwPredictionMap.has(mapKey)) kwPredictionMap.set(mapKey, p);
      }
    } catch {}

    const lifecycleManagedKwIds = new Set<string>();
    try {
      const lifecycles = await base44.asServiceRole.entities.ManualCampaignBidLifecycle.filter(
        { amazon_account_id: aid }, undefined, 1000
      ).catch(() => []);
      for (const lc of lifecycles) {
        const protectedStatuses = ['launch_0_48h', 'emergency_reduction', 'waiting_48h_review', 'pending_confirmation'];
        if (protectedStatuses.includes(lc.status) && lc.keyword_id) {
          lifecycleManagedKwIds.add(lc.keyword_id);
        }
        if (lc.cooldown_until && new Date(lc.cooldown_until).getTime() > Date.now() && lc.keyword_id) {
          lifecycleManagedKwIds.add(lc.keyword_id);
        }
      }
    } catch {}

    // ── 10b. Keywords ─────────────────────────────────────────────────────
    for (const kw of keywords) {
      const entityId = kw.keyword_id || kw.id;
      if (!entityId) continue;
      if (entityChangedThisCycle.has(entityId)) continue;
      const mt = (kw.match_type || '').toLowerCase();
      if (mt.startsWith('negative') || (kw.keyword_id || '').startsWith('neg_')) continue;
      if (lifecycleManagedKwIds.has(entityId)) {
        skipped.push({ entity_id: entityId, reason: 'protected_by_launch_lifecycle_48h', keyword_text: kw.keyword_text });
        continue;
      }
      stats.evaluated++;

      const resolvedAsin = kw.asin || campaignAsinMap.get(kw.campaign_id) || null;
      const product = resolvedAsin ? productMap.get(resolvedAsin) : null;

      let mlContext: any = null;
      if (resolvedAsin && kw.keyword_text) {
        const nk = (kw.keyword_text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w\s\-\.\/]/g, ' ').replace(/\s+/g, ' ').trim();
        mlContext = kwPredictionMap.get(`${nk}::${resolvedAsin}`) || null;
      }
      const mlFlags: string[] = mlContext?.contradiction_flags ? (() => { try { return JSON.parse(mlContext.contradiction_flags); } catch { return []; } })() : [];
      const mlRelevance: number | null = mlContext?.relevance_score ?? null;
      if (mlFlags.length > 0) { skipped.push({ entity_id: entityId, reason: 'ml_contradiction_flag', flags: mlFlags, asin: resolvedAsin }); continue; }
      if (mlRelevance !== null && mlRelevance < 0.30) { skipped.push({ entity_id: entityId, reason: 'ml_low_relevance', relevance_score: mlRelevance, asin: resolvedAsin }); continue; }

      if (resolvedAsin) {
        const isEligible = authorizedEligibleAsins.has(resolvedAsin);
        const isTempIneligible = authorizedIneligibleAsins.has(resolvedAsin);
        if (!isEligible && !isTempIneligible) {
          skipped.push({ entity_id: entityId, reason: 'ads_scope_not_authorized', asin: resolvedAsin });
          continue;
        }
        if (isTempIneligible) {
          skipped.push({ entity_id: entityId, reason: 'ads_scope_temporarily_ineligible', asin: resolvedAsin });
          continue;
        }
      }

      const inventoryCoverage = resolvedAsin
        ? inventoryCoverageByAsin.get(resolvedAsin)
        : calculateInventoryCoverage({ fbaInventory: product?.fba_inventory });
      const stockQty = inventoryCoverage?.available_now || 0;
      const stockCovDays = inventoryCoverage?.days_of_supply;

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
              stock_coverage_with_inbound_days: inventoryCoverage?.days_of_supply_with_inbound,
              stock_inbound_qty: inventoryCoverage?.inbound_inventory || 0,
              stock_reserved_qty: inventoryCoverage?.reserved_inventory || 0,
              sales_velocity_daily: inventoryCoverage?.daily_sales_velocity || 0,
              inventory_signal_quality: inventoryCoverage?.data_quality || 'insufficient_history',
              stock_urgency: 'critical',
              opportunity_state: 'no_opportunity',
            }));
            entityChangedThisCycle.set(entityId, 'stock_zero');
            stats.skipped_stock++;
          }
        }
        continue;
      }

      const campForKw = campaigns.find((c: any) => c.campaign_id === kw.campaign_id || c.amazon_campaign_id === kw.campaign_id);
      const wm = campForKw
        ? (campWindowMetrics.get(campForKw.campaign_id) || campWindowMetrics.get(campForKw.amazon_campaign_id))
        : null;

      const currentBid = kw.bid || kw.current_bid || 0.25;
      const kw_impressions = kw.impressions || (wm?.d14?.impressions ?? 0);
      const kw_impressions_3d = wm?.d3?.impressions ?? 0;
      const kw_clicks = kw.clicks || (wm?.d14?.clicks ?? 0);
      const kw_spend = kw.spend || (wm?.d14?.spend ?? 0);
      const totalAttributedOrders = kw.orders || (wm?.d14?.orders ?? 0);
      const totalAttributedSales = kw.sales || (wm?.d14?.sales ?? 0);
      const attributionConfidence = kw.has_same_sku_attribution === true
        ? 'complete'
        : (kw.attribution_confidence === 'partial' ? 'partial' : 'unknown');
      const sameSkuOrders = attributionConfidence === 'complete' ? Number(kw.same_sku_orders || 0) : null;
      const sameSkuSales = attributionConfidence === 'complete' ? Number(kw.same_sku_sales || 0) : null;
      const kw_orders = sameSkuOrders ?? totalAttributedOrders;
      const kw_sales = sameSkuSales ?? totalAttributedSales;
      const kw_acos = kw_sales > 0 ? (kw_spend / kw_sales) * 100 : null;
      const kw_cvr = kw_clicks > 0 ? kw_orders / kw_clicks : 0;
      const kw_cpc = kw_clicks > 0 ? kw_spend / kw_clicks : 0;
      const kw_ctr = kw_impressions > 0 ? kw_clicks / kw_impressions : 0;
      const entityHistory = targetingHistoryByEntity.get(String(entityId)) || [];
      const clickMaturity = estimateMatureClicks(
        entityHistory.map((row: any) => ({ date: row.date, clicks: row.clicks })),
      );
      const deterioration = detectSequentialDeterioration(
        entityHistory.map((row: any) => ({
          date: row.date,
          clicks: row.clicks,
          orders: attributionConfidence === 'complete' ? row.same_sku_orders : row.orders,
          spend: row.spend,
        })),
      );
      const auctionState = estimateCpcAuctionState(
        entityHistory.map((row: any) => ({
          cpc: row.cpc,
          spend: row.spend,
          clicks: row.clicks,
        })),
      );

      const asinMeta = resolvedAsin ? acosByAsin.get(resolvedAsin) : null;
      let effectiveTargetAcos = effectiveTargetAcos_fn(
        settings.target_acos ?? CANONICAL_CONFIG.ACCOUNT_TARGET_ACOS,
        asinMeta?.break_even ?? null
      );
      let effectiveMaxAcos = asinMeta
        ? Math.min(asinMeta.break_even, (settings.max_acos ?? FB.MAX_ACOS) * 1.5)
        : settings.max_acos;
      const productSafeMaxCpc = asinMeta?.safe_max_cpc || 0;

      const econForProduct = resolvedAsin
        ? (econByNsku.get(normSku(product?.sku || '')) || econByNsku.get(`ASIN:${resolvedAsin}`) || null)
        : null;
      const econStatus = classifyEconomicStatus(econForProduct);

      const protection = attributionConfidence === 'complete'
        ? isHighPerformanceProtected(
            { ...kw, orders: kw_orders, sales: kw_sales, acos: kw_acos },
            settings,
            wm ? {
              acos_14d: kw_acos, acos_30d: kw_acos,
              roas_14d: kw_spend > 0 ? kw_sales / kw_spend : 0,
              orders_14d: kw_orders, orders_30d: kw_orders,
            } : null,
          )
        : { protected: false, reason: 'attribution_promoted_vs_halo_unknown' };

      const kwIntent = kw.keyword_text ? classifySearchIntent(kw.keyword_text) : null;
      const campaignHistoricalCvr = (wm?.d30?.clicks || 0) > 0 && (wm?.d30?.orders || 0) > 0
        ? wm.d30.orders / wm.d30.clicks
        : null;
      const historicalConversionRate = kw_orders > 0 && kw_clicks > 0
        ? kw_cvr
        : campaignHistoricalCvr;
      const maximumEconomicCpc = calculateMaximumEconomicCpc({
        averageSalePrice: kw_orders > 0 ? kw_sales / kw_orders : asinMeta?.selling_price,
        conversionRate: historicalConversionRate,
        targetAcosPercent: effectiveTargetAcos,
        safetyFactor: settings.safety_factor,
      });
      const keywordGoalPolicy = resolveGoalPolicy({
        objective: settings.objective,
        targetAcos: effectiveTargetAcos,
        maximumAcos: effectiveMaxAcos,
        breakEvenAcos: asinMeta?.break_even,
        targetAverageCpc: settings.target_cpc,
        hardMaximumCpc: settings.max_cpc,
        maximumEconomicCpc,
        maximumDailySpend: settings.daily_budget_cap,
        maximumBidChangePct: Math.max(settings.max_bid_increase_pct, settings.max_bid_decrease_pct),
      });
      effectiveTargetAcos = keywordGoalPolicy.effectiveTargets.targetAcos;
      effectiveMaxAcos = keywordGoalPolicy.effectiveTargets.maximumAcos;
      const cpcLimits = [
        productSafeMaxCpc,
        maximumEconomicCpc,
        settings.max_cpc > 0 ? settings.max_cpc : 0,
      ].filter((value: number | null) => value != null && value > 0) as number[];
      const effectiveSafeMaxCpc = cpcLimits.length > 0 ? Math.min(...cpcLimits) : 0;
      const expectedClicksPerOrder = calculateExpectedClicksPerOrder(
        historicalConversionRate,
        settings.fallback_cvr,
      );
      const preliminaryAcquisitionSpend = (asinMeta?.selling_price || 0) > 0 && effectiveTargetAcos > 0
        ? asinMeta.selling_price * (effectiveTargetAcos / 100)
        : 0;

      const lastExec = lastExecByRuleEntity.get(`bid_change|${entityId}`);
      if (lastExec) {
        const lastTs = lastExec.created_date || lastExec.executed_at;
        if (lastTs && (Date.now() - new Date(lastTs).getTime()) / 3600000 < settings.cooldown_hours) {
          stats.skipped_cooldown++;
          continue;
        }
      }

      const lastGrowthTs = lastGrowthByEntity.get(entityId) || 0;
      const growthCooldownActive = lastGrowthTs > 0 && (Date.now() - lastGrowthTs) / 3600000 < settings.growth_cooldown_hours;

      if (inventoryCoverage && ['critical', 'low'].includes(inventoryCoverage.status) && stockCovDays != null) {
        const isCritical = inventoryCoverage.status === 'critical';
        const reductionPct = isCritical
          ? settings.max_bid_decrease_pct * 0.90
          : settings.max_bid_decrease_pct * 0.40;
        const newBid = Math.max(settings.min_bid, currentBid * (1 - reductionPct));
        const ruleKey = isCritical ? 'stock_critical' : 'stock_low';
        const iKey = `${ruleKey}|${aid}|${entityId}|${today}`;
        if (!usedIdemKeys.has(iKey) && newBid < currentBid - 0.01) {
          decisions.push(buildDecision(aid, correlationId, {
            decision_type: 'bid_change', entity_type: 'keyword', entity_id: entityId,
            campaign_id: kw.campaign_id, keyword_id: kw.keyword_id, asin: resolvedAsin,
            keyword_text: kw.keyword_text, action: 'set_bid',
            value_before: currentBid, value_after: newBid,
            rationale: isCritical
              ? `⚠️ ESTOQUE CRÍTICO: ${Math.round(stockCovDays)}d de cobertura disponível${inventoryCoverage.inbound_inventory > 0 ? ` (${Math.round(inventoryCoverage.days_of_supply_with_inbound || 0)}d projetados com inbound)` : ''}. Bid reduzido ${Math.round(reductionPct * 100)}% para conservar estoque vendável.`
              : `📦 ESTOQUE BAIXO: ${Math.round(stockCovDays)}d de cobertura disponível${inventoryCoverage.inbound_inventory > 0 ? ` (${Math.round(inventoryCoverage.days_of_supply_with_inbound || 0)}d projetados com inbound)` : ''}. Bid reduzido ${Math.round(reductionPct * 100)}% preventivamente.`,
            rule_key: ruleKey, risk: isCritical ? 'medium' : 'low', priority: PRIORITY.stock,
            search_intent: kwIntent, settings_source: settings.source, settings_snapshot: settingsSnapshot,
            idempotency_key: iKey, stock_coverage_days: stockCovDays,
            stock_coverage_with_inbound_days: inventoryCoverage.days_of_supply_with_inbound,
            stock_qty: inventoryCoverage.available_now,
            stock_inbound_qty: inventoryCoverage.inbound_inventory,
            stock_reserved_qty: inventoryCoverage.reserved_inventory,
            sales_velocity_daily: inventoryCoverage.daily_sales_velocity,
            inventory_signal_quality: inventoryCoverage.data_quality,
            opportunity_state: 'no_opportunity',
            stock_urgency: isCritical ? 'critical' : 'low',
          }));
          entityChangedThisCycle.set(entityId, ruleKey);
          stats.skipped_stock++;
          continue;
        }
      }

      if (econStatus.block_expansion) {
        stats.skipped_margin++;
        skipped.push({ entity_id: entityId, reason: 'negative_margin_confirmed', asin: resolvedAsin, block_reason: econStatus.block_reason });
        continue;
      }

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

      const campaignDailyBudget = Number(campForKw?.daily_budget || 0);
      const safeStockCovDays = stockCovDays ?? 0;
      const visSc = calcVisibilityScore({
        impressions_14d: kw_impressions,
        impressions_30d: wm?.d30?.impressions ?? kw_impressions,
        trend_3_vs_14: wm?.trend_3_vs_14 ?? 0,
        cvr: kw_cvr,
        stock_days: safeStockCovDays,
        is_active: stockQty > 0,
        budget_consumed_pct: campaignDailyBudget > 0
          ? Math.min(1, (wm?.d3?.spend ?? 0) / (campaignDailyBudget * 3)) : 0.5,
      });

      const opp = calcOpportunityScore({
        visibility_score: visSc.visibility_score,
        cvr: kw_cvr,
        has_sales: kw_orders > 0,
        acos_14d: kw_acos,
        target_acos: effectiveTargetAcos,
        profit_protection_mode: asinMeta?.profit_protection?.mode || 'normal',
        stock_days: safeStockCovDays,
        economic_confidence: econStatus.economic_confidence,
        impression_share: kw_impressions > 0 ? Math.min(1, kw_impressions / 20000) : 0,
        cpc: kw_cpc,
        safe_max_cpc: effectiveSafeMaxCpc,
        data_freshness: dataFreshness,
      });
      const predictedCpcUnsafe = effectiveSafeMaxCpc > 0
        && auctionState.predicted_cpc_next_window > effectiveSafeMaxCpc;
      if (
        attributionConfidence !== 'complete'
        || asinMeta?.block_growth === true
        || predictedCpcUnsafe
      ) {
        opp.can_grow = false;
        opp.block_reason = attributionConfidence !== 'complete'
          ? 'attribution_promoted_vs_halo_unknown'
          : asinMeta?.block_growth === true
            ? `sku_economic_state_${asinMeta?.economic_state || 'defensive'}`
            : 'predicted_cpc_above_safe_limit';
      }

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
        stock_days: stockCovDays != null ? Math.round(stockCovDays) : null,
        safe_max_cpc: effectiveSafeMaxCpc,
        partial_cost: econStatus.allow_conservative_growth && econStatus.economic_data_incomplete,
        attribution_confidence: attributionConfidence,
        same_sku_orders: sameSkuOrders,
        same_sku_sales: sameSkuSales,
        predicted_cpc: auctionState.predicted_cpc_next_window,
        auction_pressure_state: auctionState.auction_pressure_state,
      });

      if (protection.protected) {
        stats.protected++;
        if (stockCovDays != null && stockCovDays >= settings.min_stock_days && opp.can_grow && !growthCooldownActive) {
          const increase = getGrowthIncrement('moderate') * 0.5;
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

      const wpKwResult = checkWinnerProtection({
        orders_14d: wm?.d14?.orders ?? kw_orders,
        acos_14d: kw_acos,
        target_acos: effectiveTargetAcos,
        orders_30d: wm?.d30?.orders ?? kw_orders,
        roas_30d: wm?.d30?.roas ?? kw.roas ?? 0,
        target_roas: settings.target_roas ?? 4,
        last_sale_at: kw.last_sale_at || kw.last_order_at || null,
        protected_high_performance: false,
        recent_sale_protection_hours: FB.RECENT_SALE_PROTECTION_HOURS,
      });
      const recentSaleProtected = attributionConfidence === 'complete'
        && FB.WINNER_PROTECTION_ENABLED
        && wpKwResult.protected;

      const adaptiveMinimumClicks = kw_orders === 0
        ? Math.min(FB.MIN_CLICKS_BEFORE_PAUSE, expectedClicksPerOrder)
        : FB.MIN_CLICKS_BEFORE_PAUSE;
      const adaptiveMinimumSpend = kw_orders === 0 && preliminaryAcquisitionSpend > 0
        ? Math.min(MRC.MIN_SPEND, preliminaryAcquisitionSpend)
        : MRC.MIN_SPEND;
      const hasMinEvidence = kw_clicks >= adaptiveMinimumClicks
        && kw_impressions >= FB.MIN_IMP_BEFORE_PAUSE
        && kw_spend >= adaptiveMinimumSpend;
      const hasCtrQuality = kw_impressions > 0 && kw_ctr >= MRC.MIN_CTR;

      if (!hasMinEvidence) {
        stats.held++;

        const kwCreatedAt = kw.created_at || kw.created_date || null;
        const kwAgeHours = kwCreatedAt ? (Date.now() - new Date(kwCreatedAt).getTime()) / 3600000 : 0;
        const hasZeroImpressions = (kw_impressions ?? 0) === 0;
        const isEligibleForBootstrap = kwAgeHours >= FB.ZERO_IMP_FIRST_REVIEW_HOURS
          && kwAgeHours <= FB.ZERO_IMP_KEYWORD_PAUSE_DAYS * 24;
        const bootstrapAttempts = Number(kw.zero_delivery_attempts || 0);
        const replacementDue = kwAgeHours > FB.ZERO_IMP_KEYWORD_PAUSE_DAYS * 24
          && bootstrapAttempts >= 2;

        if (hasZeroImpressions && replacementDue && stockCovDays != null && stockCovDays > 0) {
          const iKey = `zero_imp_replace_15d|${aid}|${entityId}|${today}`;
          if (!usedIdemKeys.has(iKey)) {
            decisions.push(buildDecision(aid, correlationId, {
              decision_type: 'reduce_waste', entity_type: 'keyword', entity_id: entityId,
              campaign_id: kw.campaign_id, keyword_id: kw.keyword_id, asin: resolvedAsin,
              keyword_text: kw.keyword_text, action: 'pause_keyword',
              value_before: currentBid, value_after: currentBid,
              rationale: `ZERO IMPRESSÕES após ${Math.round(kwAgeHours / 24)} dias e duas tentativas controladas de bootstrap. Pausa somente da keyword para substituição por termo comprovado; a campanha e demais entidades vencedoras são preservadas.`,
              rule_key: 'zero_impressions_replace_after_15d', risk: 'low', priority: PRIORITY.waste_reduction,
              search_intent: kwIntent, settings_source: settings.source, settings_snapshot: settingsSnapshot,
              idempotency_key: iKey, opportunity_state: 'no_opportunity',
            }));
            entityChangedThisCycle.set(entityId, 'zero_imp_pause');
            stats.paused++;
          }
          continue;
        }

        if (hasZeroImpressions && isEligibleForBootstrap) {
          skipped.push({
            entity_id: entityId,
            reason: 'delegated_to_controlled_zero_delivery_bootstrap',
            age_days: Math.round(kwAgeHours / 24),
            attempts: bootstrapAttempts,
            asin: resolvedAsin,
          });
        }
        continue;
      }

      const funnel = calcFunnel({
        impressions: kw_impressions, clicks: kw_clicks, orders: kw_orders,
        spend: kw_spend, sales: kw_sales,
        contribution_margin_amount: asinMeta?.contribution_margin_amount || 0,
      });

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

      const acquisitionLimits = [
        funnel.maximum_profitable_cpa,
        preliminaryAcquisitionSpend,
      ].filter((value: number) => value > 0);
      const noConvMinSpend = acquisitionLimits.length > 0
        ? Math.min(...acquisitionLimits)
        : MRC.MIN_SPEND;
      const noConvDataValid = econStatus.economic_confidence !== 'none' && dataFreshness !== 'stale';
      const campCreatedAt = campForKw?.created_at || campForKw?.created_date || null;
      const campAgeHours = campCreatedAt ? (Date.now() - new Date(campCreatedAt).getTime()) / 3600000 : 999;
      const hasMinExposureTime = campAgeHours >= FB.NO_SALES_FIRST_REVIEW_HOURS;
      const campAgeDays = campAgeHours / 24;
      const canPauseCampaign = campAgeDays >= FB.NO_SALES_CAMPAIGN_PAUSE_DAYS;
      const isSecondReview = campAgeDays >= FB.NO_SALES_SECOND_REVIEW_DAYS;
      const isNewProduct = product?.is_new_asin === true || campAgeDays < FB.NEW_PRODUCT_MAX_LEARNING_DAYS;

      const mlTailIsLong = mlContext?.tail_type === 'long';
      const mlEvidenceLow = mlContext?.evidence_level === 'LOW' || mlContext?.evidence_level === 'NONE';
      if (mlTailIsLong && mlEvidenceLow && kw_impressions > 0 && kw_impressions < FB.MIN_IMP_BEFORE_PAUSE) {
        skipped.push({ entity_id: entityId, reason: 'ml_long_tail_low_volume_protected', asin: resolvedAsin, impressions: kw_impressions });
        continue;
      }

      const isLowIntent = kwIntent?.purchase_intent === 'low' || kwIntent?.intent_type === 'informational';
      const latestEntityDataAt = entityHistory
        .map((row: any) => String(row.date || ''))
        .filter(Boolean)
        .sort()
        .at(-1) || null;
      const previousReduction = recentExecs.find((execution: any) => {
        const executionEntity = String(execution.entity_id || execution.keyword_id || '');
        if (executionEntity !== String(entityId)) return false;
        const before = Number(execution.value_before);
        const after = Number(execution.value_after);
        return (Number.isFinite(before) && Number.isFinite(after) && after < before)
          || String(execution.rule_key || '').includes('reduce');
      });
      const previousReductionAt = previousReduction?.executed_at || previousReduction?.created_date || null;
      const hasNewDataAfterReduction = Boolean(
        previousReductionAt
        && latestEntityDataAt
        && latestEntityDataAt > String(previousReductionAt).slice(0, 10),
      );
      const noConversionEvidence = assessNoConversionEvidence({
        clicks: kw_clicks,
        matureClicks: clickMaturity.mature_clicks,
        spend: kw_spend,
        conversionRate: historicalConversionRate,
        fallbackConversionRate: settings.fallback_cvr,
        maximumAcquisitionSpend: noConvMinSpend,
        persistentLowRelevance: isLowIntent && isSecondReview,
        priorReduction: Boolean(previousReduction) && hasNewDataAfterReduction,
        attributionConfidence,
        ageDays: campAgeDays,
        isNewProduct,
        currentCpc: kw_cpc,
        safeCpc: effectiveSafeMaxCpc,
        deteriorationLevel: deterioration.level,
      });

      if (!recentSaleProtected && hasMinExposureTime
          && kw_orders === 0 && kw_impressions >= FB.MIN_IMP_BEFORE_PAUSE
          && noConvDataValid
          && (attributionConfidence === 'complete' || noConversionEvidence.financial_evidence)
          && noConversionEvidence.level !== 'wait_for_data') {
        const iKey = `no_conversion|${aid}|${entityId}|${today}`;
        if (!usedIdemKeys.has(iKey)) {
          const shouldPause = canPauseCampaign
            && noConversionEvidence.level === 'pause_candidate'
            && !isNewProduct;
          const reductionPct = attributionConfidence === 'complete'
            ? Math.min(
                settings.max_bid_decrease_pct,
                Math.max(0.10, noConversionEvidence.recommended_reduction_pct),
              )
            : Math.min(0.10, settings.max_bid_decrease_pct);
          const newBid = shouldPause
            ? settings.min_bid
            : clamp(currentBid * (1 - reductionPct), settings.min_bid, settings.max_bid);
          const phase = canPauseCampaign ? '3ª revisão (14d+)' : isSecondReview ? '2ª revisão (10d+)' : '1ª revisão (7d+)';
          const confidence = noConversionEvidence.level === 'pause_candidate'
            ? 90
            : noConversionEvidence.level === 'reduce_strong' ? 82 : 70;
          const nextReviewDays = noConversionEvidence.level === 'reduce_soft' ? 5 : 3;
          decisions.push(buildDecision(aid, correlationId, {
            decision_type: shouldPause ? 'reduce_waste' : 'bid_change',
            entity_type: 'keyword', entity_id: entityId,
            campaign_id: kw.campaign_id, keyword_id: kw.keyword_id, asin: resolvedAsin,
            keyword_text: kw.keyword_text, action: shouldPause ? 'pause_keyword' : 'set_bid',
            value_before: currentBid, value_after: newBid,
            rationale: `[${phase}] ZERO conversões após ${kw_clicks} cliques (${noConversionEvidence.click_multiple}× os ${noConversionEvidence.expected_clicks_per_order} cliques esperados por pedido) e R${kw_spend.toFixed(2)} de gasto (${noConversionEvidence.spend_multiple ?? 0}× o limite de aquisição R${noConvMinSpend.toFixed(2)}). Intenção: ${kwIntent?.intent_type || 'desconhecida'}. ${shouldPause ? 'PAUSA — baixa relevância persistente, maturidade e evidência financeira confirmadas.' : `Bid reduzido ${Math.round(reductionPct * 100)}%.`}`,
            rule_key: shouldPause ? 'no_conversion_pause' : 'no_conversion_reduce',
            risk: shouldPause ? 'medium' : 'low', priority: PRIORITY.waste_reduction,
            search_intent: kwIntent, settings_source: settings.source, settings_snapshot: settingsSnapshot,
            idempotency_key: iKey, opportunity_state: 'no_opportunity',
            confidence,
            expected_clicks_per_order: noConversionEvidence.expected_clicks_per_order,
            no_conversion_click_multiple: noConversionEvidence.click_multiple,
            maximum_acquisition_spend: noConvMinSpend,
            maximum_economic_cpc: maximumEconomicCpc,
            current_cpc: kw_cpc,
            current_acos: kw_acos,
            target_acos: effectiveTargetAcos,
            decision_confidence_level: confidence >= 85 ? 'high' : 'medium',
            next_review_days: nextReviewDays,
            model_version: 'probabilistic-economic-v1',
            economic_state: asinMeta?.economic_state || 'UNKNOWN',
            intervention_state: noConversionEvidence.internal_state,
            posterior_cvr: noConversionEvidence.posterior_cvr,
            posterior_cvr_low_95: noConversionEvidence.posterior_cvr_low_95,
            posterior_cvr_high_95: noConversionEvidence.posterior_cvr_high_95,
            probability_below_sustainable: noConversionEvidence.probability_below_sustainable,
            raw_clicks: clickMaturity.raw_clicks,
            mature_clicks: clickMaturity.mature_clicks,
            maturity_ratio: clickMaturity.maturity_ratio,
            same_sku_orders: sameSkuOrders,
            same_sku_sales: sameSkuSales,
            halo_orders: attributionConfidence === 'complete' ? Number(kw.halo_orders || 0) : null,
            halo_sales: attributionConfidence === 'complete' ? Number(kw.halo_sales || 0) : null,
            attribution_confidence: attributionConfidence,
            contribution_margin_per_order: asinMeta?.contribution_margin_amount || 0,
            profit_after_ads_total: asinMeta?.profit_after_ads_14d,
            maximum_profitable_cpa: funnel.maximum_profitable_cpa,
            safe_cpc: effectiveSafeMaxCpc,
            ...auctionState,
            deterioration_level: deterioration.level,
            prior_reduction: Boolean(previousReduction) && hasNewDataAfterReduction,
            data_window_start: cutoff30d,
            data_window_end: latestEntityDataAt,
            last_change_version: previousReductionAt || 'none',
            goal_policy_snapshot: JSON.stringify(keywordGoalPolicy),
          }));
          entityChangedThisCycle.set(entityId, 'no_conversion');
          if (shouldPause) stats.paused++; else stats.bid_reduce++;
        }
        continue;
      }

      if (
        effectiveSafeMaxCpc > 0
        && (kw_cpc > effectiveSafeMaxCpc || auctionState.predicted_cpc_next_window > effectiveSafeMaxCpc)
        && kw_clicks >= MRC.MIN_CLICKS
      ) {
        const newBid = clamp(currentBid * (1 - Math.min(settings.max_bid_decrease_pct, 0.20)), settings.min_bid, settings.max_bid);
        const iKey = `cpc_above_safe|${aid}|${entityId}|${today}`;
        if (!usedIdemKeys.has(iKey) && newBid < currentBid - 0.01) {
          decisions.push(buildDecision(aid, correlationId, {
            decision_type: 'bid_change', entity_type: 'keyword', entity_id: entityId,
            campaign_id: kw.campaign_id, keyword_id: kw.keyword_id, asin: resolvedAsin,
            keyword_text: kw.keyword_text, action: 'set_bid',
            value_before: currentBid, value_after: newBid,
            rationale: `CPC atual R$${kw_cpc.toFixed(2)} / previsto R$${auctionState.predicted_cpc_next_window.toFixed(2)} acima do safe max R$${effectiveSafeMaxCpc.toFixed(2)}. Bid reduzido.`,
            rule_key: 'cpc_above_safe_max', risk: 'medium', priority: PRIORITY.margin,
            search_intent: kwIntent, settings_source: settings.source, settings_snapshot: settingsSnapshot,
            idempotency_key: iKey, opportunity_state: 'no_opportunity',
            maximum_economic_cpc: maximumEconomicCpc,
            current_cpc: kw_cpc,
            current_acos: kw_acos,
            target_acos: effectiveTargetAcos,
            next_review_days: 3,
            safe_cpc: effectiveSafeMaxCpc,
            ...auctionState,
            deterioration_level: deterioration.level,
            attribution_confidence: attributionConfidence,
            same_sku_orders: sameSkuOrders,
            same_sku_sales: sameSkuSales,
            data_window_start: cutoff30d,
            data_window_end: entityHistory.map((row: any) => row.date).filter(Boolean).sort().at(-1) || null,
            goal_policy_snapshot: JSON.stringify(keywordGoalPolicy),
          }));
          entityChangedThisCycle.set(entityId, 'cpc_safe');
          stats.bid_reduce++;
        }
        continue;
      }

      if (growthCooldownActive) {
        skipped.push({ entity_id: entityId, reason: 'growth_cooldown_active', asin: resolvedAsin });
        continue;
      }

      if (!opp.can_grow || opp.opportunity_score < 0.20) {
        skipped.push({ entity_id: entityId, reason: 'no_growth_opportunity', opportunity_score: opp.opportunity_score, asin: resolvedAsin });
        continue;
      }

      let daypartSlotNote = `slot ${currentSlotClassification}`;
      if (currentSlotClassification === 'WEAK_TIME' || currentSlotClassification === 'LOSS_TIME') {
        skipped.push({ entity_id: entityId, reason: 'daypart_weak_time', slot: currentSlotClassification, hour: currentHourBRT, asin: resolvedAsin });
        continue;
      }

      if (campForKw) {
        const tos = Number(campForKw.top_of_search_adjustment || 0);
        const ros = Number(campForKw.rest_of_search_adjustment || 0);
        const pp  = Number(campForKw.product_pages_adjustment || 0);
        const tosLimit = settings.top_of_search_limit;
        const rosLimit = settings.rest_of_search_limit;
        const ppLimit  = settings.product_page_limit;

        const placementViolations: string[] = [];
        if (tosLimit > 0 && tos > tosLimit) placementViolations.push(`ToS ${tos}% > limite ${tosLimit}%`);
        if (rosLimit > 0 && ros > rosLimit) placementViolations.push(`RoS ${ros}% > limite ${rosLimit}%`);
        if (ppLimit  > 0 && pp  > ppLimit)  placementViolations.push(`PP ${pp}% > limite ${ppLimit}%`);

        if (placementViolations.length > 0) {
          skipped.push({
            entity_id: entityId,
            reason: 'placement_above_limit_executor_not_canonical',
            violations: placementViolations,
            asin: resolvedAsin,
          });

          const campForPlacement = campForKw.campaign_id || campForKw.amazon_campaign_id;
          // O executor canônico ainda não suporta placement_change. Registrar a
          // lacuna, mas não criar uma decisão aprovada que inevitavelmente falhará.
          const placementExecutionSupported = validateAmazonAction({
            action: 'reduce_placement_adjustment',
            execution_mode: 'EXPEDITED_QUEUE',
          }).valid;
          if (placementExecutionSupported && campForPlacement) {
            const placementIKey = `placement_cap|${campForPlacement}|${today}`;
            if (!usedIdemKeys.has(placementIKey) && !entityChangedThisCycle.has(`placement|${campForPlacement}`)) {
              usedIdemKeys.add(placementIKey);
              entityChangedThisCycle.set(`placement|${campForPlacement}`, 'placement_cap');
              base44.asServiceRole.entities.OptimizationDecision.create({
                amazon_account_id: aid,
                decision_type: 'placement_change',
                entity_type: 'campaign',
                entity_id: campForPlacement,
                campaign_id: campForPlacement,
                asin: resolvedAsin,
                action: 'reduce_placement_adjustment',
                rationale: `placement_above_limit: ${placementViolations.join(' | ')}. Ajustes de placement acima do limite configurado — reduzir para respeitar teto.`,
                rule_key: 'placement_cap_guardrail',
                status: 'approved',
                approval_status: 'auto_approved',
                requires_approval: false,
                risk: 'low',
                idempotency_key: placementIKey,
                source_function: 'runDeterministicDecisionEngine_v8',
                created_at: now,
              }).catch(() => {});
            }
          }
          continue;
        }
      }

      daypartSlotNote = currentSlotClassification === 'NORMAL_TIME'
        ? `slot NORMAL_TIME — crescimento capped a 5%`
        : `slot ${currentSlotClassification} +${Math.round((currentSlotClassification === 'ELITE_TIME' ? getGrowthIncrement(opp.growth_confidence) : getGrowthIncrement(opp.growth_confidence)) * 100)}% permitido`;

      const isPartialCost = econStatus.economic_data_incomplete;
      let maxGrowthPct = isPartialCost ? FB.PARTIAL_COST_MAX_INCREASE : getGrowthIncrement(opp.growth_confidence);
      if (currentSlotClassification === 'NORMAL_TIME') {
        maxGrowthPct = Math.min(maxGrowthPct, 0.05);
      }
      const growthPct = Math.min(maxGrowthPct, FB.MAX_GROWTH_FACTOR - 1);

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

      let growthScenario = 'A';
      let ruleKey = 'increase_bid_profitable_growth';
      let decisionType = 'increase_bid_profitable_growth';
      let rationale = '';
      let growthRisk: 'low' | 'medium' | 'high' = 'low';

      if (visSc.is_low_visibility && kw_orders > 0 && kw_acos !== null && effectiveTargetAcos !== null && kw_acos <= effectiveTargetAcos) {
        growthScenario = 'A';
        ruleKey = 'increase_bid_low_visibility';
        decisionType = 'increase_bid_low_visibility';
        growthRisk = 'low';
        rationale = `📈 CENÁRIO A — Keyword com ACoS ${kw_acos.toFixed(1)}% ≤ meta ${effectiveTargetAcos}% e baixa visibilidade (${kw_impressions} impr/14d, score ${visSc.visibility_score.toFixed(2)}). Bid aumentado +${Math.round(growthPct * 100)}% para ampliar exposição. CPC projetado R$${proposed_bid.toFixed(2)}, abaixo do limite econômico. [${daypartSlotNote}] ${sim.reason}`;
        stats.low_visibility_growth++;
      } else if (kw_cvr > settings.fallback_cvr * 1.2 && kw_orders >= 1 && visSc.is_low_visibility) {
        growthScenario = 'B';
        ruleKey = 'increase_bid_high_conversion';
        decisionType = 'increase_bid_profitable_growth';
        growthRisk = 'low';
        rationale = `📈 CENÁRIO B — Keyword com CVR ${(kw_cvr * 100).toFixed(2)}% acima da média e baixa exposição (${kw_impressions} impr/14d). ${kw_orders} venda(s). Bid aumentado +${Math.round(growthPct * 100)}% para testar crescimento de volume. [${daypartSlotNote}] ${sim.reason}`;
        stats.emerging_growth++;
      } else if (kw_acos !== null && effectiveTargetAcos !== null && kw_acos <= effectiveTargetAcos * 0.75 && kw_orders >= 1) {
        growthScenario = 'A2';
        ruleKey = 'increase_bid_profitable_growth';
        decisionType = 'increase_bid_profitable_growth';
        growthRisk = 'low';
        rationale = `📈 CENÁRIO A — ACoS ${kw_acos.toFixed(1)}% muito abaixo da meta ${effectiveTargetAcos}%. ${kw_orders}p vendidos, CPA R$${funnel.actual_cpa.toFixed(2)} vs máx. lucrável R$${funnel.maximum_profitable_cpa.toFixed(2)}. Lucro pós-ADS: R$${(asinMeta?.profit_after_ads_14d || 0).toFixed(2)}/ped. Bid +${Math.round(growthPct * 100)}% para escalar. [${daypartSlotNote}] ${sim.reason}`;
        stats.profitable_growth++;
      } else if (opp.opportunity_state === 'high_growth_opportunity') {
        growthScenario = 'HG';
        ruleKey = 'increase_bid_high_growth';
        decisionType = 'increase_bid_profitable_growth';
        growthRisk = 'medium';
        rationale = `🚀 ALTA OPORTUNIDADE — Produto lucrativo, ${kw_orders}+ vendas, CVR ${(kw_cvr * 100).toFixed(2)}%, visibilidade limitada. Margem: R$${(asinMeta?.contribution_margin_amount || 0).toFixed(2)}. Bid +${Math.round(growthPct * 100)}% para crescimento sustentado. [${daypartSlotNote}] ${sim.reason}`;
        stats.high_growth++;
      } else if (isPartialCost && kw_orders >= 1) {
        growthScenario = 'PC';
        ruleKey = 'conservative_growth_partial_cost';
        decisionType = 'experimental_growth';
        growthRisk = 'medium';
        rationale = `🔬 TESTE CONSERVADOR — Produto com custo parcial (economic_data_partial), ${kw_orders} venda(s), CPC R$${kw_cpc.toFixed(2)} controlado. Sem prejuízo confirmado. Aumento conservador +${Math.round(growthPct * 100)}% para manter visibilidade. Reavaliação em 72h. [${daypartSlotNote}] ${sim.reason}`;
        stats.partial_cost_growth++;
        stats.conservative_growth++;
      } else {
        growthScenario = 'E';
        ruleKey = 'emerging_opportunity_growth';
        decisionType = sim.experimental ? 'experimental_growth' : 'increase_bid_profitable_growth';
        growthRisk = 'medium';
        rationale = `📊 OPORTUNIDADE EMERGENTE — opportunity_score ${opp.opportunity_score.toFixed(2)}, confiança ${opp.growth_confidence}. Bid +${Math.round(growthPct * 100)}% para teste de crescimento. [${daypartSlotNote}] ${sim.reason}`;
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

    // A redução de ACoS é decidida acima, por entidade, dentro deste motor.
    // Não dispare runAcosBidReductionEngine em paralelo: ele poderia produzir
    // uma segunda decisão para a mesma keyword com outra janela de dados.

    // ── 10b. IMMEDIATE_BUDGET_RESCUE (substitui Cenário C) ────────────────
    // Executa sincronamente: aumenta orçamento de campanhas SP rentáveis com
    // ≥95% de utilização via Budget Usage API (Campaign.current_spend),
    // confirma na Amazon antes de atualizar localmente. Cooldown 24h, +20% max.
    const campaignBudgetDecisions: any[] = []; // mantido vazio — rescue executa diretamente
    await runImmediateBudgetRescue({
      aid, now, today, correlationId, base44,
      campaigns, campWindowMetrics, acosByAsin, productMap, campaignAsinMap,
      authorizedEligibleAsins, settings, dataFreshness,
      usedIdemKeys, entityChangedThisCycle, account, stats,
    });

    // ── 10c. Guardrail global de orçamento ────────────────────────────────
    if (budgetGuardrailActive) {
      decisions.forEach((d: any) => {
        if ((d.action === 'set_bid' || d.action === 'set_budget') && d.value_after > d.value_before) {
          d.approval_status = 'blocked_budget_cap';
          d.rationale += ` [BLOQUEADO: gasto R$${realSpendYesterday.toFixed(2)} excedeu cap R$${settings.daily_budget_cap}]`;
        }
      });
    }

    // Combinar decisões (rescue já executou diretamente — não entra no allDecisions)
    const allDecisions = [...decisions, ...campaignBudgetDecisions];
    for (const decision of allDecisions) {
      decision.data_window_start = decision.data_window_start || cutoff30d;
      decision.data_window_end = decision.data_window_end || latestMetricsDate;
      const previousChange = recentExecs.find((execution: any) =>
        String(execution.entity_id || execution.keyword_id || '') === String(decision.entity_id || '')
      );
      decision.last_change_version = decision.last_change_version
        || previousChange?.executed_at
        || previousChange?.created_date
        || 'none';
      const baseKey = String(
        decision.idempotency_key
        || `${decision.rule_key}|${aid}|${decision.entity_id}`,
      );
      decision.idempotency_key = `${baseKey}|window:${decision.data_window_end}|change:${decision.last_change_version}`;
    }

    // ── 10d. Priorização ──────────────────────────────────────────────────
    const STOCK_RULES = new Set(['stock_zero', 'stock_critical', 'stock_low']);
    allDecisions.sort((a: any, b: any) => {
      const aIsStock = STOCK_RULES.has(a.rule_key || '');
      const bIsStock = STOCK_RULES.has(b.rule_key || '');
      if (aIsStock !== bIsStock) return aIsStock ? -1 : 1;
      if (a.priority !== b.priority) return a.priority - b.priority;
      const aDays = a.stock_coverage_days ?? 999;
      const bDays = b.stock_coverage_days ?? 999;
      if (Math.abs(aDays - bDays) > 1) return aDays - bDays;
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
          execution_mode: d.execution_mode,
          priority_class: d.priority_class,
          urgency_reason_code: d.urgency_reason_code,
          execution_sla_seconds: d.execution_sla_seconds,
          expected_loss_if_delayed: d.expected_loss_if_delayed,
          conflict_group: d.conflict_group,
          requires_fresh_data: d.requires_fresh_data,
          maximum_data_age_minutes: d.maximum_data_age_minutes,
          confirmation_required: d.confirmation_required,
          idempotency_key: d.idempotency_key,
          source_function: 'runDeterministicDecisionEngine_v7',
          created_at: now,
          search_intent_type: d.search_intent?.intent_type,
          search_intent_cluster: d.search_intent?.cluster,
          purchase_intent: d.search_intent?.purchase_intent,
          purchase_intent_score: d.search_intent?.purchase_intent_score,
          settings_source: d.settings_source,
          data_quality: dataFreshness,
          stock_coverage_days: d.stock_coverage_days,
          stock_coverage_with_inbound_days: d.stock_coverage_with_inbound_days,
          stock_qty: d.stock_qty,
          stock_inbound_qty: d.stock_inbound_qty,
          stock_reserved_qty: d.stock_reserved_qty,
          stock_urgency: d.stock_urgency,
          sales_velocity_daily: d.sales_velocity_daily,
          inventory_signal_quality: d.inventory_signal_quality,
          current_cpc: d.current_cpc,
          maximum_economic_cpc: d.maximum_economic_cpc,
          current_acos: d.current_acos,
          target_acos: d.target_acos,
          expected_clicks_per_order: d.expected_clicks_per_order,
          no_conversion_click_multiple: d.no_conversion_click_multiple,
          maximum_acquisition_spend: d.maximum_acquisition_spend,
          model_version: d.model_version || 'probabilistic-economic-v1',
          economic_state: d.economic_state,
          intervention_state: d.intervention_state,
          posterior_cvr: d.posterior_cvr,
          posterior_cvr_low_95: d.posterior_cvr_low_95,
          posterior_cvr_high_95: d.posterior_cvr_high_95,
          probability_below_sustainable: d.probability_below_sustainable,
          raw_clicks: d.raw_clicks,
          mature_clicks: d.mature_clicks,
          maturity_ratio: d.maturity_ratio,
          same_sku_orders: d.same_sku_orders,
          same_sku_sales: d.same_sku_sales,
          halo_orders: d.halo_orders,
          halo_sales: d.halo_sales,
          attribution_confidence: d.attribution_confidence,
          contribution_margin_per_order: d.contribution_margin_per_order,
          profit_after_ads_total: d.profit_after_ads_total,
          maximum_profitable_cpa: d.maximum_profitable_cpa,
          safe_cpc: d.safe_cpc,
          cpc_kalman_level: d.cpc_kalman_level,
          cpc_kalman_trend: d.cpc_kalman_trend,
          predicted_cpc_next_window: d.predicted_cpc_next_window,
          innovation: d.innovation,
          innovation_z_score: d.innovation_z_score,
          auction_pressure_state: d.auction_pressure_state,
          deterioration_level: d.deterioration_level,
          prior_reduction: d.prior_reduction,
          data_window_start: d.data_window_start,
          data_window_end: d.data_window_end,
          last_change_version: d.last_change_version,
          goal_policy_snapshot: d.goal_policy_snapshot || JSON.stringify(accountGoalPolicy),
          decision_confidence_level: d.decision_confidence_level,
          next_review_days: d.next_review_days,
        }))
      ).catch(() => []);
      saved += batch.length;
    }

    // ── 11b. Disparar execução imediata (fire-and-forget) ────────────────
    if (saved > 0) {
      base44.asServiceRole.functions.invoke('executeApprovedDecisionQueue', {
        amazon_account_id: aid,
        _service_role: true,
      }).catch(() => {});
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
      engine: 'unified-strategic-v8',
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
        scenarios: ['A: lucrativo+baixa_vis', 'B: alta_cvr+baixo_volume', 'C: IMMEDIATE_BUDGET_RESCUE (≥95% utilization)', 'D: produto_novo+sinal', 'E: top_search'],
        increments: { low: '3%', moderate: '5%', high: '8%', very_high: '10%', exceptional: '15%' },
      },

      economic_context: {
        products_with_dynamic_target: acosByAsin.size,
        real_spend_yesterday: Math.round(realSpendYesterday * 100) / 100,
        budget_cap: settings.daily_budget_cap,
        budget_guardrail_triggered: budgetGuardrailActive,
        products_updated: productUpdates.length,
        econ_records_updated: econUpdates.length,
        budget_recalculation: {
          spend_24h: Math.round(spend24h * 100) / 100,
          sales_24h: Math.round(sales24h * 100) / 100,
          orders_24h: orders24h,
          acos_24h: acos24h !== null ? Math.round(acos24h * 10) / 10 : null,
          roas_24h: roas24h !== null ? Math.round(roas24h * 100) / 100 : null,
          previous_cap: budgetCapChanged ? Math.round((settings.daily_budget_cap / (recalculatedBudgetCap > settings.daily_budget_cap ? 1.10 : recalculatedBudgetCap < settings.daily_budget_cap ? 0.90 : 0.95)) * 100) / 100 : settings.daily_budget_cap,
          new_cap: recalculatedBudgetCap,
          changed: budgetCapChanged,
          reason: budgetAdjustReason,
          user_cap: effectiveUserCap,
          avg_break_even_acos: Math.round(avgBreakEven * 10) / 10,
        },
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

      auto_deduplication: {
        duplicates_archived: autoDuplicatesArchived.length,
        archived_campaigns: autoDuplicatesArchived,
      },

      account_acos_control_loop: {
        weighted_acos: accountWeightedAcos,
        zone: accountAcosZone.zone,
        description: accountAcosZone.description,
        action: accountAcosZone.action,
        avg_break_even: Math.round(avgBreakEvenAccount * 10) / 10,
        portfolio_worst_campaigns: portfolioRanking.slice(0, 5).map((r: any) => ({
          campaign_id: r.id, marginal_acos: r.marginal_acos, rank: r.rank,
        })),
      },

      guardrails: {
        zero_campaign_guard: 'ATIVO',
        batch_pause_guard: 'ATIVO (30% exige force_batch; 50% bloqueia)',
        winner_protection: 'ATIVO canônico via evaluateWinnerProtection()',
        acos_null_fix: 'ATIVO (sales=0 → acos=null)',
        target_roas_derived: `100 / target_acos = ${(settings.target_roas || 0).toFixed(4)}x`,
        effective_target_acos_per_asin: 'ATIVO (min(account_target, break_even_asin))',
        max_bid_change_per_cycle: `±${CANONICAL_CONFIG.MAX_BID_CHANGE_PCT * 100}%`,
        data_freshness_max_hours: CANONICAL_CONFIG.DATA_FRESHNESS_MAX_HOURS,
        dayparting_guardrail: `ATIVO — slot atual: ${currentSlotClassification} (${currentDowBRT}/${currentHourBRT}h BRT)`,
        placement_guardrail: `ATIVO — limites: ToS ${settings.top_of_search_limit}%, RoS ${settings.rest_of_search_limit}%, PP ${settings.product_page_limit}%`,
        immediate_budget_rescue: 'ATIVO — ≥95% utilization + ACoS≤target + ROAS≥target + cooldown 24h + confirmação Amazon',
      },
      note: 'Motor v8: hierarquia P0-P7 · weighted ACoS · target_roas derivado · effective_target_acos por ASIN · centralDestructiveActionGuard · winner_protection canônico · ±20% max bid · IMMEDIATE_BUDGET_RESCUE',
    });

  } catch (error: any) {
    console.error('[runDeterministicDecisionEngine-v8]', error.message);
    return Response.json({ ok: false, error: error.message, correlationId }, { status: 500 });
  }
});

// ── Helper buildDecision ──────────────────────────────────────────────────────
function buildDecision(aid: string, correlationId: string, params: any): any {
  const intentScore = params.search_intent?.purchase_intent_score || 0.5;
  const stockDays = params.stock_coverage_days;
  const isStockDecision = params.rule_key === 'stock_critical' || params.rule_key === 'stock_low' || params.rule_key === 'stock_zero';
  const stockFactor = isStockDecision
    ? 1.0
    : stockDays != null ? Math.min(1, (stockDays || 0) / 30) : 1.0;
  const priorityFactor = 1 - ((params.priority || 9) / 13);
  const riskFactor = { low: 0.9, medium: 0.7, high: 0.5 }[params.risk as string] || 0.7;
  const opportunityFactor = params.opportunity_score || (isStockDecision ? 1.0 : 0.5);

  const decision_priority_score = calcDecisionScore({
    opportunity: opportunityFactor,
    economic_impact: isStockDecision ? 1.0 : 0.8,
    confidence: 0.9,
    visibility_gap: params.visibility_score != null ? (1 - params.visibility_score) : 0.5,
    inventory: stockFactor,
    conversion: params.simulation?.expected_additional_orders > 0 ? 1.0 : intentScore,
    goal_alignment: riskFactor,
  });
  const executionPolicy = classifyExecutionPolicy({
    action: params.action,
    ruleKey: params.rule_key,
    urgencyReasonCode: params.urgency_reason_code,
    entityType: params.entity_type,
    entityId: params.entity_id,
    scheduledFor: params.scheduled_for,
    expectedLossIfDelayed: params.expected_loss_if_delayed,
  });

  return {
    ...params,
    ...executionPolicy,
    amazon_account_id: aid,
    correlation_id: correlationId,
    priority: params.priority || 9,
    decision_priority_score,
    final_confidence: params.opportunity_score || 0.80,
  };
}
