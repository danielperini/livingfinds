/**
 * getSeasonalityContext
 *
 * Retorna o contexto sazonal completo para uma data e conta.
 * Usado por todos os motores de decisão antes de qualquer ação de bid/budget/campanha.
 *
 * REGRA SOBERANA: sazonalidade NUNCA autoriza aumento sem performance real.
 * Ela apenas modifica os limites tolerados quando os dados também indicarem oportunidade.
 */

import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

// ─── Calendário base Brasil (sem depender de API externa) ─────────────────────

function getBrazilBaseCalendar(year) {
  return [
    // Feriados nacionais fixos
    { name: 'Ano Novo', event_type: 'holiday', date: `${year}-01-01`, pre_days: 3, post_days: 2, demand: 'moderate_peak', cpc_pressure: 'low' },
    { name: 'Tiradentes', event_type: 'holiday', date: `${year}-04-21`, pre_days: 1, post_days: 1, demand: 'low_demand', cpc_pressure: 'none' },
    { name: 'Dia do Trabalho', event_type: 'holiday', date: `${year}-05-01`, pre_days: 1, post_days: 1, demand: 'low_demand', cpc_pressure: 'none' },
    { name: 'Independência do Brasil', event_type: 'holiday', date: `${year}-09-07`, pre_days: 1, post_days: 1, demand: 'low_demand', cpc_pressure: 'none' },
    { name: 'Nossa Senhora Aparecida', event_type: 'holiday', date: `${year}-10-12`, pre_days: 1, post_days: 1, demand: 'low_demand', cpc_pressure: 'none' },
    { name: 'Finados', event_type: 'holiday', date: `${year}-11-02`, pre_days: 1, post_days: 1, demand: 'low_demand', cpc_pressure: 'none' },
    { name: 'Proclamação da República', event_type: 'holiday', date: `${year}-11-15`, pre_days: 1, post_days: 1, demand: 'low_demand', cpc_pressure: 'none' },
    { name: 'Natal', event_type: 'christmas', date: `${year}-12-25`, pre_days: 30, post_days: 3, demand: 'high_peak', cpc_pressure: 'high' },
    { name: 'Véspera de Natal', event_type: 'pre_christmas', date: `${year}-12-24`, pre_days: 0, post_days: 0, demand: 'high_peak', cpc_pressure: 'very_high' },

    // Datas comerciais fortes — variáveis (calculadas dinamicamente)
    // Black Friday: última sexta de novembro
    { name: 'Black Friday', event_type: 'black_friday', date: getLastFridayOfNovember(year), pre_days: 14, post_days: 3, demand: 'very_high_peak', cpc_pressure: 'very_high' },
    { name: 'Cyber Monday', event_type: 'cyber_monday', date: getCyberMonday(year), pre_days: 0, post_days: 2, demand: 'very_high_peak', cpc_pressure: 'very_high' },

    // Dia das Mães: 2º domingo de maio
    { name: 'Dia das Mães', event_type: 'mothers_day', date: getSecondSunday(year, 5), pre_days: 21, post_days: 2, demand: 'high_peak', cpc_pressure: 'high' },

    // Dia dos Pais: 2º domingo de agosto
    { name: 'Dia dos Pais', event_type: 'fathers_day', date: getSecondSunday(year, 8), pre_days: 14, post_days: 2, demand: 'high_peak', cpc_pressure: 'moderate' },

    // Dia das Crianças: 12 de outubro (feriado)
    { name: 'Dia das Crianças', event_type: 'childrens_day', date: `${year}-10-12`, pre_days: 21, post_days: 2, demand: 'high_peak', cpc_pressure: 'high' },

    // Dia dos Namorados: 12 de junho
    { name: 'Dia dos Namorados', event_type: 'valentines_day', date: `${year}-06-12`, pre_days: 14, post_days: 2, demand: 'moderate_peak', cpc_pressure: 'moderate' },

    // Volta às aulas: fevereiro e agosto
    { name: 'Volta às Aulas (Fev)', event_type: 'back_to_school', date: `${year}-02-01`, pre_days: 14, post_days: 7, demand: 'moderate_peak', cpc_pressure: 'low' },
    { name: 'Volta às Aulas (Ago)', event_type: 'back_to_school', date: `${year}-08-01`, pre_days: 14, post_days: 7, demand: 'moderate_peak', cpc_pressure: 'low' },

    // Férias escolares
    { name: 'Férias de Julho', event_type: 'vacation', date: `${year}-07-01`, end: `${year}-07-31`, pre_days: 5, post_days: 5, demand: 'moderate_peak', cpc_pressure: 'low' },
    { name: 'Férias de Verão', event_type: 'vacation', date: `${year}-12-15`, end: `${year + 1}-01-31`, pre_days: 7, post_days: 7, demand: 'high_peak', cpc_pressure: 'moderate' },

    // Novo ano
    { name: 'Reveillon', event_type: 'new_year', date: `${year}-12-31`, pre_days: 5, post_days: 3, demand: 'moderate_peak', cpc_pressure: 'moderate' },
  ];
}

function getLastFridayOfNovember(year) {
  const lastDay = new Date(year, 11, 0); // last day of november
  const d = new Date(year, 10, lastDay.getDate());
  while (d.getDay() !== 5) d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

function getCyberMonday(year) {
  const bf = new Date(getLastFridayOfNovember(year));
  bf.setDate(bf.getDate() + 3);
  return bf.toISOString().slice(0, 10);
}

function getSecondSunday(year, month) { // month: 1-12
  const d = new Date(year, month - 1, 1);
  let sundays = 0;
  while (sundays < 2) {
    if (d.getDay() === 0) sundays++;
    if (sundays < 2) d.setDate(d.getDate() + 1);
  }
  return d.toISOString().slice(0, 10);
}

// ─── Classificação de período sazonal ─────────────────────────────────────────

function classifyDate(dateStr, baseCalendar, customEvents) {
  const date = new Date(dateStr + 'T12:00:00');
  const dayOfWeek = date.getDay(); // 0=Dom, 6=Sab
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
  const isSaturday = dayOfWeek === 6;
  const isSunday = dayOfWeek === 0;

  const dom = parseInt(dateStr.slice(8, 10));
  const month = parseInt(dateStr.slice(5, 7));
  const isStartOfMonth = dom <= 5;
  const isEndOfMonth = dom >= 26;
  const isPaydayWeek = dom >= 4 && dom <= 10; // semana de pagamento típica BR

  const matchedEvents = [];
  const allEvents = [...baseCalendar, ...customEvents];

  for (const ev of allEvents) {
    const evDate = new Date((ev.peak_date || ev.date) + 'T12:00:00');
    const preDays = ev.pre_days || ev.pre_event_days || 0;
    const postDays = ev.post_days || ev.post_event_days || 0;
    const endDate = ev.end ? new Date(ev.end + 'T12:00:00') : evDate;

    const windowStart = new Date(evDate.getTime() - preDays * 86400000);
    const windowEnd = new Date(endDate.getTime() + postDays * 86400000);

    if (date >= windowStart && date <= windowEnd) {
      const daysToEvent = Math.round((evDate.getTime() - date.getTime()) / 86400000);
      let phase = 'active';
      if (daysToEvent > 0) phase = 'pre_event';
      else if (daysToEvent < 0 && date > endDate) phase = 'post_event';

      matchedEvents.push({
        name: ev.name,
        event_type: ev.event_type,
        phase,
        days_to_event: daysToEvent,
        demand: ev.demand || ev.expected_demand_level || 'normal',
        cpc_pressure: ev.cpc_pressure || ev.expected_cpc_pressure || 'none',
        bid_multiplier_limit: ev.bid_multiplier_limit || 1.05,
        budget_multiplier_limit: ev.budget_multiplier_limit || 1.10,
      });
    }
  }

  // Ordenar por prioridade de demanda
  const demandPriority = { very_high_peak: 5, high_peak: 4, moderate_peak: 3, normal: 2, uncertain: 1, low_demand: 0 };
  matchedEvents.sort((a, b) => (demandPriority[b.demand] || 0) - (demandPriority[a.demand] || 0));

  const primaryEvent = matchedEvents[0] || null;
  const demandLevel = primaryEvent?.demand || (isWeekend ? 'uncertain' : 'normal');
  const cpcPressure = primaryEvent?.cpc_pressure || 'none';

  return {
    date: dateStr,
    day_of_week: dayOfWeek,
    day_name: ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'][dayOfWeek],
    is_weekend: isWeekend,
    is_saturday: isSaturday,
    is_sunday: isSunday,
    is_holiday: matchedEvents.some(e => e.event_type === 'holiday'),
    is_pre_holiday: matchedEvents.some(e => e.phase === 'pre_event' && e.event_type === 'holiday'),
    is_post_holiday: matchedEvents.some(e => e.phase === 'post_event' && e.event_type === 'holiday'),
    is_start_of_month: isStartOfMonth,
    is_end_of_month: isEndOfMonth,
    is_payday_week: isPaydayWeek,
    matched_events: matchedEvents,
    primary_event: primaryEvent ? primaryEvent.name : null,
    primary_event_type: primaryEvent ? primaryEvent.event_type : null,
    seasonal_phase: primaryEvent ? primaryEvent.phase : 'normal',
    expected_demand_level: demandLevel,
    expected_cpc_pressure: cpcPressure,
    bid_multiplier_limit: primaryEvent?.bid_multiplier_limit || 1.0,
    budget_multiplier_limit: primaryEvent?.budget_multiplier_limit || 1.0,
    has_strong_event: ['very_high_peak', 'high_peak'].includes(demandLevel),
    has_moderate_event: demandLevel === 'moderate_peak',
    is_low_demand: demandLevel === 'low_demand',
  };
}

// ─── Cálculo do seasonality_score ────────────────────────────────────────────

function calculateSeasonalityScore(ctx, metricsCtx) {
  // Componentes (0-100 cada, peso somam 100)
  const components = [];

  // 1. Demanda esperada (25 pts)
  const demandScore = {
    very_high_peak: 25, high_peak: 20, moderate_peak: 14,
    normal: 10, uncertain: 5, low_demand: 0
  }[ctx.expected_demand_level] || 10;
  components.push({ name: 'demand_level', score: demandScore, weight: 25 });

  // 2. Histórico real de aumento de demanda na data (20 pts)
  // Se as métricas mostram impressões/cliques acima da média = evidência real
  let historicalScore = 10; // neutro por padrão
  if (metricsCtx) {
    const { current_impressions, avg_impressions, current_clicks, avg_clicks, current_orders, avg_orders } = metricsCtx;
    if (current_impressions > avg_impressions * 1.2) historicalScore += 5;
    if (current_clicks > avg_clicks * 1.2) historicalScore += 5;
    if (current_orders > avg_orders * 1.2) historicalScore += 10;
    historicalScore = Math.min(20, historicalScore);
  }
  components.push({ name: 'real_demand_evidence', score: historicalScore, weight: 20 });

  // 3. Pressão de CPC (penalidade — 15 pts invertidos)
  const cpcPenalty = { none: 15, low: 12, moderate: 8, high: 3, very_high: 0 }[ctx.expected_cpc_pressure] || 8;
  components.push({ name: 'cpc_risk', score: cpcPenalty, weight: 15 });

  // 4. Janela temporal (15 pts — pré-evento tem mais oportunidade que pós)
  let temporalScore = 10;
  if (ctx.seasonal_phase === 'pre_event') temporalScore = 15;
  else if (ctx.seasonal_phase === 'active') temporalScore = 12;
  else if (ctx.seasonal_phase === 'post_event') temporalScore = 5;
  components.push({ name: 'temporal_window', score: temporalScore, weight: 15 });

  // 5. Estoque suficiente (15 pts)
  let stockScore = 10;
  if (metricsCtx?.stock_days != null) {
    if (metricsCtx.stock_days >= 30) stockScore = 15;
    else if (metricsCtx.stock_days >= 14) stockScore = 10;
    else if (metricsCtx.stock_days >= 7) stockScore = 5;
    else stockScore = 0;
  }
  components.push({ name: 'stock_adequacy', score: stockScore, weight: 15 });

  // 6. Fim de semana com evidência real (10 pts)
  let weekendScore = 5;
  if (ctx.is_weekend && metricsCtx?.weekend_performs_better) weekendScore = 10;
  else if (ctx.is_weekend && metricsCtx?.weekend_performs_better === false) weekendScore = 0;
  components.push({ name: 'weekend_evidence', score: weekendScore, weight: 10 });

  // Calcular score ponderado (normalizado para 0-100)
  const totalWeight = components.reduce((s, c) => s + c.weight, 0);
  const rawScore = components.reduce((s, c) => s + (c.score / c.weight) * c.weight, 0);
  const score = Math.round(Math.min(100, Math.max(0, rawScore / totalWeight * 100)));

  return { score, components };
}

// ─── Estratégia de ajuste sazonal ────────────────────────────────────────────

function buildSeasonalStrategy(ctx, seasonalityScore, performanceMetrics) {
  const strategy = {
    allow_bid_increase: false,
    allow_budget_increase: false,
    allow_top_of_search: false,
    allow_campaign_creation: true,
    allow_keyword_creation: true,
    reduce_bid_weekend: false,
    protect_budget_for_weekday: false,
    require_confidence: 90, // padrão
    max_bid_increase_pct: 0,
    max_budget_increase_pct: 0,
    seasonal_adjustment_applied: false,
    seasonal_reason: 'Período normal, sem ajuste sazonal.',
    warnings: [],
    recommendations: [],
  };

  const {
    acos_ok, roas_ok, cpc_ok, tacos_ok, has_sales, has_stock,
    acos, roas, cpc, orders, stock_days
  } = performanceMetrics || {};

  const isStrongEvent = ctx.has_strong_event;
  const isModerateEvent = ctx.has_moderate_event;
  const isPreEvent = ctx.seasonal_phase === 'pre_event';
  const isWeekend = ctx.is_weekend;
  const isHoliday = ctx.is_holiday;
  const isLowDemand = ctx.is_low_demand;

  // REGRA SOBERANA: Economy First — nunca aumentar sem performance real
  const hasRealPerformance = has_sales && acos_ok && roas_ok && cpc_ok;
  const hasAdequateStock = has_stock && (stock_days == null || stock_days >= 7);

  // ── Estratégia para datas fortes com pré-evento ──
  if (isStrongEvent && isPreEvent && hasRealPerformance && hasAdequateStock) {
    strategy.allow_bid_increase = true;
    strategy.allow_budget_increase = true;
    strategy.max_bid_increase_pct = Math.min(5, ctx.bid_multiplier_limit * 5);
    strategy.max_budget_increase_pct = Math.min(15, ctx.budget_multiplier_limit * 15);
    strategy.seasonal_adjustment_applied = true;
    strategy.seasonal_reason = `Pré-evento forte (${ctx.primary_event}) com performance real. Aumento controlado permitido.`;
    strategy.recommendations.push(`Priorizar campanhas com histórico de venda para ${ctx.primary_event}.`);
    strategy.recommendations.push('Verificar estoque antes de escalar. Evitar produtos com risco de ruptura.');
  } else if (isStrongEvent && isPreEvent && !hasRealPerformance) {
    strategy.seasonal_reason = `Pré-evento forte (${ctx.primary_event}), mas sem performance real. Economia mantida.`;
    strategy.warnings.push('Evento sazonal forte detectado, mas performance não justifica aumento.');
    strategy.recommendations.push('Revisar termos de busca, segmentação e landing page.');
  }

  // ── Estratégia para eventos ativos ──
  if (isStrongEvent && ctx.seasonal_phase === 'active' && hasRealPerformance && hasAdequateStock) {
    strategy.allow_bid_increase = true;
    strategy.max_bid_increase_pct = Math.min(5, ctx.bid_multiplier_limit * 4);
    strategy.allow_top_of_search = roas_ok && acos_ok;
    strategy.seasonal_adjustment_applied = true;
    strategy.seasonal_reason = `Evento ativo: ${ctx.primary_event}. Performance real validada.`;
  }

  // ── Estratégia para feriados ──
  if (isHoliday) {
    strategy.require_confidence = 92; // mais conservador em feriado
    if (!hasRealPerformance) {
      strategy.allow_bid_increase = false;
      strategy.allow_budget_increase = false;
      strategy.seasonal_reason = 'Feriado sem performance real. Nenhum aumento automático.';
      strategy.warnings.push('Feriado detectado. Exigindo confidence >= 92 para qualquer ação.');
    } else {
      strategy.recommendations.push('Feriado com performance. Monitorar abandono de carrinho pós-feriado.');
    }
  }

  // ── Estratégia para fins de semana ──
  if (isWeekend && performanceMetrics) {
    const { weekend_performs_better, weekend_acos_ok } = performanceMetrics;
    if (weekend_performs_better && weekend_acos_ok) {
      strategy.allow_bid_increase = hasRealPerformance;
      strategy.max_bid_increase_pct = Math.max(strategy.max_bid_increase_pct, hasRealPerformance ? 3 : 0);
      strategy.seasonal_adjustment_applied = true;
      strategy.seasonal_reason = (strategy.seasonal_reason || '') + ' Fim de semana com conversão superior à média.';
      strategy.recommendations.push('Preservar budget para blocos de alta conversão no fim de semana.');
    } else if (weekend_performs_better === false) {
      strategy.reduce_bid_weekend = true;
      strategy.protect_budget_for_weekday = true;
      strategy.allow_bid_increase = false;
      strategy.allow_budget_increase = false;
      strategy.allow_top_of_search = false;
      strategy.seasonal_adjustment_applied = true;
      strategy.seasonal_reason = 'Fim de semana com histórico de gasto sem conversão. Redução de bid recomendada.';
      strategy.recommendations.push('Preservar budget para dias úteis onde conversão é superior.');
      strategy.warnings.push('Domingo/Sábado com ACoS ruim histórico — bloquear Top of Search.');
    }
  }

  // ── Baixa demanda: reduzir agressividade ──
  if (isLowDemand) {
    strategy.allow_bid_increase = false;
    strategy.allow_budget_increase = false;
    strategy.allow_top_of_search = false;
    strategy.seasonal_adjustment_applied = true;
    strategy.seasonal_reason = 'Período de baixa demanda identificado. Conservar orçamento.';
    strategy.recommendations.push('Focar em manutenção e otimização de termos, não em escala.');
  }

  // ── Pressão de CPC sazonal ──
  if (['high', 'very_high'].includes(ctx.expected_cpc_pressure)) {
    if (!hasRealPerformance || !cpc_ok) {
      strategy.allow_bid_increase = false;
      strategy.allow_top_of_search = false;
      strategy.warnings.push(`Alta pressão de CPC esperada (${ctx.expected_cpc_pressure}) sem conversão compensatória. Proteger orçamento.`);
    } else {
      strategy.recommendations.push('CPC pode subir. Tolerar somente se ACoS e ROAS mantiverem-se dentro do máximo.');
    }
  }

  // ── Estoque baixo: bloquear escala ──
  if (!hasAdequateStock && (isStrongEvent || isModerateEvent)) {
    strategy.allow_bid_increase = false;
    strategy.allow_budget_increase = false;
    strategy.allow_top_of_search = false;
    strategy.warnings.push('Evento sazonal detectado, mas estoque insuficiente. Escala bloqueada para evitar ruptura.');
    strategy.recommendations.push('Priorizar produtos com estoque suficiente. Reduzir exposição de ASINs com risco de ruptura.');
  }

  // Garantir que seasonality_score alto não eleve ação ruim
  if (seasonalityScore < 50) {
    strategy.allow_bid_increase = false;
    strategy.allow_budget_increase = false;
    if (!strategy.seasonal_reason.includes('baixa') && !strategy.seasonal_reason.includes('Economy')) {
      strategy.seasonal_reason += ' Seasonality score insuficiente para autorizar ação.';
    }
  }

  return strategy;
}

// ─── Handler principal ────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const {
      amazon_account_id,
      date: targetDateRaw,
      performance_metrics, // { acos, roas, cpc, tacos, orders, stock_days, acos_ok, roas_ok, cpc_ok, tacos_ok, has_sales, has_stock, weekend_performs_better, weekend_acos_ok, current_impressions, avg_impressions, current_clicks, avg_clicks, current_orders, avg_orders }
    } = body;

    if (!amazon_account_id) return Response.json({ error: 'amazon_account_id obrigatório' }, { status: 400 });

    const targetDate = targetDateRaw || new Date().toISOString().slice(0, 10);
    const year = parseInt(targetDate.slice(0, 4));

    // Carregar calendário customizado da conta
    const customEvents = await base44.asServiceRole.entities.SeasonalityCalendar.filter({
      amazon_account_id,
      enabled: true,
    }).catch(() => []);

    // Montar calendário base BR
    const baseCalendar = getBrazilBaseCalendar(year);
    // Incluir também ano anterior/próximo para cobertura de datas de virada
    const baseCalendarPrev = getBrazilBaseCalendar(year - 1);
    const baseCalendarNext = getBrazilBaseCalendar(year + 1);
    const fullBase = [...baseCalendarPrev, ...baseCalendar, ...baseCalendarNext];

    // Classificar a data alvo
    const ctx = classifyDate(targetDate, fullBase, customEvents);

    // Calcular seasonality_score
    const { score: seasonalityScore, components: scoreComponents } = calculateSeasonalityScore(ctx, performance_metrics);

    // Construir estratégia
    const strategy = buildSeasonalStrategy(ctx, seasonalityScore, performance_metrics || {});

    // Resultado completo
    const result = {
      // Contexto da data
      date: targetDate,
      is_weekend: ctx.is_weekend,
      is_saturday: ctx.is_saturday,
      is_sunday: ctx.is_sunday,
      is_holiday: ctx.is_holiday,
      is_pre_holiday: ctx.is_pre_holiday,
      is_post_holiday: ctx.is_post_holiday,
      is_start_of_month: ctx.is_start_of_month,
      is_end_of_month: ctx.is_end_of_month,
      is_payday_week: ctx.is_payday_week,
      day_name: ctx.day_name,

      // Evento sazonal principal
      seasonal_event_name: ctx.primary_event,
      seasonal_phase: ctx.seasonal_phase,
      expected_demand_level: ctx.expected_demand_level,
      expected_cpc_pressure: ctx.expected_cpc_pressure,
      matched_events: ctx.matched_events,

      // Score sazonal
      seasonality_score: seasonalityScore,
      seasonality_score_components: scoreComponents,

      // Estratégia determinística
      strategy,

      // Campos para registro em decisões (formato padronizado)
      seasonality_context: {
        is_weekend: ctx.is_weekend,
        is_holiday: ctx.is_holiday,
        seasonal_event_name: ctx.primary_event,
        seasonal_phase: ctx.seasonal_phase,
        seasonality_score: seasonalityScore,
        expected_demand_level: ctx.expected_demand_level,
        expected_cpc_pressure: ctx.expected_cpc_pressure,
        seasonal_adjustment_applied: strategy.seasonal_adjustment_applied,
        seasonal_reason: strategy.seasonal_reason,
      },
    };

    return Response.json({ ok: true, data: result });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});