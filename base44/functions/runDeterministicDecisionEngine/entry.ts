/**
 * runDeterministicDecisionEngine — Módulo B: Motor Determinístico Diário
 *
 * REGRA ABSOLUTA: Este módulo NÃO chama Claude, nenhum LLM, nenhuma IA.
 * Carrega regras vigentes do banco e executa decisões puramente calculadas.
 * A indisponibilidade de qualquer IA não afeta este módulo.
 *
 * Resultado para mesma entrada + mesma versão de regras = SEMPRE igual (determinístico).
 *
 * Guardrails financeiros protegidos (codificados — não vêm do banco):
 *   Budget total automático: R$50–R$65
 *   Bid mínimo: R$0.10 | Bid máximo: R$5.00
 *   Toda ação passa pela fila com idempotency_key
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

// ── Guardrails financeiros (imutáveis — codificados no sistema) ──────────────
const MIN_TOTAL_DAILY_BUDGET = 50;
const TARGET_TOTAL_DAILY_BUDGET = 60;
const MAX_TOTAL_DAILY_BUDGET = 65;
const MIN_BID = 0.10;
const MAX_BID = 5.0;
const MAX_BID_CHANGE_PCT = 0.30; // máximo 30% por execução

// Prioridade de conflito (menor = mais prioritário)
const CONFLICT_PRIORITY = {
  financial_safety: 1, stock: 2, profit: 3, budget_limit: 4,
  protected_rules: 5, dedup: 6, pause_loss: 7, reduce_bid: 8,
  maintenance: 9, increase_bid: 10, expansion: 11, campaign_creation: 12,
};

function uuid() { return `${Date.now()}-${Math.random().toString(36).slice(2)}`; }
function daysAgo(n) { return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10); }

// ── Avaliador de condição determinístico ────────────────────────────────────
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

// ── Calcular valor da ação ───────────────────────────────────────────────────
function calculateActionValue(rule, entity) {
  const action = rule.action;
  const currentBid = entity.current_bid || entity.bid || 0.25;
  const currentBudget = entity.daily_budget || entity.current_budget || 0;

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

// ── Resolver conflito entre duas regras ─────────────────────────────────────
function resolveRuleConflicts(ruleA, ruleB) {
  const typeA = ruleA.action?.type || '';
  const typeB = ruleB.action?.type || '';

  const categoryOf = (t) => {
    if (['pause_campaign', 'pause_keyword'].includes(t)) return 'pause_loss';
    if (['decrease_bid_percent', 'set_bid'].includes(t) && ruleA.priority <= ruleB.priority) return 'reduce_bid';
    if (['increase_bid_percent'].includes(t)) return 'increase_bid';
    if (['create_exact_keyword', 'create_phrase_keyword', 'create_broad_keyword', 'create_campaign'].includes(t)) return 'expansion';
    return 'maintenance';
  };

  const catA = categoryOf(typeA);
  const catB = categoryOf(typeB);
  const prioA = CONFLICT_PRIORITY[catA] || 99;
  const prioB = CONFLICT_PRIORITY[catB] || 99;

  return prioA <= prioB ? { execute: ruleA, skip: ruleB } : { execute: ruleB, skip: ruleA };
}

// ── Funções sazonais inline (sem import externo) ──────────────────────────────

function getBrazilBaseEventsForYear(year) {
  function getLastFridayNov(y) {
    const d = new Date(y, 11, 0);
    while (d.getDay() !== 5) d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  }
  function getSecondSunday(y, month) {
    const d = new Date(y, month - 1, 1);
    let sundays = 0;
    while (sundays < 2) { if (d.getDay() === 0) sundays++; if (sundays < 2) d.setDate(d.getDate() + 1); }
    return d.toISOString().slice(0, 10);
  }
  const bf = getLastFridayNov(year);
  const cyberDate = new Date(bf); cyberDate.setDate(cyberDate.getDate() + 3);
  return [
    { name: 'Ano Novo', type: 'holiday', date: `${year}-01-01`, pre: 3, post: 2, demand: 'moderate_peak', cpc: 'low' },
    { name: 'Tiradentes', type: 'holiday', date: `${year}-04-21`, pre: 1, post: 1, demand: 'low_demand', cpc: 'none' },
    { name: 'Dia do Trabalho', type: 'holiday', date: `${year}-05-01`, pre: 1, post: 1, demand: 'low_demand', cpc: 'none' },
    { name: 'Dia dos Namorados', type: 'valentines_day', date: `${year}-06-12`, pre: 14, post: 2, demand: 'moderate_peak', cpc: 'moderate' },
    { name: 'Independência', type: 'holiday', date: `${year}-09-07`, pre: 1, post: 1, demand: 'low_demand', cpc: 'none' },
    { name: 'Dia das Crianças / Aparecida', type: 'childrens_day', date: `${year}-10-12`, pre: 21, post: 2, demand: 'high_peak', cpc: 'high' },
    { name: 'Finados', type: 'holiday', date: `${year}-11-02`, pre: 1, post: 1, demand: 'low_demand', cpc: 'none' },
    { name: 'Proclamação da República', type: 'holiday', date: `${year}-11-15`, pre: 1, post: 1, demand: 'low_demand', cpc: 'none' },
    { name: 'Black Friday', type: 'black_friday', date: bf, pre: 14, post: 3, demand: 'very_high_peak', cpc: 'very_high' },
    { name: 'Cyber Monday', type: 'cyber_monday', date: cyberDate.toISOString().slice(0, 10), pre: 0, post: 2, demand: 'very_high_peak', cpc: 'very_high' },
    { name: 'Pré-Natal', type: 'pre_christmas', date: `${year}-12-24`, pre: 30, post: 0, demand: 'high_peak', cpc: 'high' },
    { name: 'Natal', type: 'christmas', date: `${year}-12-25`, pre: 0, post: 3, demand: 'high_peak', cpc: 'very_high' },
    { name: 'Reveillon', type: 'new_year', date: `${year}-12-31`, pre: 5, post: 3, demand: 'moderate_peak', cpc: 'moderate' },
    { name: 'Dia das Mães', type: 'mothers_day', date: getSecondSunday(year, 5), pre: 21, post: 2, demand: 'high_peak', cpc: 'high' },
    { name: 'Dia dos Pais', type: 'fathers_day', date: getSecondSunday(year, 8), pre: 14, post: 2, demand: 'high_peak', cpc: 'moderate' },
    { name: 'Volta às Aulas Fev', type: 'back_to_school', date: `${year}-02-01`, pre: 14, post: 7, demand: 'moderate_peak', cpc: 'low' },
    { name: 'Volta às Aulas Ago', type: 'back_to_school', date: `${year}-08-01`, pre: 14, post: 7, demand: 'moderate_peak', cpc: 'low' },
  ];
}

function getSeasonalContextForDate(dateStr, customEvents = []) {
  const date = new Date(dateStr + 'T12:00:00');
  const dow = date.getDay();
  const dom = parseInt(dateStr.slice(8, 10));
  const year = parseInt(dateStr.slice(0, 4));
  const isWeekend = dow === 0 || dow === 6;
  const isHoliday = dow === 0; // base; sobrescrito por eventos

  const allEvents = [
    ...getBrazilBaseEventsForYear(year - 1),
    ...getBrazilBaseEventsForYear(year),
    ...getBrazilBaseEventsForYear(year + 1),
    ...(customEvents || []),
  ];

  const matched = [];
  for (const ev of allEvents) {
    const evDate = new Date((ev.peak_date || ev.date) + 'T12:00:00');
    const preMs = (ev.pre || ev.pre_event_days || 0) * 86400000;
    const postMs = (ev.post || ev.post_event_days || 0) * 86400000;
    const endDate = ev.end ? new Date(ev.end + 'T12:00:00') : evDate;
    const winStart = new Date(evDate.getTime() - preMs);
    const winEnd = new Date(endDate.getTime() + postMs);
    if (date >= winStart && date <= winEnd) {
      const daysTo = Math.round((evDate.getTime() - date.getTime()) / 86400000);
      const phase = daysTo > 0 ? 'pre_event' : (date > endDate ? 'post_event' : 'active');
      matched.push({ name: ev.name, type: ev.event_type || ev.type, phase, days_to: daysTo, demand: ev.demand || 'normal', cpc: ev.cpc || 'none' });
    }
  }

  const demandPrio = { very_high_peak: 5, high_peak: 4, moderate_peak: 3, normal: 2, uncertain: 1, low_demand: 0 };
  matched.sort((a, b) => (demandPrio[b.demand] || 0) - (demandPrio[a.demand] || 0));
  const primary = matched[0] || null;

  const isHolidayEvent = matched.some(e => ['holiday', 'christmas', 'new_year'].includes(e.type));
  const demandLevel = primary?.demand || (isWeekend ? 'uncertain' : 'normal');
  const cpcPressure = primary?.cpc || 'none';
  const isStrongEvent = ['very_high_peak', 'high_peak'].includes(demandLevel);
  const isPreEvent = primary?.phase === 'pre_event';

  return {
    date: dateStr,
    is_weekend: isWeekend,
    is_saturday: dow === 6,
    is_sunday: dow === 0,
    is_holiday: isHolidayEvent,
    is_start_of_month: dom <= 5,
    is_end_of_month: dom >= 26,
    is_payday_week: dom >= 4 && dom <= 10,
    seasonal_event_name: primary?.name || null,
    seasonal_phase: primary?.phase || 'normal',
    expected_demand_level: demandLevel,
    expected_cpc_pressure: cpcPressure,
    is_strong_event: isStrongEvent,
    is_pre_event: isPreEvent,
    is_low_demand: demandLevel === 'low_demand',
    matched_events: matched,
  };
}

function buildSeasonalStrategy(seasonalCtx, performanceCtx, weekendCtx) {
  // REGRA SOBERANA: sazonalidade NUNCA substitui performance real
  const { acos_ok = false, roas_ok = false, cpc_ok = false, has_sales = false, has_stock = true, stock_days } = performanceCtx || {};
  const hasRealPerformance = has_sales && acos_ok && roas_ok && cpc_ok;
  const hasAdequateStock = has_stock && (stock_days == null || stock_days >= 7);

  const strategy = {
    allow_bid_increase: false,
    allow_budget_increase: false,
    allow_top_of_search: false,
    reduce_bid: false,
    protect_budget_for_weekday: false,
    require_confidence: 90,
    max_bid_increase_pct: 0,
    max_budget_increase_pct: 0,
    seasonal_adjustment_applied: false,
    seasonal_reason: 'Período normal.',
    warnings: [],
  };

  // Datas fortes com pré-evento + performance real
  if (seasonalCtx.is_strong_event && seasonalCtx.is_pre_event && hasRealPerformance && hasAdequateStock) {
    strategy.allow_bid_increase = true;
    strategy.allow_budget_increase = true;
    strategy.max_bid_increase_pct = 5;
    strategy.max_budget_increase_pct = 10;
    strategy.seasonal_adjustment_applied = true;
    strategy.seasonal_reason = `Pré-evento forte (${seasonalCtx.seasonal_event_name}) com performance validada.`;
  }

  // Evento ativo forte + performance
  if (seasonalCtx.is_strong_event && seasonalCtx.seasonal_phase === 'active' && hasRealPerformance && hasAdequateStock) {
    strategy.allow_bid_increase = true;
    strategy.allow_top_of_search = true;
    strategy.max_bid_increase_pct = 5;
    strategy.seasonal_adjustment_applied = true;
    strategy.seasonal_reason = `Evento ativo: ${seasonalCtx.seasonal_event_name}.`;
  }

  // Feriado: exigir confidence mais alto
  if (seasonalCtx.is_holiday) {
    strategy.require_confidence = 92;
    if (!hasRealPerformance) {
      strategy.allow_bid_increase = false;
      strategy.allow_budget_increase = false;
      strategy.warnings.push('Feriado sem performance real. Bloqueando aumento automático.');
    }
  }

  // Fim de semana com histórico
  if (seasonalCtx.is_weekend && weekendCtx) {
    if (weekendCtx.weekend_performs_better === true && hasRealPerformance) {
      strategy.allow_bid_increase = strategy.allow_bid_increase || true;
      strategy.max_bid_increase_pct = Math.max(strategy.max_bid_increase_pct, 3);
      strategy.seasonal_adjustment_applied = true;
      strategy.seasonal_reason += ' FDS com conversão superior.';
    } else if (weekendCtx.weekend_performs_better === false) {
      strategy.allow_bid_increase = false;
      strategy.allow_budget_increase = false;
      strategy.allow_top_of_search = false;
      strategy.reduce_bid = true;
      strategy.protect_budget_for_weekday = true;
      strategy.seasonal_adjustment_applied = true;
      strategy.warnings.push('FDS com histórico de gasto sem conversão. Redução aplicada.');
    }
  }

  // Baixa demanda: bloquear escala
  if (seasonalCtx.is_low_demand) {
    strategy.allow_bid_increase = false;
    strategy.allow_budget_increase = false;
    strategy.allow_top_of_search = false;
    strategy.seasonal_reason = 'Período de baixa demanda. Conservando orçamento.';
  }

  // CPC alto + sem conversão
  if (['high', 'very_high'].includes(seasonalCtx.expected_cpc_pressure) && !hasRealPerformance) {
    strategy.allow_bid_increase = false;
    strategy.allow_top_of_search = false;
    strategy.warnings.push(`Alta pressão de CPC (${seasonalCtx.expected_cpc_pressure}) sem conversão. Proteger orçamento.`);
  }

  // Estoque insuficiente
  if (!hasAdequateStock && seasonalCtx.is_strong_event) {
    strategy.allow_bid_increase = false;
    strategy.allow_budget_increase = false;
    strategy.warnings.push('Estoque insuficiente para escalar em evento sazonal.');
  }

  return strategy;
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

    // ── 1. Carregar regras vigentes (somente status=active, dentro de vigência) ──
    const allRules = await base44.asServiceRole.entities.DecisionRule.filter({ amazon_account_id: aid, status: 'active' });
    const activeRules = allRules.filter(r => {
      if (r.effective_from && new Date(r.effective_from) > new Date()) return false;
      if (r.effective_until && new Date(r.effective_until) < new Date()) return false;
      return true;
    }).sort((a, b) => (a.priority || 100) - (b.priority || 100));

    if (activeRules.length === 0) {
      return Response.json({ ok: true, message: 'Nenhuma regra ativa. Motor encerrado.', correlationId });
    }

    // ── 2. Carregar contexto sazonal e métricas ───────────────────────────
    // Carregar customEvents e análise de FDS em paralelo
    const [keywords, campaigns, products, customSeasonalEvents, weekdayAnalysisRaw] = await Promise.all([
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: aid }, '-spend', 500),
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid }, null, 200),
      base44.asServiceRole.entities.Product.filter({ amazon_account_id: aid }, null, 100),
      base44.asServiceRole.entities.SeasonalityCalendar.filter({ amazon_account_id: aid, enabled: true }).catch(() => []),
      base44.asServiceRole.entities.CampaignMetricsDaily.filter({ amazon_account_id: aid }, '-date', 200).catch(() => []),
    ]);

    // Construir contexto sazonal para hoje
    const seasonalCtx = getSeasonalContextForDate(today, customSeasonalEvents);

    // Analisar FDS vs dias úteis (últimos 30 dias)
    const endStr = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const startStr = new Date(Date.now() - 31 * 86400000).toISOString().slice(0, 10);
    const byDate = {};
    for (const m of weekdayAnalysisRaw) {
      if (!m.date || m.date < startStr || m.date > endStr) continue;
      if (!byDate[m.date]) byDate[m.date] = { spend: 0, sales: 0, orders: 0, clicks: 0, days: 0 };
      byDate[m.date].spend += m.spend || 0;
      byDate[m.date].sales += m.sales || 0;
      byDate[m.date].orders += m.orders || 0;
      byDate[m.date].clicks += m.clicks || 0;
    }
    const wdBucket = { spend: 0, sales: 0, orders: 0, clicks: 0, days: 0 };
    const weBucket = { spend: 0, sales: 0, orders: 0, clicks: 0, days: 0 };
    for (const [d, v] of Object.entries(byDate)) {
      const dow = new Date(d + 'T12:00:00').getDay();
      const bucket = (dow === 0 || dow === 6) ? weBucket : wdBucket;
      bucket.spend += v.spend; bucket.sales += v.sales; bucket.orders += v.orders; bucket.clicks += v.clicks; bucket.days++;
    }
    const wdAcos = wdBucket.sales > 0 ? wdBucket.spend / wdBucket.sales * 100 : null;
    const weAcos = weBucket.sales > 0 ? weBucket.spend / weBucket.sales * 100 : null;
    const wdCvr = wdBucket.clicks > 0 ? wdBucket.orders / wdBucket.clicks * 100 : null;
    const weCvr = weBucket.clicks > 0 ? weBucket.orders / weBucket.clicks * 100 : null;
    const weekendPerformsBetter = (wdCvr != null && weCvr != null && weBucket.days >= 2 && wdBucket.days >= 5)
      ? (weCvr > wdCvr * 1.05 && (wdAcos == null || weAcos == null || weAcos <= wdAcos * 1.25))
      : null;
    const weekendCtx = { weekend_performs_better: weekendPerformsBetter, weekend_acos_ok: (weAcos != null && wdAcos != null ? weAcos <= wdAcos * 1.25 : true) };

    // ── 3. Validar qualidade dos dados ────────────────────────────────────
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

    // ── 4. Guardrail: verificar budget total ──────────────────────────────
    const totalActiveBudget = campaigns
      .filter(c => c.state === 'enabled' || c.status === 'enabled')
      .reduce((s, c) => s + (c.daily_budget || 0), 0);

    const suggestedTotalBudget = Math.min(
      MAX_TOTAL_DAILY_BUDGET,
      Math.max(MIN_TOTAL_DAILY_BUDGET, TARGET_TOTAL_DAILY_BUDGET)
    );

    // ── 5. Índices ─────────────────────────────────────────────────────────
    const productMap = new Map(products.map(p => [p.asin, p]));
    const campaignMap = new Map(campaigns.map(c => [c.campaign_id, c]));

    // Últimas execuções para controle de cooldown
    const recentExecs = await base44.asServiceRole.entities.RuleExecution.filter(
      { amazon_account_id: aid }, '-created_date', 300
    );
    const lastExecByRuleEntity = new Map();
    for (const ex of recentExecs) {
      const k = `${ex.rule_key}|${ex.entity_id}`;
      if (!lastExecByRuleEntity.has(k)) lastExecByRuleEntity.set(k, ex);
    }

    // Idempotency keys já usadas hoje
    const existingExecsToday = recentExecs.filter(e => (e.created_date || '').slice(0, 10) === today);
    const usedIdemKeys = new Set(existingExecsToday.map(e => e.idempotency_key).filter(Boolean));

    const actionsToEnqueue = [];
    const conflicts = [];
    const stats = { evaluated: 0, matched: 0, skipped_cooldown: 0, skipped_dup: 0, skipped_stock: 0, enqueued: 0 };

    // Controle de ação por entidade neste ciclo (uma variável por entidade)
    const entityChangedThisCycle = new Map(); // entity_id → rule_key

    const scopedEntities = {
      keyword: keywords,
      campaign: campaigns,
    };

    // ── 6. Avaliar cada regra contra cada entidade do escopo ──────────────
    for (const rule of activeRules) {
      const entities = scopedEntities[rule.scope] || [];

      for (const entity of entities) {
        stats.evaluated++;

        const entityId = entity.keyword_id || entity.campaign_id || entity.id;
        if (!entityId) continue;

        // Guardrail: produto sem estoque
        const product = entity.asin ? productMap.get(entity.asin) : null;
        if (product?.inventory_status === 'out_of_stock' && ['increase_bid_percent', 'activate_campaign', 'activate_keyword', 'create_exact_keyword'].includes(rule.action.type)) {
          stats.skipped_stock++;
          continue;
        }

        // Verificar condições
        const entityData = {
          ...entity,
          current_bid: entity.current_bid || entity.bid || 0.25,
          current_budget: entity.daily_budget || 0,
          stock: product?.fba_inventory || 0,
          stock_days: product?.stock_days || 0,
        };

        if (!entityMatchesRule(rule, entityData)) continue;
        stats.matched++;

        // ── Guardrail Sazonal ────────────────────────────────────────────
        // Ações de aumento de bid/budget passam pelo filtro sazonal
        const isIncreaseAction = ['increase_bid_percent', 'redistribute_budget', 'activate_campaign', 'activate_keyword', 'create_exact_keyword', 'create_phrase_keyword', 'create_broad_keyword', 'create_campaign'].includes(rule.action.type);
        if (isIncreaseAction) {
          const perfCtx = {
            has_sales: (entityData.sales || entityData.orders || 0) > 0,
            acos_ok: !entityData.acos || entityData.acos <= (account.max_acos || 99),
            roas_ok: !entityData.roas || entityData.roas >= (account.target_roas || 0),
            cpc_ok: true,
            has_stock: product?.inventory_status !== 'out_of_stock',
            stock_days: product?.stock_days || null,
          };
          const seasonal = buildSeasonalStrategy(seasonalCtx, perfCtx, weekendCtx);
          if (seasonal.is_low_demand || (seasonalCtx.is_holiday && !perfCtx.has_sales)) {
            stats.skipped_stock++; // reusar contador para sazonalidade
            continue;
          }
          // Limitar % de aumento se sazonal indicar (sobrescrever action localmente)
          if (seasonal.max_bid_increase_pct > 0 && rule.action.type === 'increase_bid_percent') {
            const cappedPct = Math.min(rule.action.value || 10, seasonal.max_bid_increase_pct);
            entityData._seasonal_capped_bid_pct = cappedPct;
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

        // Resolver conflito com ação já agendada para esta entidade neste ciclo
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
            if (resolution.execute.rule_key !== rule.rule_key) continue; // skip esta
          }
        }

        // Calcular valor da ação
        const newValue = calculateActionValue(rule, entityData);

        // Idempotency key
        const iKey = `det|${aid}|${rule.rule_key}|${entityId}|${today}`;
        if (usedIdemKeys.has(iKey)) { stats.skipped_dup++; continue; }

        // Guardrail final: budget total não pode exceder MAX
        if (['redistribute_budget'].includes(rule.action.type) && totalActiveBudget > MAX_TOTAL_DAILY_BUDGET) {
          continue; // bloquear ação de budget se já está no limite
        }

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
          // Contexto sazonal registrado em toda decisão
          seasonal_context: JSON.stringify({
            is_weekend: seasonalCtx.is_weekend,
            is_holiday: seasonalCtx.is_holiday,
            seasonal_event_name: seasonalCtx.seasonal_event_name,
            seasonal_phase: seasonalCtx.seasonal_phase,
            expected_demand_level: seasonalCtx.expected_demand_level,
            expected_cpc_pressure: seasonalCtx.expected_cpc_pressure,
          }),
        });
        entityChangedThisCycle.set(entityId, rule.rule_key);
        stats.enqueued++;
      }
    }

    // ── 7. Gravar conflitos e ações na fila ───────────────────────────────
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
      stats,
      conflicts_resolved: conflicts.length,
      actions_enqueued: actionsToEnqueue.length,
    });

  } catch (error) {
    console.error('[runDeterministicDecisionEngine]', error.message);
    return Response.json({ ok: false, error: error.message, correlationId }, { status: 500 });
  }
});