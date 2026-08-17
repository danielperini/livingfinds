/**
 * calculateDecisionConfidence
 *
 * Calcula confidence score composto (0-100) para uma decisão Amazon Ads.
 * NÃO usa IA. Puro cálculo determinístico baseado em evidências numéricas.
 *
 * Fórmula:
 *   confidence =
 *     data_quality_score    × 0.20
 *     + sample_size_score   × 0.15
 *     + metric_strength     × 0.15
 *     + consistency_score   × 0.15
 *     + recency_score       × 0.10
 *     + rule_match_score    × 0.10
 *     + prior_outcome_score × 0.10
 *     + goal_alignment      × 0.05
 *     - risk_penalty
 *
 * Ação automática: confidence >= 90
 * Sugestão:        confidence >= 70
 * Abaixo de 70:    não agir
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function safe(v: unknown): number {
  const n = Number(v);
  return isNaN(n) || !isFinite(n) ? 0 : n;
}

function clamp(v: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, v));
}

// sample_size_score: logarítmica baseada em cliques e pedidos
function sampleSizeScore(clicks: number, orders: number, impressions: number): number {
  const sampleBase = Math.max(clicks + orders * 5, 1);
  const s = Math.min(1, Math.log10(sampleBase + 1) / Math.log10(51));
  // Bônus de impressões
  const impBonus = impressions >= 1000 ? 0.05 : impressions >= 500 ? 0.03 : impressions >= 100 ? 0.01 : 0;
  return clamp((s + impBonus) * 100);
}

// metric_strength_score: quão fortemente a métrica sinaliza a decisão
function metricStrengthScore(params: {
  acos: number; target_acos: number; max_acos: number;
  roas: number; target_roas: number;
  cpc: number; max_cpc: number;
  orders: number; clicks: number; spend: number; sales: number;
  decision_type: string;
}): number {
  const { acos, target_acos, max_acos, roas, target_roas, cpc, max_cpc, orders, clicks, spend, sales, decision_type } = params;

  if (decision_type === 'bid_decrease' || decision_type === 'reduce_bid') {
    // Sinal forte de redução: ACoS muito acima do alvo com dados suficientes
    if (acos > 0 && target_acos > 0) {
      const excess = (acos - target_acos) / target_acos; // quanto acima, em %
      if (excess > 0.5 && orders >= 1) return clamp(70 + excess * 20);
      if (excess > 0.2 && clicks >= 5) return clamp(55 + excess * 30);
      if (orders === 0 && clicks >= 10 && spend >= 5) return 65; // wasting
    }
    return 40;
  }

  if (decision_type === 'bid_increase' || decision_type === 'increase_bid') {
    // Sinal forte de aumento: ACoS bem abaixo do alvo com vendas
    if (acos > 0 && target_acos > 0 && orders >= 1) {
      const headroom = (target_acos - acos) / target_acos;
      if (headroom > 0.3 && orders >= 3) return clamp(75 + headroom * 20);
      if (headroom > 0.1 && orders >= 1) return clamp(60 + headroom * 30);
    }
    return 35;
  }

  if (decision_type === 'daypart_bid_decrease') {
    // Bloco de horário com gasto e zero venda
    if (orders === 0 && spend >= 2) return 70;
    if (orders === 0 && clicks >= 5) return 60;
    return 40;
  }

  if (decision_type === 'daypart_bid_increase') {
    // Bloco de horário com venda e ACoS na meta
    if (orders >= 1 && acos > 0 && acos <= target_acos * 1.1) return 80;
    if (orders >= 1 && roas >= target_roas) return 75;
    return 45;
  }

  if (decision_type === 'negative_keyword') {
    if (orders === 0 && clicks >= 20 && spend >= 10) return 80;
    if (orders === 0 && clicks >= 10 && spend >= 5) return 65;
    return 40;
  }

  return 50; // default
}

// consistency_score: baseado em maturidade e número de avaliações anteriores
function consistencyScore(maturity: string, eval_count: number, prior_outcome_count: number): number {
  const maturityScores: Record<string, number> = {
    MATURE: 80, LEARNING: 50, NEW: 20, STALE: 0, INSUFFICIENT_DATA: 15,
  };
  const base = maturityScores[maturity] ?? 40;
  // Bônus de avaliações anteriores
  const evalBonus = Math.min(15, eval_count * 3);
  // Bônus de outcomes registrados
  const outcomeBonus = Math.min(10, prior_outcome_count * 2);
  return clamp(base + evalBonus + outcomeBonus);
}

// recency_score: quão recentes são os dados
function recencyScore(freshness_hours: number, last_action_days_ago: number): number {
  let fresh: number;
  if (freshness_hours <= 24) fresh = 100;
  else if (freshness_hours <= 48) fresh = 70;
  else if (freshness_hours <= 72) fresh = 40;
  else fresh = 0;

  // Cooldown: decisão recente reduz a urgência
  const cooldownPenalty = last_action_days_ago < 1 ? 30 : last_action_days_ago < 3 ? 10 : 0;
  return clamp(fresh - cooldownPenalty);
}

// rule_match_score: quantas condições da regra foram satisfeitas com força
function ruleMatchScore(conditions_met: number, conditions_total: number, min_evidence_met: boolean): number {
  if (conditions_total === 0) return 50;
  const base = (conditions_met / conditions_total) * 80;
  const bonus = min_evidence_met ? 20 : 0;
  return clamp(base + bonus);
}

// prior_outcome_score: histórico de sucesso de decisões similares
function priorOutcomeScore(success_count: number, failure_count: number, total_count: number): number {
  if (total_count === 0) return 50; // neutro sem histórico
  const rate = success_count / total_count;
  // Bônus por volume de histórico
  const volumeBonus = Math.min(10, total_count);
  return clamp(rate * 90 + volumeBonus);
}

// goal_alignment_score: o quão alinhada a decisão está com o objetivo configurado
function goalAlignmentScore(decision_type: string, objective: string, primary_goal: string): number {
  const alignMap: Record<string, Record<string, number>> = {
    profitability: { reduce_bid: 90, bid_decrease: 90, negative_keyword: 85, bid_increase: 60, budget_increase: 55 },
    growth: { bid_increase: 90, increase_bid: 90, budget_increase: 85, reduce_bid: 60, bid_decrease: 60 },
    launch: { bid_increase: 95, increase_bid: 95, budget_increase: 80, reduce_bid: 40 },
    defense: { bid_increase: 80, budget_increase: 75, reduce_bid: 50 },
    liquidation: { reduce_bid: 80, negative_keyword: 75, bid_increase: 40 },
    maintenance: { bid_increase: 70, reduce_bid: 70, budget_increase: 65 },
  };
  const obj = (objective || 'profitability').toLowerCase();
  const dt = (decision_type || '').toLowerCase();
  return alignMap[obj]?.[dt] ?? 60;
}

// risk_penalty: reduz confidence baseado no risco da decisão
function riskPenalty(risk: string, has_historical_sales: boolean, is_high_spend: boolean): number {
  let penalty = 0;
  if (risk === 'very_high') penalty += 25;
  else if (risk === 'high') penalty += 15;
  else if (risk === 'medium') penalty += 7;
  else penalty += 0; // low

  if (has_historical_sales && ['negative_keyword', 'pause'].includes(risk)) penalty += 10;
  if (is_high_spend) penalty += 5;
  return clamp(penalty, 0, 40);
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    if (!body._service_role) {
      const auth = await base44.auth.isAuthenticated().catch(() => false);
      if (!auth) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    // ── Parâmetros de entrada ─────────────────────────────────────────────
    const {
      amazon_account_id,
      decision_type = 'bid_change',
      // Métricas da entidade
      clicks = 0, orders = 0, impressions = 0, spend = 0, sales = 0,
      acos = 0, roas = 0, cpc = 0,
      // Metas
      target_acos = 25, max_acos = 40, target_roas = 4, max_cpc = 0,
      // Qualidade de dados
      data_quality_score = 50,
      freshness_hours = 48,
      maturity = 'LEARNING',
      eval_count = 0,
      prior_outcome_count = 0,
      // Histórico de sucesso da regra
      success_count = 0, failure_count = 0, total_prior = 0,
      // Regra
      conditions_met = 1, conditions_total = 1, min_evidence_met = false,
      // Contexto
      objective = 'profitability',
      primary_goal = 'acos',
      risk = 'low',
      has_historical_sales = false,
      is_high_spend = false,
      last_action_days_ago = 999,
    } = body;

    // ── Calcular componentes ──────────────────────────────────────────────
    const sample = sampleSizeScore(safe(clicks), safe(orders), safe(impressions));
    const metricStr = metricStrengthScore({
      acos: safe(acos), target_acos: safe(target_acos), max_acos: safe(max_acos),
      roas: safe(roas), target_roas: safe(target_roas),
      cpc: safe(cpc), max_cpc: safe(max_cpc),
      orders: safe(orders), clicks: safe(clicks), spend: safe(spend), sales: safe(sales),
      decision_type,
    });
    const consistency = consistencyScore(maturity, safe(eval_count), safe(prior_outcome_count));
    const recency = recencyScore(safe(freshness_hours), safe(last_action_days_ago));
    const ruleMatch = ruleMatchScore(safe(conditions_met), safe(conditions_total), !!min_evidence_met);
    const priorOutcome = priorOutcomeScore(safe(success_count), safe(failure_count), safe(total_prior));
    const goalAlign = goalAlignmentScore(decision_type, objective, primary_goal);
    const penalty = riskPenalty(risk, !!has_historical_sales, !!is_high_spend);

    // ── Fórmula composta ─────────────────────────────────────────────────
    const raw =
      safe(data_quality_score) * 0.20
      + sample               * 0.15
      + metricStr            * 0.15
      + consistency          * 0.15
      + recency              * 0.10
      + ruleMatch            * 0.10
      + priorOutcome         * 0.10
      + goalAlign            * 0.05
      - penalty;

    const confidence = Math.round(clamp(raw));

    // ── Interpretação ─────────────────────────────────────────────────────
    const can_auto_execute = confidence >= 90;
    const can_suggest = confidence >= 70;
    const action_class =
      confidence >= 90 ? 'EXECUTE_NOW' :
      confidence >= 70 ? 'RECOMMEND_APPROVAL' :
      confidence >= 50 ? 'WAIT_FOR_DATA' : 'BLOCK';

    return Response.json({
      ok: true,
      confidence,
      action_class,
      can_auto_execute,
      can_suggest,
      components: {
        data_quality:   Math.round(safe(data_quality_score) * 0.20),
        sample_size:    Math.round(sample * 0.15),
        metric_strength: Math.round(metricStr * 0.15),
        consistency:    Math.round(consistency * 0.15),
        recency:        Math.round(recency * 0.10),
        rule_match:     Math.round(ruleMatch * 0.10),
        prior_outcome:  Math.round(priorOutcome * 0.10),
        goal_alignment: Math.round(goalAlign * 0.05),
        risk_penalty:   -Math.round(penalty),
      },
      raw_scores: { sample, metricStr, consistency, recency, ruleMatch, priorOutcome, goalAlign, penalty },
    });

  } catch (error) {
    return Response.json({ ok: false, error: (error as Error).message }, { status: 500 });
  }
});