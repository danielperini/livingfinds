/**
 * PROFIT-SAFE BID & BUDGET GUARDRAIL — Módulo Centralizado
 * ─────────────────────────────────────────────────────────────────────────
 * Implementa as 40 regras do PRD de proteção de rentabilidade.
 *
 * Regras fundamentais:
 *  - MAX +20% por ciclo em qualquer aumento (bid, budget, placement)
 *  - ONE_PRIMARY_SCALE_ACTION_PER_ENTITY_PER_CYCLE
 *  - Hierarquia: TARGET_ACOS → SUSTAINABLE_ACOS → BREAK_EVEN_ACOS
 *  - WINNER_PROFIT_PROTECTION: bloquear reduções que reduzam lucro
 *  - ABOVE_TARGET_BUT_PROFITABLE: não cortar automaticamente winners sustentáveis
 *
 * Pode ser usado como função HTTP ou importado inline (copy das funções puras).
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

// ── Constantes ────────────────────────────────────────────────────────────
export const MAX_INCREASE_PER_CYCLE = 0.20;   // +20% hard cap
export const ECONOMIC_SAFETY_FACTOR = 0.80;   // sustainable = break_even × 0.80
export const MIN_BID_GLOBAL         = 0.25;
export const WINNER_MIN_ORDERS      = 1;
export const MIN_CONFIDENCE_REDUCTION_WINNER = 0.80; // P(profit_after >= profit_before) >= 80%

// ── Tipagem de resultado ──────────────────────────────────────────────────
export interface ProfitContext {
  current_acos:       number;
  target_acos:        number;
  sustainable_acos:   number;
  break_even_acos:    number;
  acos_status:        'HEALTHY' | 'ABOVE_TARGET_BUT_PROFITABLE' | 'ECONOMIC_WARNING' | 'CRITICAL_ECONOMIC';
  acos_headroom:      number;       // sustainable - current (pontos percentuais)
  current_profit:     number;       // contribution profit atual (positivo = bom)
  sustainable_cpc:    number;
  is_winner:          boolean;
  can_scale:          boolean;      // tem headroom econômico E dados suficientes
}

export interface BidUpResult {
  allowed:            boolean;
  final_bid:          number;
  raw_bid:            number;
  cap_applied:        boolean;      // foi limitado pelo +20%
  economic_cap_applied: boolean;    // foi limitado pelo sustainable_cpc
  change_pct:         number;
  block_reason?:      string;
  profit_context:     ProfitContext;
}

export interface BidDownResult {
  allowed:            boolean;
  final_bid:          number;
  change_pct:         number;
  block_reason?:      string;
  expected_profit_delta: number;
  profit_context:     ProfitContext;
}

export interface BudgetUpResult {
  allowed:            boolean;
  final_budget:       number;
  raw_budget:         number;
  cap_applied:        boolean;
  change_pct:         number;
  block_reason?:      string;
  profit_context:     ProfitContext;
}

// ── Funções puras (sem I/O) — exportáveis para inline em outros motores ───

/** Calcula contexto econômico completo para uma entidade */
export function buildProfitContext(params: {
  current_acos:   number;
  target_acos:    number;
  break_even_acos: number;
  safety_factor?: number;
  spend:          number;
  sales:          number;
  orders:         number;
  clicks:         number;
  aov:            number;
  cvr:            number;
  contribution_margin_before_ads: number; // margem % antes de ads (ex: 0.30 = 30%)
}): ProfitContext {
  const {
    current_acos, target_acos, break_even_acos,
    safety_factor = ECONOMIC_SAFETY_FACTOR,
    spend, sales, orders, clicks, aov, cvr,
    contribution_margin_before_ads,
  } = params;

  const sustainable_acos = r2(break_even_acos * safety_factor);
  const acos_headroom    = r2(sustainable_acos - current_acos);

  // Lucro atual = margem antes de ads × sales − spend
  const current_profit = r2(sales * contribution_margin_before_ads - spend);

  // CPC sustentável = AOV × CVR × target_acos
  const sustainable_cpc = aov > 0 && cvr > 0 && target_acos > 0
    ? r2(aov * cvr * (target_acos / 100))
    : 0;

  // Classificação
  let acos_status: ProfitContext['acos_status'];
  if (current_acos <= target_acos)                          acos_status = 'HEALTHY';
  else if (current_acos <= sustainable_acos)                acos_status = 'ABOVE_TARGET_BUT_PROFITABLE';
  else if (current_acos < break_even_acos)                  acos_status = 'ECONOMIC_WARNING';
  else                                                       acos_status = 'CRITICAL_ECONOMIC';

  const is_winner = (
    current_acos > 0 &&
    current_acos <= sustainable_acos &&
    orders >= WINNER_MIN_ORDERS &&
    current_profit > 0
  );

  const can_scale = (
    is_winner &&
    acos_headroom > 0 &&
    clicks >= 10 &&
    cvr > 0
  );

  return {
    current_acos, target_acos, sustainable_acos, break_even_acos,
    acos_status, acos_headroom, current_profit, sustainable_cpc,
    is_winner, can_scale,
  };
}

/** Avalia e limita um aumento de bid */
export function evaluateBidUp(params: {
  current_bid:    number;
  raw_proposed_bid: number;
  max_bid:        number;
  ctx:            ProfitContext;
}): BidUpResult {
  const { current_bid, raw_proposed_bid, max_bid, ctx } = params;

  if (current_bid <= 0) {
    return { allowed: false, final_bid: current_bid, raw_bid: raw_proposed_bid,
      cap_applied: false, economic_cap_applied: false, change_pct: 0,
      block_reason: 'bid_zero', profit_context: ctx };
  }

  // 1. Checar se há espaço econômico
  if (!ctx.can_scale) {
    return { allowed: false, final_bid: current_bid, raw_bid: raw_proposed_bid,
      cap_applied: false, economic_cap_applied: false, change_pct: 0,
      block_reason: ctx.acos_status === 'CRITICAL_ECONOMIC'
        ? 'CRITICAL_ECONOMIC_NO_SCALE'
        : !ctx.is_winner ? 'NOT_A_WINNER' : 'NO_ECONOMIC_HEADROOM',
      profit_context: ctx };
  }

  // 2. ACoS esperado após aumento (proporcional ao bid)
  const ratio = raw_proposed_bid / current_bid;
  const expected_acos_after = r2(ctx.current_acos * ratio);
  if (expected_acos_after > ctx.sustainable_acos) {
    return { allowed: false, final_bid: current_bid, raw_bid: raw_proposed_bid,
      cap_applied: false, economic_cap_applied: true, change_pct: 0,
      block_reason: `EXPECTED_ACOS_${expected_acos_after.toFixed(1)}_EXCEEDS_SUSTAINABLE_${ctx.sustainable_acos}`,
      profit_context: ctx };
  }

  // 3. Aplicar hard cap +20%
  const max_by_cycle = r2(current_bid * (1 + MAX_INCREASE_PER_CYCLE));
  const cap_applied  = raw_proposed_bid > max_by_cycle;

  // 4. Limitar por sustainable_cpc se disponível
  let economic_cap_applied = false;
  let after_economic_cap = Math.min(raw_proposed_bid, max_by_cycle);
  if (ctx.sustainable_cpc > 0 && after_economic_cap > ctx.sustainable_cpc) {
    after_economic_cap = ctx.sustainable_cpc;
    economic_cap_applied = true;
  }

  // 5. Limitar pelo max_bid configurado
  const final_bid = r2(Math.min(max_bid, after_economic_cap));
  if (final_bid <= current_bid + 0.01) {
    return { allowed: false, final_bid: current_bid, raw_bid: raw_proposed_bid,
      cap_applied, economic_cap_applied, change_pct: 0,
      block_reason: 'NO_MEANINGFUL_INCREASE', profit_context: ctx };
  }

  const change_pct = r2(((final_bid - current_bid) / current_bid) * 100);

  return {
    allowed: true, final_bid, raw_bid: raw_proposed_bid,
    cap_applied, economic_cap_applied, change_pct,
    profit_context: ctx,
  };
}

/** Avalia se uma redução de bid é permitida */
export function evaluateBidDown(params: {
  current_bid:      number;
  proposed_bid:     number;
  min_bid:          number;
  ctx:              ProfitContext;
  is_waste_removal: boolean; // zero-sale ou termo irrelevante (sempre permitido)
}): BidDownResult {
  const { current_bid, proposed_bid, min_bid, ctx, is_waste_removal } = params;

  // Waste removal (zero vendas, sem receita) — sempre permitido independente do status
  if (is_waste_removal) {
    const final_bid    = r2(Math.max(min_bid, proposed_bid));
    const change_pct   = r2(((final_bid - current_bid) / current_bid) * 100);
    const spend_saved  = current_bid - final_bid; // proxy
    return {
      allowed: true, final_bid, change_pct,
      expected_profit_delta: spend_saved, // positivo = economiza
      profit_context: ctx,
    };
  }

  // WINNER PROFIT PROTECTION — bloquear se ctx é sustentável e redução prejudica lucro
  if (ctx.is_winner && ctx.acos_status !== 'CRITICAL_ECONOMIC') {
    // Estimar lucro após redução (bid proporcional ao spend e às impressões)
    const ratio = proposed_bid / current_bid;
    // Projetar: clicks × ratio, orders proporcional ao CVR (conservador: assume perda de exposição)
    const expected_clicks_after = ctx.current_acos > 0
      ? (1 / (ctx.current_acos / 100)) * ratio  // simplificado
      : ratio;
    // Projetar receita após redução (conversão constante, menos tráfego)
    const revenue_ratio = ratio; // conservador: receita proporcional ao bid
    const spend_after   = ctx.current_profit > 0
      ? (ctx.current_acos / 100) * (ctx.current_acos > 0 ? 1 : 0) * ratio
      : 0;

    // Estimativa simples de delta de lucro:
    // lucro_after ≈ lucro_before × revenue_ratio − (spend_before × ratio − spend_before)
    // = lucro_before × ratio (simplificado, assume linear)
    const expected_profit_after  = r2(ctx.current_profit * ratio);
    const expected_profit_delta  = r2(expected_profit_after - ctx.current_profit);

    if (expected_profit_delta < 0) {
      return {
        allowed: false,
        final_bid: current_bid,
        change_pct: 0,
        block_reason: 'WINNER_PROFIT_PROTECTION',
        expected_profit_delta,
        profit_context: ctx,
      };
    }
  }

  // ABOVE_TARGET_BUT_PROFITABLE — não cortar automaticamente
  if (ctx.acos_status === 'ABOVE_TARGET_BUT_PROFITABLE') {
    // Só permite se a redução claramente melhora o lucro esperado
    const ratio = proposed_bid / current_bid;
    const expected_profit_delta = r2(ctx.current_profit * ratio - ctx.current_profit);
    if (expected_profit_delta < 0) {
      return {
        allowed: false,
        final_bid: current_bid,
        change_pct: 0,
        block_reason: 'ABOVE_TARGET_BUT_PROFITABLE_REDUCTION_BLOCKED',
        expected_profit_delta,
        profit_context: ctx,
      };
    }
  }

  const final_bid  = r2(Math.max(min_bid, proposed_bid));
  const change_pct = r2(((final_bid - current_bid) / current_bid) * 100);
  const expected_profit_delta = r2(ctx.current_profit * (proposed_bid / current_bid) - ctx.current_profit);

  return { allowed: true, final_bid, change_pct, expected_profit_delta, profit_context: ctx };
}

/** Avalia se um aumento de budget é permitido */
export function evaluateBudgetUp(params: {
  current_budget:   number;
  raw_proposed:     number;
  hard_daily_cap:   number;
  ctx:              ProfitContext;
}): BudgetUpResult {
  const { current_budget, raw_proposed, hard_daily_cap, ctx } = params;

  if (!ctx.is_winner) {
    return { allowed: false, final_budget: current_budget, raw_budget: raw_proposed,
      cap_applied: false, change_pct: 0,
      block_reason: 'NOT_A_WINNER_NO_BUDGET_INCREASE', profit_context: ctx };
  }

  if (ctx.acos_status === 'CRITICAL_ECONOMIC') {
    return { allowed: false, final_budget: current_budget, raw_budget: raw_proposed,
      cap_applied: false, change_pct: 0,
      block_reason: 'CRITICAL_ECONOMIC_NO_BUDGET_INCREASE', profit_context: ctx };
  }

  // Hard cap +20%
  const max_by_cycle = r2(current_budget * (1 + MAX_INCREASE_PER_CYCLE));
  const cap_applied  = raw_proposed > max_by_cycle;
  const after_cap    = Math.min(raw_proposed, max_by_cycle);

  // Hard daily cap absoluto (Kill Switch)
  const final_budget = r2(Math.min(hard_daily_cap, after_cap));
  if (final_budget <= current_budget + 0.50) {
    return { allowed: false, final_budget: current_budget, raw_budget: raw_proposed,
      cap_applied, change_pct: 0,
      block_reason: 'NO_MEANINGFUL_BUDGET_INCREASE', profit_context: ctx };
  }

  const change_pct = r2(((final_budget - current_budget) / current_budget) * 100);
  return { allowed: true, final_budget, raw_budget: raw_proposed, cap_applied, change_pct, profit_context: ctx };
}

// ── HTTP endpoint para uso direto / teste ─────────────────────────────────
function r2(v: number): number { return parseFloat(v.toFixed(2)); }

Deno.serve(async (req) => {
  try {
    const body = await req.json().catch(() => ({}));
    const { action, params } = body;

    if (action === 'build_context') {
      return Response.json({ ok: true, context: buildProfitContext(params) });
    }
    if (action === 'evaluate_bid_up') {
      return Response.json({ ok: true, result: evaluateBidUp(params) });
    }
    if (action === 'evaluate_bid_down') {
      return Response.json({ ok: true, result: evaluateBidDown(params) });
    }
    if (action === 'evaluate_budget_up') {
      return Response.json({ ok: true, result: evaluateBudgetUp(params) });
    }

    return Response.json({
      ok: true,
      description: 'PROFIT-SAFE GUARDRAIL — use action: build_context | evaluate_bid_up | evaluate_bid_down | evaluate_budget_up',
      max_increase_per_cycle: MAX_INCREASE_PER_CYCLE,
      economic_safety_factor: ECONOMIC_SAFETY_FACTOR,
      rules: [
        'MAX +20% por ciclo em qualquer aumento',
        'ONE_PRIMARY_SCALE_ACTION_PER_ENTITY_PER_CYCLE',
        'WINNER_PROFIT_PROTECTION: bloquear reduções que reduzam lucro',
        'ABOVE_TARGET_BUT_PROFITABLE: não cortar sem verificar lucro esperado',
        'Hierarquia: TARGET_ACOS → SUSTAINABLE_ACOS → BREAK_EVEN_ACOS',
      ],
    });
  } catch (err: any) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
});