/**
 * runDeterministicDecisionEngine — Módulo B: Motor Determinístico Diário
 *
 * REGRA ABSOLUTA: Este módulo NÃO chama Claude, nenhum LLM, nenhuma IA.
 * Carrega regras vigentes do banco e executa decisões puramente calculadas.
 *
 * Guardrails financeiros protegidos (codificados — não vêm do banco):
 *   Budget total automático: R$50–R$65
 *   Bid mínimo: R$0.10 | Bid máximo: R$5.00
 *   Toda ação passa pela fila com idempotency_key
 *
 * v2: Integra contexto sazonal (SeasonalityDecisionContext) em toda decisão.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const MIN_TOTAL_DAILY_BUDGET = 50;
const TARGET_TOTAL_DAILY_BUDGET = 60;
const MAX_TOTAL_DAILY_BUDGET = 65;
const MIN_BID = 0.10;
const MAX_BID = 5.0;
const MAX_BID_CHANGE_PCT = 0.30;

const CONFLICT_PRIORITY = {
  financial_safety: 1, stock: 2, profit: 3, budget_limit: 4,
  protected_rules: 5, dedup: 6, pause_loss: 7, reduce_bid: 8,
  maintenance: 9, increase_bid: 10, expansion: 11, campaign_creation: 12,
};

function uuid() { return `${Date.now()}-${Math.random().toString(36).slice(2)}`; }

function evaluateCondition(cond, entity) {
  const val = entity[cond.metric] ?? 0;
  switch (cond.operator) {
    case 'equals': return val === cond.value;
    case 'not_equals': return val !== cond.value;
    case 'greater_than': return val > cond.value;
    case 'greater_than_or_equal': return val >= cond.value;
    case 'less_than': return val < cond.value;
    case 'less_than_or_equal': return val <= cond.value;
    case 'between': return val >= cond.value[0] && val <= cond.value[1];
    case 'in': return Array.isArray(cond.value) && cond.value.includes(val);
    case 'not_in': return Array.isArray(cond.value) && !cond.value.includes(val);
    case 'days_since': {
      if (!entity[cond.metric]) return false;
      const ageDays = (Date.now() - new Date(entity[cond.metric]).getTime()) / 86400000;
      return ageDays >= (cond.value || 0);
    }
    default: return false;
  }
}

function entityMatchesRule(rule, entity) {
  return (rule.conditions || []).every(cond => evaluateCondition(cond, entity));
}

function calculateActionValue(rule, entity) {
  const action = rule.action;
  const currentBid = entity.current_bid || entity.bid || 0.25;

  switch (action.type) {
    case 'increase_bid_percent': {
      const pct = Math.min(action.value / 100, MAX_BID_CHANGE_PCT);
      return Math.min(currentBid * (1 + pct), MAX_BID);
    }
    case 'decrease_bid_percent': {
      const pct = Math.min(action.value / 100, MAX_BID_CHANGE_PCT);
      return Math.max(currentBid * (1 - pct), MIN_BID);
    }
    case 'set_bid':
      return Math.min(Math.max(action.value, MIN_BID), MAX_BID);
    default:
      return action.value;
  }
}

function resolveRuleConflicts(ruleA, ruleB) {
  const typeA = ruleA.action?.type || '';
  const typeB = ruleB.action?.type || '';
  const categoryOf = (t) => {
    if (['pause_campaign', 'pause_keyword'].includes(t)) return 'pause_loss';
    if (['decrease_bid_percent', 'set_bid'].includes(t)) return 'reduce_bid';
    if (['increase_bid_percent'].includes(t)) return 'increase_bid';
    if (['create_exact_keyword', 'create_phrase_keyword', 'create_broad_keyword', 'create_campaign'].includes(t)) return 'expansion';
    return 'maintenance';
  };
  const prioA = CONFLICT_PRIORITY[categoryOf(typeA)] || 99;
  const prioB = CONFLICT_PRIORITY[categoryOf(typeB)] || 99;
  return prioA <= prioB ? { execute: ruleA, skip: ruleB } : { execute: ruleB, skip: ruleA };
}

// ── Sazonalidade inline ───────────────────────────────────────────────────────

function getBrazilEventsForYear(year) {
  function lastFridayNov(y) {
    const d = new Date(y, 11, 0);
    while (d.getDay() !== 5) d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  }
  function secondSunday(y, month) {
    const d = new Date(y, month - 1, 1);
    let s = 0;
    while (s < 2) { if (d.getDay() === 0) s++; if (s < 2) d.setDate(d.getDate() + 1); }
    return d.toISOString().slice(0, 10);
  }
  const bf = lastFridayNov(year);
  const cm = new Date(bf); cm.setDate(cm.getDate() + 3);
  return [
    { name: 'Ano Novo', type: 'holiday', date: `${year}-01-01`, pre: 3, post: 2, demand: 'moderate_peak', cpc: 'low' },
    { name: 'Tiradentes', type: 'holiday', date: `${year}-04-21`, pre: 1, post: 1, demand: 'low_demand', cpc: 'none' },
    { name: 'Dia do Trabalho', type: 'holiday', date: `${year}-05-01`, pre: 1, post: 1, demand: 'low_demand', cpc: 'none' },
    { name: 'Dia dos Namorados', type: 'valentines_day', date: `${year}-06-12`, pre: 14, post: 2, demand: 'moderate_peak', cpc: 'moderate' },
    { name: 'Independência', type: 'holiday', date: `${year}-09-07`, pre: 1, post: 1, demand: 'low_demand', cpc: 'none' },
    { name: 'Dia das Crianças', type: 'childrens_day', date: `${year}-10-12`, pre: 21, post: 2, demand: 'high_peak', cpc: 'high' },
    { name: 'Finados', type: 'holiday', date: `${year}-11-02`, pre: 1, post: 1, demand: 'low_demand', cpc: 'none' },
    { name: 'Proclamação da República', type: 'holiday', date: `${year}-11-15`, pre: 1, post: 1, demand: 'low_demand', cpc: 'none' },
    { name: 'Black Friday', type: 'black_friday', date: bf, pre: 14, post: 3, demand: 'very_high_peak', cpc: 'very_high' },
    { name: 'Cyber Monday', type: 'cyber_monday', date: cm.toISOString().slice(0, 10), pre: 0, post: 2, demand: 'very_high_peak', cpc: 'very_high' },
    { name: 'Pré-Natal', type: 'pre_christmas', date: `${year}-12-24`, pre: 30, post: 0, demand: 'high_peak', cpc: 'high' },
    { name: 'Natal', type: 'christmas', date: `${year}-12-25`, pre: 0, post: 3, demand: 'high_peak', cpc: 'very_high' },
    { name: 'Reveillon', type: 'new_year', date: `${year}-12-31`, pre: 5, post: 3, demand: 'moderate_peak', cpc: 'moderate' },
    { name: 'Dia das Mães', type: 'mothers_day', date: secondSunday(year, 5), pre: 21, post: 2, demand: 'high_peak', cpc: 'high' },
    { name: 'Dia dos Pais', type: 'fathers_day', date: secondSunday(year, 8), pre: 14, post: 2, demand: 'high_peak', cpc: 'moderate' },
    { name: 'Volta às Aulas Fev', type: 'back_to_school', date: `${year}-02-01`, pre: 14, post: 7, demand: 'moderate_peak', cpc: 'low' },
    { name: 'Volta às Aulas Ago', type: 'back_to_school', date: `${year}-08-01`, pre: 14, post: 7, demand: 'moderate_peak', cpc: 'low' },
  ];
}

function getSeasonalCtx(dateStr, customEvents) {
  const date = new Date(dateStr + 'T12:00:00');
  const dow = date.getDay();
  const dom = parseInt(dateStr.slice(8, 10));
  const year = parseInt(dateStr.slice(0, 4));
  const isWeekend = dow === 0 || dow === 6;
  const allEvents = [
    ...getBrazilEventsForYear(year - 1),
    ...getBrazilEventsForYear(year),
    ...getBrazilEventsForYear(year + 1),
    ...(customEvents || []),
  ];
  const matched = [];
  for (const ev of allEvents) {
    const evDate = new Date((ev.peak_date || ev.date) + 'T12:00:00');
    const preMs = (ev.pre || ev.pre_event_days || 0) * 86400000;
    const postMs = (ev.post || ev.post_event_days || 0) * 86400000;
    const endDate = ev.end ? new Date(ev.end + 'T12:00:00') : evDate;
    if (date >= new Date(evDate.getTime() - preMs) && date <= new Date(endDate.getTime() + postMs)) {
      const daysTo = Math.round((evDate.getTime() - date.getTime()) / 86400000);
      const phase = daysTo > 0 ? 'pre_event' : (date > endDate ? 'post_event' : 'active');
      matched.push({ name: ev.name, type: ev.event_type || ev.type, phase, days_to: daysTo, demand: ev.demand || 'normal', cpc: ev.cpc || 'none' });
    }
  }
  const prio = { very_high_peak: 5, high_peak: 4, moderate_peak: 3, normal: 2, uncertain: 1, low_demand: 0 };
  matched.sort((a, b) => (prio[b.demand] || 0) - (prio[a.demand] || 0));
  const primary = matched[0] || null;
  const demandLevel = primary?.demand || (isWeekend ? 'uncertain' : 'normal');
  return {
    is_weekend: isWeekend,
    is_saturday: dow === 6,
    is_sunday: dow === 0,
    is_holiday: matched.some(e => ['holiday', 'christmas', 'new_year'].includes(e.type)),
    is_start_of_month: dom <= 5,
    is_end_of_month: dom >= 26,
    is_payday_week: dom >= 4 && dom <= 10,
    seasonal_event_name: primary?.name || null,
    seasonal_phase: primary?.phase || 'normal',
    expected_demand_level: demandLevel,
    expected_cpc_pressure: primary?.cpc || 'none',
    is_strong_event: ['very_high_peak', 'high_peak'].includes(demandLevel),
    is_pre_event: primary?.phase === 'pre_event',
    is_low_demand: demandLevel === 'low_demand',
  };
}

// Retorna true se ação de aumento deve ser bloqueada por sazonalidade
function seasonalBlocksIncrease(seasonalCtx, weekendCtx, hasSales, hasStock, stockDays) {
  const hasAdequateStock = hasStock && (stockDays == null || stockDays >= 7);
  // Bloquear em baixa demanda
  if (seasonalCtx.is_low_demand) return true;
  // Bloquear em feriado sem vendas
  if (seasonalCtx.is_holiday && !hasSales) return true;
  // Bloquear em fim de semana com histórico ruim
  if (seasonalCtx.is_weekend && weekendCtx?.weekend_performs_better === false) return true;
  // Bloquear se estoque insuficiente em evento forte
  if (seasonalCtx.is_strong_event && !hasAdequateStock) return true;
  return false;
}

function buildSeasonalContextPayload(seasonalCtx) {
  return JSON.stringify({
    is_weekend: seasonalCtx.is_weekend,
    is_holiday: seasonalCtx.is_holiday,
    seasonal_event_name: seasonalCtx.seasonal_event_name,
    seasonal_phase: seasonalCtx.seasonal_phase,
    expected_demand_level: seasonalCtx.expected_demand_level,
    expected_cpc_pressure: seasonalCtx.expected_cpc_pressure,
  });
}

// ── Handler principal ────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  const correlationId = uuid();
  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  const base44 = createClientFromRequest(req);

  try {
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    let account = null;
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

    // ── 1. Regras vigentes ────────────────────────────────────────────────
    const allRules = await base44.asServiceRole.entities.DecisionRule.filter({ amazon_account_id: aid, status: 'active' });
    const activeRules = allRules.filter(r => {
      if (r.effective_from && new Date(r.effective_from) > new Date()) return false;
      if (r.effective_until && new Date(r.effective_until) < new Date()) return false;
      return true;
    }).sort((a, b) => (a.priority || 100) - (b.priority || 100));

    if (activeRules.length === 0) {
      return Response.json({ ok: true, message: 'Nenhuma regra ativa. Motor encerrado.', correlationId });
    }

    // ── 2. Dados em paralelo ──────────────────────────────────────────────
    const [keywords, campaigns, products, customSeasonalEvents, metricsRaw] = await Promise.all([
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: aid }, '-spend', 500),
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid }, null, 200),
      base44.asServiceRole.entities.Product.filter({ amazon_account_id: aid }, null, 100),
      base44.asServiceRole.entities.SeasonalityCalendar.filter({ amazon_account_id: aid, enabled: true }).catch(() => []),
      base44.asServiceRole.entities.CampaignMetricsDaily.filter({ amazon_account_id: aid }, '-date', 200).catch(() => []),
    ]);

    // ── 3. Contexto sazonal ───────────────────────────────────────────────
    const seasonalCtx = getSeasonalCtx(today, customSeasonalEvents);

    // Análise FDS vs dias úteis (últimos 30 dias)
    const cutStart = new Date(Date.now() - 31 * 86400000).toISOString().slice(0, 10);
    const cutEnd = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const byDate = {};
    for (const m of metricsRaw) {
      if (!m.date || m.date < cutStart || m.date > cutEnd) continue;
      if (!byDate[m.date]) byDate[m.date] = { spend: 0, sales: 0, orders: 0, clicks: 0 };
      byDate[m.date].spend += m.spend || 0;
      byDate[m.date].sales += m.sales || 0;
      byDate[m.date].orders += m.orders || 0;
      byDate[m.date].clicks += m.clicks || 0;
    }
    const wd = { spend: 0, sales: 0, orders: 0, clicks: 0, days: 0 };
    const we = { spend: 0, sales: 0, orders: 0, clicks: 0, days: 0 };
    for (const [d, v] of Object.entries(byDate)) {
      const dow2 = new Date(d + 'T12:00:00').getDay();
      const b = (dow2 === 0 || dow2 === 6) ? we : wd;
      b.spend += v.spend; b.sales += v.sales; b.orders += v.orders; b.clicks += v.clicks; b.days++;
    }
    const wdCvr = wd.clicks > 0 ? wd.orders / wd.clicks : null;
    const weCvr = we.clicks > 0 ? we.orders / we.clicks : null;
    const wdAcos = wd.sales > 0 ? wd.spend / wd.sales * 100 : null;
    const weAcos = we.sales > 0 ? we.spend / we.sales * 100 : null;
    const weekendPerformsBetter = (wdCvr != null && weCvr != null && we.days >= 2 && wd.days >= 5)
      ? (weCvr > wdCvr * 1.05 && (wdAcos == null || weAcos == null || weAcos <= wdAcos * 1.25))
      : null;
    const weekendCtx = { weekend_performs_better: weekendPerformsBetter };

    // ── 4. Validar qualidade dos dados ────────────────────────────────────
    const dataAge = account.last_sync_at
      ? (Date.now() - new Date(account.last_sync_at).getTime()) / 3600000
      : 999;
    if (dataAge > 48) {
      return Response.json({
        ok: false, skipped: true,
        reason: `Dados desatualizados (${Math.round(dataAge)}h sem sync). Motor bloqueado por segurança.`,
        correlationId,
      });
    }

    // ── 5. Guardrail: budget total ────────────────────────────────────────
    const totalActiveBudget = campaigns
      .filter(c => c.state === 'enabled' || c.status === 'enabled')
      .reduce((s, c) => s + (c.daily_budget || 0), 0);
    const suggestedTotalBudget = Math.min(MAX_TOTAL_DAILY_BUDGET, Math.max(MIN_TOTAL_DAILY_BUDGET, TARGET_TOTAL_DAILY_BUDGET));

    // ── 6. Índices ────────────────────────────────────────────────────────
    const productMap = new Map(products.map(p => [p.asin, p]));

    const recentExecs = await base44.asServiceRole.entities.RuleExecution.filter(
      { amazon_account_id: aid }, '-created_date', 300
    );
    const lastExecByRuleEntity = new Map();
    for (const ex of recentExecs) {
      const k = `${ex.rule_key}|${ex.entity_id}`;
      if (!lastExecByRuleEntity.has(k)) lastExecByRuleEntity.set(k, ex);
    }
    const usedIdemKeys = new Set(
      recentExecs.filter(e => (e.created_date || '').slice(0, 10) === today).map(e => e.idempotency_key).filter(Boolean)
    );

    const actionsToEnqueue = [];
    const conflicts = [];
    const stats = { evaluated: 0, matched: 0, skipped_cooldown: 0, skipped_dup: 0, skipped_stock: 0, skipped_seasonal: 0, enqueued: 0 };
    const entityChangedThisCycle = new Map();
    const scopedEntities = { keyword: keywords, campaign: campaigns };

    const seasonalPayload = buildSeasonalContextPayload(seasonalCtx);

    // ── 7. Avaliar regras ─────────────────────────────────────────────────
    for (const rule of activeRules) {
      const entities = scopedEntities[rule.scope] || [];

      for (const entity of entities) {
        stats.evaluated++;
        const entityId = entity.keyword_id || entity.campaign_id || entity.id;
        if (!entityId) continue;

        const product = entity.asin ? productMap.get(entity.asin) : null;
        const isOutOfStock = product?.inventory_status === 'out_of_stock';

        // Guardrail estoque
        if (isOutOfStock && ['increase_bid_percent', 'activate_campaign', 'activate_keyword', 'create_exact_keyword'].includes(rule.action.type)) {
          stats.skipped_stock++;
          continue;
        }

        const entityData = {
          ...entity,
          current_bid: entity.current_bid || entity.bid || 0.25,
          current_budget: entity.daily_budget || 0,
          stock: product?.fba_inventory || 0,
          stock_days: product?.stock_days || 0,
        };

        if (!entityMatchesRule(rule, entityData)) continue;
        stats.matched++;

        // Guardrail sazonal — apenas para ações de aumento
        const isIncreaseAction = ['increase_bid_percent', 'redistribute_budget', 'activate_campaign', 'activate_keyword', 'create_exact_keyword', 'create_phrase_keyword', 'create_broad_keyword', 'create_campaign'].includes(rule.action.type);
        if (isIncreaseAction) {
          const hasSales = (entityData.sales || entityData.orders || 0) > 0;
          const hasStock = !isOutOfStock;
          const stockDays = product?.stock_days || null;
          if (seasonalBlocksIncrease(seasonalCtx, weekendCtx, hasSales, hasStock, stockDays)) {
            stats.skipped_seasonal++;
            continue;
          }
        }

        // Guardrail cooldown
        const lastExec = lastExecByRuleEntity.get(`${rule.rule_key}|${entityId}`);
        if (lastExec?.executed_at) {
          const hoursAgo = (Date.now() - new Date(lastExec.executed_at).getTime()) / 3600000;
          if (hoursAgo < (rule.cooldown_hours || 72)) {
            stats.skipped_cooldown++;
            continue;
          }
        }

        // Resolver conflito com ação já agendada para esta entidade
        const existingRuleKey = entityChangedThisCycle.get(entityId);
        if (existingRuleKey) {
          const existingRule = activeRules.find(r => r.rule_key === existingRuleKey);
          if (existingRule) {
            const resolution = resolveRuleConflicts(existingRule, rule);
            conflicts.push({
              amazon_account_id: aid,
              correlation_id: correlationId,
              rule_key_a: existingRule.rule_key,
              rule_key_b: rule.rule_key,
              entity_id: entityId,
              resolution: `execute:${resolution.execute.rule_key}`,
              rule_executed: resolution.execute.rule_key,
              rule_skipped: resolution.skip.rule_key,
              resolved_at: now,
            });
            if (resolution.execute.rule_key !== rule.rule_key) continue;
          }
        }

        const newValue = calculateActionValue(rule, entityData);
        const iKey = `det|${aid}|${rule.rule_key}|${entityId}|${today}`;
        if (usedIdemKeys.has(iKey)) { stats.skipped_dup++; continue; }

        if (rule.action.type === 'redistribute_budget' && totalActiveBudget > MAX_TOTAL_DAILY_BUDGET) continue;

        actionsToEnqueue.push({
          amazon_account_id: aid,
          correlation_id: correlationId,
          rule_key: rule.rule_key,
          rule_version: rule.version || 1,
          entity_type: rule.scope,
          entity_id: entityId,
          campaign_id: entity.campaign_id,
          keyword_id: entity.keyword_id,
          asin: entity.asin,
          action_type: rule.action.type,
          value_before: entityData.current_bid || entityData.current_budget || 0,
          value_after: newValue,
          idempotency_key: iKey,
          status: 'pending',
          seasonal_context: seasonalPayload,
        });
        entityChangedThisCycle.set(entityId, rule.rule_key);
        stats.enqueued++;
      }
    }

    // ── 8. Gravar ─────────────────────────────────────────────────────────
    for (const c of conflicts.slice(0, 50)) {
      await base44.asServiceRole.entities.RuleConflict.create(c).catch(() => {});
    }
    for (let i = 0; i < actionsToEnqueue.length; i += 50) {
      await base44.asServiceRole.entities.RuleExecution.bulkCreate(actionsToEnqueue.slice(i, i + 50));
    }

    return Response.json({
      ok: true,
      correlationId,
      active_rules: activeRules.length,
      data_age_hours: Math.round(dataAge),
      total_active_budget: Math.round(totalActiveBudget * 100) / 100,
      suggested_total_budget: suggestedTotalBudget,
      budget_within_limits: totalActiveBudget <= MAX_TOTAL_DAILY_BUDGET,
      seasonal_context: { event: seasonalCtx.seasonal_event_name, demand: seasonalCtx.expected_demand_level, is_weekend: seasonalCtx.is_weekend },
      stats,
      conflicts_resolved: conflicts.length,
      actions_enqueued: actionsToEnqueue.length,
    });

  } catch (error) {
    console.error('[runDeterministicDecisionEngine]', error.message);
    return Response.json({ ok: false, error: error.message, correlationId }, { status: 500 });
  }
});