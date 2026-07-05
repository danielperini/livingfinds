/**
 * ruleEngine — Motor de regras locais sem IA
 *
 * Implementa GRUPO A (sem IA, sem API) e GRUPO C (regras automáticas).
 * Todos os cálculos determinísticos vivem aqui.
 *
 * Modos:
 *   calc_metrics     → ACoS, ROAS, TACoS, CPC, CTR, margem, break_even
 *   bid_rule         → calcular novo bid por regra (sem IA)
 *   budget_rule      → calcular budget sugerido por fórmula
 *   should_use_ai    → verificar se IA é necessária
 *   has_change       → detectar mudança relevante
 *   freshness_check  → verificar se dado está vencido
 *   check_duplicate  → verificar duplicidade de ação/campanha/keyword
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

// ── TTLs de freshness por tipo de dado (ms) ───────────────────────────────
const FRESHNESS_TTL = {
  campaigns:           6  * 3600000,   // 6h
  campaign_inserting:  15 * 60000,     // 15min
  metrics:             24 * 3600000,   // 24h
  inventory:           6  * 3600000,   // 6h
  prices:              12 * 3600000,   // 12h
  buy_box:             6  * 3600000,   // 6h
  suggested_keywords:  7  * 86400000,  // 7d
  suggested_bid:       24 * 3600000,   // 24h
  profiles:            30 * 86400000,  // 30d
  catalog:             24 * 3600000,   // 24h
  reports:             24 * 3600000,   // 24h
  ai_daily_summary:    24 * 3600000,   // 24h
};

// ── TTLs de cache de análise IA por tipo ──────────────────────────────────
const AI_CACHE_TTL = {
  keyword_relevance:   30 * 86400000,
  keyword_analysis:    14 * 86400000,
  campaign_strategy:   7  * 86400000,
  daily_summary:       24 * 3600000,
  decision_explanation: 7 * 86400000,
  risk_analysis:       3  * 86400000,
  search_term_intent:  30 * 86400000,
};

// ── Utilitários ───────────────────────────────────────────────────────────
function safeDiv(num, den, fallback = 0) {
  if (!den || den === 0 || !isFinite(den)) return fallback;
  const r = num / den;
  return isFinite(r) ? r : fallback;
}

function clamp(val, min, max) {
  return Math.min(Math.max(val, min), max);
}

function isFresh(lastSyncAt, ttlKey) {
  if (!lastSyncAt) return false;
  const ttl = FRESHNESS_TTL[ttlKey] || FRESHNESS_TTL.campaigns;
  return (Date.now() - new Date(lastSyncAt).getTime()) < ttl;
}

// ── Cálculo de métricas locais (GRUPO A) ─────────────────────────────────
function calcMetrics({ spend = 0, sales = 0, clicks = 0, impressions = 0, orders = 0,
  organic_sales = 0, price = 0, product_cost = 0, amazon_fees = 0, extra_cost = 0 }) {
  const total_sales = sales + organic_sales;
  const acos       = safeDiv(spend, sales) * 100;
  const roas       = safeDiv(sales, spend);
  const tacos      = safeDiv(spend, total_sales) * 100;
  const cpc        = safeDiv(spend, clicks);
  const ctr        = safeDiv(clicks, impressions) * 100;
  const cvr        = safeDiv(orders, clicks) * 100;

  // Margem e break-even
  const margin_per_unit   = price - product_cost - amazon_fees - extra_cost;
  const margin_pct        = safeDiv(margin_per_unit, price) * 100;
  const break_even_acos   = margin_pct;
  const max_spend_per_ord = price * (margin_pct / 100);
  const profit_after_ads  = (margin_per_unit * orders) - spend;

  return {
    acos:            Math.round(acos * 100) / 100,
    roas:            Math.round(roas * 100) / 100,
    tacos:           Math.round(tacos * 100) / 100,
    cpc:             Math.round(cpc * 100) / 100,
    ctr:             Math.round(ctr * 100) / 100,
    cvr:             Math.round(cvr * 100) / 100,
    margin_pct:      Math.round(margin_pct * 100) / 100,
    break_even_acos: Math.round(break_even_acos * 100) / 100,
    max_spend_per_order: Math.round(max_spend_per_ord * 100) / 100,
    profit_after_ads: Math.round(profit_after_ads * 100) / 100,
  };
}

// ── BidRuleEngine (GRUPO A + C) ──────────────────────────────────────────
function calcBid({
  current_bid, acos, target_acos, clicks = 0, orders = 0, spend = 0,
  impressions = 0, confidence = 0,
  min_bid = 0.10, max_bid = 5.0,
  max_increase_pct = 0.15, max_decrease_pct = 0.20,
  cooldown_ok = true,
}) {
  const MIN_CONFIDENCE = 0.60;
  const MIN_CLICKS     = 8;

  // Sem dados suficientes
  if (confidence < MIN_CONFIDENCE || clicks < MIN_CLICKS) {
    return { action: 'wait', reason: 'insufficient_data', bid: current_bid };
  }
  if (!cooldown_ok) {
    return { action: 'wait', reason: 'cooldown', bid: current_bid };
  }

  // Sem impressões → leve boost
  if (impressions === 0) {
    const new_bid = clamp(current_bid + 0.10, min_bid, Math.min(1.20, max_bid));
    return { action: 'increase', reason: 'no_impressions', bid: Math.round(new_bid * 100) / 100 };
  }

  // ACoS OK → manter ou escalar se winner
  if (acos > 0 && acos <= target_acos && orders >= 2) {
    const increase = clamp(current_bid * max_increase_pct * 0.5, 0, current_bid * max_increase_pct);
    const new_bid = clamp(current_bid + increase, min_bid, max_bid);
    return { action: 'increase', reason: 'winner', bid: Math.round(new_bid * 100) / 100 };
  }

  // HIGH ACoS → fórmula proporcional
  if (acos > target_acos && orders >= 1) {
    const proposed = current_bid * (target_acos / acos);
    const min_allowed = current_bid * (1 - max_decrease_pct);
    const new_bid = clamp(Math.max(proposed, min_allowed), min_bid, max_bid);
    const change_pct = (new_bid / current_bid - 1) * 100;
    if (change_pct < -5) {
      return { action: 'decrease', reason: 'high_acos', bid: Math.round(new_bid * 100) / 100 };
    }
  }

  // Wasting → reduzir
  if (orders === 0 && clicks >= MIN_CLICKS && spend >= 5) {
    const new_bid = clamp(current_bid * (1 - max_decrease_pct * 0.75), min_bid, max_bid);
    return { action: 'decrease', reason: 'wasting', bid: Math.round(new_bid * 100) / 100 };
  }

  return { action: 'no_action', reason: 'ok', bid: current_bid };
}

// ── BudgetRuleEngine (GRUPO A + C) ───────────────────────────────────────
function calcBudget({
  total_daily_budget = 0, active_campaign_count = 1,
  average_daily_spend = 0, current_campaign_budget = 0,
  is_new_campaign = false, minimum_budget = 5,
  maximum_budget = 200, safety_margin_pct = 0.10,
}) {
  if (total_daily_budget <= 0 && average_daily_spend <= 0) {
    return { suggested: current_campaign_budget || minimum_budget, reason: 'no_data' };
  }

  // Base: média de gasto diário + reserva
  const base = average_daily_spend > 0
    ? average_daily_spend * (1 + safety_margin_pct)
    : safeDiv(total_daily_budget, Math.max(active_campaign_count, 1));

  // Nova campanha: +30%
  const adjusted = is_new_campaign ? base * 1.30 : base;

  const suggested = clamp(adjusted, minimum_budget, maximum_budget);
  return {
    suggested: Math.round(suggested * 100) / 100,
    reason: is_new_campaign ? 'new_campaign_boost' : 'avg_spend_based',
    base_spend: Math.round(average_daily_spend * 100) / 100,
  };
}

// ── shouldUseAI (controle de acesso à IA) ────────────────────────────────
function shouldUseAI({
  has_sufficient_data = false,
  no_deterministic_rule = false,
  no_recent_cache = true,
  has_relevant_impact = false,
  low_rule_confidence = false,
  not_recently_analyzed = true,
  within_daily_budget = true,
  not_simple_calculation = true,
  not_duplicate = true,
  no_pending_action = true,
  no_inserting_campaign = true,
  no_valid_prior_decision = true,
}) {
  const conditions = {
    has_sufficient_data,
    no_deterministic_rule,
    no_recent_cache,
    has_relevant_impact,
    low_rule_confidence,
    not_recently_analyzed,
    within_daily_budget,
    not_simple_calculation,
    not_duplicate,
    no_pending_action,
    no_inserting_campaign,
    no_valid_prior_decision,
  };

  const failed = Object.entries(conditions).filter(([, v]) => !v).map(([k]) => k);
  return { use_ai: failed.length === 0, failed_conditions: failed };
}

// ── hasMeaningfulChange ───────────────────────────────────────────────────
function hasMeaningfulChange(before = {}, after = {}) {
  const changes = [];

  const pctChange = (a, b) => a > 0 ? Math.abs((b - a) / a) * 100 : (b > 0 ? 100 : 0);

  if (pctChange(before.spend, after.spend) > 20)    changes.push('spend');
  if (pctChange(before.sales, after.sales) > 20)    changes.push('sales');
  if (pctChange(before.acos, after.acos) > 15)      changes.push('acos');
  if (pctChange(before.roas, after.roas) > 15)      changes.push('roas');
  if (before.state !== after.state)                  changes.push('campaign_state');
  if (before.daily_budget !== after.daily_budget)    changes.push('budget');
  if (before.current_bid !== after.current_bid)      changes.push('bid');
  if (before.buy_box_status !== after.buy_box_status) changes.push('buy_box');
  if (before.inventory_status !== after.inventory_status) changes.push('inventory');
  if (!before.orders && after.orders > 0)            changes.push('first_order');
  if (after.profit_after_ads !== undefined && after.profit_after_ads < 0 && (before.profit_after_ads || 0) >= 0) {
    changes.push('margin_negative');
  }

  return { has_change: changes.length > 0, changed_fields: changes };
}

// ── HANDLER PRINCIPAL ─────────────────────────────────────────────────────
Deno.serve(async (req) => {
  try {
    const body = await req.json().catch(() => ({}));
    const { mode } = body;

    if (mode === 'calc_metrics') {
      return Response.json({ ok: true, metrics: calcMetrics(body) });
    }

    if (mode === 'bid_rule') {
      return Response.json({ ok: true, result: calcBid(body) });
    }

    if (mode === 'budget_rule') {
      return Response.json({ ok: true, result: calcBudget(body) });
    }

    if (mode === 'should_use_ai') {
      return Response.json({ ok: true, result: shouldUseAI(body) });
    }

    if (mode === 'has_change') {
      const { before = {}, after = {} } = body;
      return Response.json({ ok: true, result: hasMeaningfulChange(before, after) });
    }

    if (mode === 'freshness_check') {
      const { last_sync_at, data_type } = body;
      return Response.json({ ok: true, fresh: isFresh(last_sync_at, data_type), ttl_ms: FRESHNESS_TTL[data_type] || null });
    }

    if (mode === 'ai_cache_ttl') {
      const { analysis_type } = body;
      return Response.json({ ok: true, ttl_ms: AI_CACHE_TTL[analysis_type] || null });
    }

    if (mode === 'ping') {
      return Response.json({ ok: true, engine: 'RuleEngine v1', modes: ['calc_metrics', 'bid_rule', 'budget_rule', 'should_use_ai', 'has_change', 'freshness_check', 'ai_cache_ttl'] });
    }

    return Response.json({ ok: false, error: `Modo desconhecido: ${mode}` }, { status: 400 });

  } catch (err) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
});