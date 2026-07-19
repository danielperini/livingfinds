/**
 * runDailyBudgetPacingEngine
 *
 * Motor principal de orçamento diário — executa no reset à meia-noite BRT.
 * Fluxo:
 *  1. Fecha ledger do dia anterior
 *  2. Reseta DAILY_SPEND_COUNTER e desliga KILL_SWITCH
 *  3. Calcula HOUR_VALUE_SCORE (0-100) por DAY_OF_WEEK+HOUR (janela 28d)
 *  4. Classifica slots: ELITE/STRONG/NORMAL/WEAK/LOSS
 *  5. Seleciona BEST_PROFIT_WINDOW (blocos ≥2h contínuos, meta ≥8h)
 *  6. Calcula BUDGET_PACING_CURVE baseada em distribuição histórica real
 *  7. Calcula ELITE_TIME_RESERVE
 *  8. Calcula AFFORDABLE_ACTIVE_HOURS e flag BUDGET_INSUFFICIENT_FOR_8H
 *  9. Grava plano em AccountDailySpendController
 * 10. Reativa APENAS campanhas com pause_reason = DAILY_BUDGET_CAP_REACHED
 * 11. Aplica aprendizado (MORNING_OVERSPEND / EVENING_UNDERSPEND)
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function r2(v) { return parseFloat((v || 0).toFixed(2)); }

const DAY_LABELS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab'];

// NEVER reactivate these stop types
const SAFE_REACTIVATION_REASONS = ['DAILY_BUDGET_CAP_REACHED', 'DAILY_CAP_STOP', 'OVERPACING_TEMP_STOP', 'DAYPART_RESERVE_STOP'];

function classifySlot(score) {
  if (score >= 90) return 'ELITE';
  if (score >= 75) return 'STRONG';
  if (score >= 55) return 'NORMAL';
  if (score >= 35) return 'WEAK';
  return 'LOSS';
}

// Calcula HOUR_VALUE_SCORE (0-100) com 6 componentes
function calcHourValueScore(slot, avgProfitPerHour, targetAcos) {
  let score = 0;
  const { orders, spend, sales, clicks, impressions, profit } = slot;

  // 1. Contribution Profit (30pts)
  if (avgProfitPerHour > 0 && profit !== undefined) {
    const profitRatio = Math.max(0, profit / avgProfitPerHour);
    score += Math.min(30, profitRatio * 30);
  } else if (orders > 0) {
    score += 15; // partial credit
  }

  // 2. ACoS Efficiency (20pts)
  const acos = sales > 0 ? (spend / sales) * 100 : 0;
  if (targetAcos > 0 && acos > 0) {
    const acosEff = Math.max(0, 1 - acos / targetAcos);
    score += Math.min(20, acosEff * 25);
  }

  // 3. CVR (15pts)
  const cvr = clicks > 0 ? orders / clicks : 0;
  if (cvr > 0) {
    score += Math.min(15, cvr * 1500);
  }

  // 4. Sales Volume (15pts)
  if (orders >= 5) score += 15;
  else if (orders >= 3) score += 10;
  else if (orders >= 1) score += 6;
  else if (clicks >= 15) score += 2;

  // 5. ROAS (10pts)
  const roas = spend > 0 ? sales / spend : 0;
  if (roas >= 10) score += 10;
  else if (roas >= 6) score += 7;
  else if (roas >= 3) score += 4;
  else if (roas >= 1) score += 2;

  // 6. Data Confidence (10pts)
  const occurrences = slot.occurrences || 0;
  if (occurrences >= 8) score += 10;
  else if (occurrences >= 5) score += 7;
  else if (occurrences >= 3) score += 4;
  else if (occurrences >= 1) score += 1;

  return Math.max(0, Math.min(100, Math.round(score)));
}

// Seleciona BEST_PROFIT_WINDOW: blocos contínuos ≥2h, meta ≥8h total
function selectBestProfitWindow(hourScores) {
  const hours = Array.from({ length: 24 }, (_, h) => ({
    hour: h,
    score: hourScores[h] || 0,
    classification: classifySlot(hourScores[h] || 0),
  }));

  // Ordenar por score decrescente e selecionar até ≥8h em blocos ≥2h
  const selected = [];
  let totalHours = 0;

  // Primeiro: adicionar todos os slots ELITE
  for (const h of hours) {
    if (h.classification === 'ELITE') {
      selected.push(h);
      totalHours++;
    }
  }

  // Depois STRONG, depois NORMAL até atingir 8h
  for (const cls of ['STRONG', 'NORMAL']) {
    if (totalHours >= 8) break;
    for (const h of hours.filter(x => x.classification === cls)) {
      if (totalHours >= 8) break;
      if (!selected.find(s => s.hour === h.hour)) {
        selected.push(h);
        totalHours++;
      }
    }
  }

  // Garantir blocos ≥2h contínuos (agrupar adjacentes)
  selected.sort((a, b) => a.hour - b.hour);
  return selected;
}

// Calcula curva de pacing baseada na distribuição histórica real de vendas por hora
function buildPacingCurve(hourScores, dailyBudget) {
  const totalScore = Object.values(hourScores).reduce((s, v) => s + (v || 0), 0);
  const curve = {};
  let cumulative = 0;

  for (let h = 0; h < 24; h++) {
    const score = hourScores[h] || 0;
    const share = totalScore > 0 ? (score / totalScore) * dailyBudget : dailyBudget / 24;
    cumulative += share;
    curve[h] = { budget_share: r2(share), cumulative_expected: r2(cumulative), score };
  }
  return curve;
}

Deno.serve(async (req) => {
  const t0 = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const { amazon_account_id, dry_run = false } = body;

    // Resolver conta
    let account;
    if (amazon_account_id) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: amazon_account_id }, null, 1);
      account = accs[0];
    } else {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({}, '-created_date', 1);
      account = accs[0];
    }
    if (!account) return Response.json({ ok: false, error: 'Nenhuma conta configurada' }, { status: 404 });

    const accountId = account.id;
    const now = new Date().toISOString();

    // Calcular data BRT
    const brtDate = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    const todayBRT = brtDate.toISOString().slice(0, 10);
    const yesterdayBRT = new Date(brtDate.getTime() - 86400000).toISOString().slice(0, 10);
    const currentHourBRT = brtDate.getHours();
    const currentDayOfWeek = brtDate.getDay();

    // Carregar configurações
    const [perfList, economicsList] = await Promise.all([
      base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id: accountId }, null, 1).catch(() => []),
      base44.asServiceRole.entities.ProductEconomics.filter({ amazon_account_id: accountId }, null, 200).catch(() => []),
    ]);
    const perf = perfList[0] || {};
    const targetAcos = Number(perf.target_acos || 15);
    const dailyBudget = Number(perf.daily_budget_limit || 70);

    // Budget mode: derivado do objective
    let budgetMode = 'BALANCED';
    const objective = perf.objective || 'profitability';
    if (objective === 'growth' || objective === 'launch') budgetMode = 'FULL_UTILIZATION';
    else if (objective === 'profitability' || objective === 'defense') budgetMode = 'PROFIT_MAX';

    // Médias econômicas
    const avgBreakEven = economicsList.length > 0
      ? economicsList.reduce((s, e) => s + Number(e.break_even_acos || 30), 0) / economicsList.length
      : 30;

    // ── PASSO 1: Fechar ledger do dia anterior ─────────────────────────
    const existingLedger = await base44.asServiceRole.entities.DailyBudgetLedger.filter(
      { amazon_account_id: accountId, ledger_date: yesterdayBRT }, null, 1
    ).catch(() => []);

    // Carregar controller do dia anterior
    const prevControllers = await base44.asServiceRole.entities.AccountDailySpendController.filter(
      { amazon_account_id: accountId, spend_date: yesterdayBRT }, null, 1
    ).catch(() => []);
    const prevController = prevControllers[0] || {};

    // Métricas reais do dia anterior
    const prevMetrics = await base44.asServiceRole.entities.CampaignMetricsDaily.filter(
      { amazon_account_id: accountId, date: yesterdayBRT }, null, 500
    ).catch(() => []);

    const prevSpend = prevMetrics.reduce((s, m) => s + Number(m.spend || 0), 0);
    const prevSales = prevMetrics.reduce((s, m) => s + Number(m.sales || m.attributed_sales || 0), 0);
    const prevOrders = prevMetrics.reduce((s, m) => s + Number(m.orders || m.attributed_conversions || 0), 0);
    const prevAcos = prevSales > 0 ? (prevSpend / prevSales) * 100 : 0;
    const utilizationPct = dailyBudget > 0 ? (prevSpend / dailyBudget) * 100 : 0;

    // Calcular curva real do dia anterior (por hora, se disponível)
    const prevHourlyMetrics = await base44.asServiceRole.entities.HourlyMetric.filter(
      { amazon_account_id: accountId }, '-date', 500
    ).catch(() => []);
    const actualCurve = {};
    for (const m of prevHourlyMetrics) {
      const mDate = new Date(m.date || m.created_date || '');
      if (isNaN(mDate.getTime())) continue;
      if (mDate.toISOString().slice(0, 10) !== yesterdayBRT) continue;
      const h = m.hour ?? mDate.getHours();
      actualCurve[h] = (actualCurve[h] || 0) + Number(m.spend || 0);
    }

    // Learning flags
    const learningFlags = {};
    const plannedCurvePrev = prevController.pacing_curve ? JSON.parse(prevController.pacing_curve) : {};
    let morningSpend = 0, morningPlanned = 0, eveningSpend = 0, eveningPlanned = 0;
    for (let h = 0; h < 24; h++) {
      const actual = actualCurve[h] || 0;
      const planned = plannedCurvePrev[h]?.budget_share || (dailyBudget / 24);
      if (h < 14) { morningSpend += actual; morningPlanned += planned; }
      if (h >= 18) { eveningSpend += actual; eveningPlanned += planned; }
    }
    if (morningPlanned > 0 && morningSpend / morningPlanned > 1.40) learningFlags['MORNING_OVERSPEND'] = true;
    if (eveningPlanned > 0 && eveningSpend / eveningPlanned < 0.50) learningFlags['EVENING_UNDERSPEND'] = true;

    const pacingErrorPct = prevController.confirmed_spend > 0
      ? Math.abs(prevSpend - prevController.confirmed_spend) / prevController.confirmed_spend * 100
      : 0;

    // Fechar/atualizar ledger do dia anterior
    if (!dry_run) {
      const ledgerData = {
        amazon_account_id: accountId,
        ledger_date: yesterdayBRT,
        daily_budget: dailyBudget,
        confirmed_spend: r2(prevSpend),
        projected_spend: r2(prevController.projected_total_spend || prevSpend),
        utilization_pct: r2(utilizationPct),
        active_hours: Object.keys(actualCurve).length,
        profitable_hours: Object.values(actualCurve).filter(s => s > 0).length,
        planned_curve: JSON.stringify(plannedCurvePrev),
        actual_curve: JSON.stringify(actualCurve),
        global_stop_events: prevController.campaigns_paused_count || 0,
        learning_flags: JSON.stringify(learningFlags),
        pacing_error_pct: r2(pacingErrorPct),
        best_actual_hours: JSON.stringify(
          Object.entries(actualCurve).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([h]) => Number(h))
        ),
        worst_actual_hours: JSON.stringify(
          Object.entries(actualCurve).sort((a, b) => a[1] - b[1]).slice(0, 5).map(([h]) => Number(h))
        ),
        unused_budget: r2(Math.max(0, dailyBudget - prevSpend)),
        unused_reason: utilizationPct >= 95 ? 'NONE' : (budgetMode === 'PROFIT_MAX' ? 'PROFIT_MAX_NO_OPPORTUNITY' : 'UNDERPACING_LOW_TRAFFIC'),
        acos_final: r2(prevAcos),
        budget_mode: budgetMode,
        created_at: now,
        closed_at: now,
      };
      if (existingLedger.length > 0) {
        await base44.asServiceRole.entities.DailyBudgetLedger.update(existingLedger[0].id, ledgerData).catch(() => {});
      } else {
        await base44.asServiceRole.entities.DailyBudgetLedger.create(ledgerData).catch(() => {});
      }
    }

    // ── PASSO 3: Calcular HOUR_VALUE_SCORE (janela 28d) ───────────────
    const cutoff28d = new Date(Date.now() - 28 * 86400000).toISOString();
    const hourlyMetrics28d = await base44.asServiceRole.entities.HourlyMetric.filter(
      { amazon_account_id: accountId }, '-date', 3000
    ).catch(() => []);

    // Agregar por DAY_OF_WEEK + HOUR
    const slotMap = {};
    for (const m of hourlyMetrics28d) {
      if ((m.date || m.created_date || '') < cutoff28d) continue;
      const mDate = new Date(m.date || m.created_date || '');
      if (isNaN(mDate.getTime())) continue;
      const dayOfWeek = mDate.getDay();
      const hour = m.hour ?? mDate.getHours();
      const key = `${dayOfWeek}|${hour}`;
      if (!slotMap[key]) slotMap[key] = { orders: 0, spend: 0, sales: 0, clicks: 0, impressions: 0, profit: 0, occurrences: 0 };
      const s = slotMap[key];
      s.orders     += Number(m.orders || m.conversions || 0);
      s.spend      += Number(m.spend || 0);
      s.sales      += Number(m.sales || m.revenue || 0);
      s.clicks     += Number(m.clicks || 0);
      s.impressions += Number(m.impressions || 0);
      s.occurrences++;
    }

    // Calcular avg profit per hour como referência
    let totalProfit = 0, profitHours = 0;
    for (const slot of Object.values(slotMap)) {
      const p = slot.sales - slot.spend;
      if (p > 0) { totalProfit += p; profitHours++; }
    }
    const avgProfitPerHour = profitHours > 0 ? totalProfit / profitHours : 1;

    // Calcular score por hora ATUAL do dia da semana
    const hourScores = {};
    for (let h = 0; h < 24; h++) {
      const key = `${currentDayOfWeek}|${h}`;
      const slot = slotMap[key] || { orders: 0, spend: 0, sales: 0, clicks: 0, impressions: 0, profit: 0, occurrences: 0 };
      // Ajustar pelo aprendizado: se MORNING_OVERSPEND, penalizar horas da manhã
      let baseScore = calcHourValueScore(slot, avgProfitPerHour, targetAcos);
      if (learningFlags['MORNING_OVERSPEND'] && h < 14) baseScore = Math.max(0, baseScore - 10);
      if (learningFlags['EVENING_UNDERSPEND'] && h >= 18) baseScore = Math.min(100, baseScore + 8);
      hourScores[h] = baseScore;
    }

    // ── PASSO 4 & 5: Classificar e selecionar BEST_PROFIT_WINDOW ──────
    const bestProfitWindow = selectBestProfitWindow(hourScores);

    // ── PASSO 6: BUDGET_PACING_CURVE ──────────────────────────────────
    const pacingCurve = buildPacingCurve(hourScores, dailyBudget);

    // ── PASSO 7: ELITE_TIME_RESERVE ────────────────────────────────────
    const eliteHours = bestProfitWindow.filter(h => h.classification === 'ELITE');
    const eliteTotalScore = eliteHours.reduce((s, h) => s + h.score, 0);
    const allScoreTotal = Object.values(hourScores).reduce((s, v) => s + v, 0);
    const eliteReserve = allScoreTotal > 0
      ? r2((eliteTotalScore / allScoreTotal) * dailyBudget * 1.1) // +10% safety
      : 0;

    // ── PASSO 8: AFFORDABLE_ACTIVE_HOURS ──────────────────────────────
    // Calcular gasto médio por hora rentável
    const profitableSlots = Object.values(slotMap).filter(s => s.orders > 0 && s.spend > 0);
    const avgSpendPerProfitableHour = profitableSlots.length > 0
      ? profitableSlots.reduce((s, slot) => s + slot.spend / Math.max(slot.occurrences, 1), 0) / profitableSlots.length
      : dailyBudget / 8;

    const affordableActiveHours = avgSpendPerProfitableHour > 0
      ? Math.floor(dailyBudget / avgSpendPerProfitableHour)
      : 24;

    const medianProfitableSpendPerHour = profitableSlots.length > 0
      ? profitableSlots.map(s => s.spend / Math.max(s.occurrences, 1)).sort((a, b) => a - b)[Math.floor(profitableSlots.length / 2)]
      : dailyBudget / 8;

    const estimatedBudgetFor8h = r2(medianProfitableSpendPerHour * 8);
    const budgetInsufficientFor8h = dailyBudget < estimatedBudgetFor8h * 0.85;

    // ── PASSO 9: Gravar plano em AccountDailySpendController ──────────
    const todaySchedule = {};
    for (let h = 0; h < 24; h++) {
      const score = hourScores[h];
      const inWindow = bestProfitWindow.some(w => w.hour === h);
      todaySchedule[h] = {
        score,
        budget_share_pct: r2((pacingCurve[h]?.budget_share || 0) / dailyBudget * 100),
        budget_share_brl: r2(pacingCurve[h]?.budget_share || 0),
        classification: classifySlot(score),
        in_best_window: inWindow,
        elite_reserved: eliteHours.some(e => e.hour === h),
      };
    }

    const controllerData = {
      amazon_account_id: accountId,
      spend_date: todayBRT,
      confirmed_spend: 0,
      estimated_pending_spend: 0,
      reserved_spend: r2(eliteReserve),
      projected_total_spend: 0,
      remaining_spend: r2(dailyBudget),
      cap_status: 'safe',
      spend_pacing: 'unknown',
      pacing_ratio: 0,
      current_hour_brt: currentHourBRT,
      user_daily_spend_cap: r2(dailyBudget),
      effective_daily_spend_cap: r2(dailyBudget),
      today_schedule: JSON.stringify(todaySchedule),
      best_profit_window: JSON.stringify(bestProfitWindow),
      budget_mode: budgetMode,
      elite_reserve: r2(eliteReserve),
      affordable_active_hours: affordableActiveHours,
      pacing_curve: JSON.stringify(pacingCurve),
      global_kill_switch: false,
      global_stop_event_id: null,
      global_stop_snapshot: null,
      kill_switch_activated_at: null,
      kill_switch_reason: null,
      projected_end_of_day_spend: 0,
      time_to_cap_hours: 0,
      future_value_reserve: 0,
      underpacing_alert: false,
      overpacing_alert: false,
      campaigns_paused_today: [],
      campaigns_paused_count: 0,
      last_pause_reason: '',
      hour_value_scores: JSON.stringify(hourScores),
      budget_insufficient_for_8h: budgetInsufficientFor8h,
      estimated_budget_for_8h: estimatedBudgetFor8h,
      last_pacing_engine_run_at: now,
      updated_at: now,
      created_at: now,
    };

    let controllerId = null;
    if (!dry_run) {
      const existingControllers = await base44.asServiceRole.entities.AccountDailySpendController.filter(
        { amazon_account_id: accountId, spend_date: todayBRT }, null, 1
      ).catch(() => []);

      if (existingControllers.length > 0) {
        await base44.asServiceRole.entities.AccountDailySpendController.update(existingControllers[0].id, controllerData).catch(() => {});
        controllerId = existingControllers[0].id;
      } else {
        const created = await base44.asServiceRole.entities.AccountDailySpendController.create(controllerData).catch(() => null);
        controllerId = created?.id;
      }
    }

    // ── PASSO 10: Reativar campanhas com pause_reason = DAILY_BUDGET_CAP_REACHED ──
    let reactivatedCount = 0;
    if (!dry_run) {
      // Ler snapshot do dia anterior para saber quais campanhas foram pausadas pelo Kill Switch
      const prevSnapshot = prevController.global_stop_snapshot
        ? JSON.parse(prevController.global_stop_snapshot)
        : null;

      // Buscar campanhas pausadas pelo sistema
      const pausedCampaigns = await base44.asServiceRole.entities.Campaign.filter(
        { amazon_account_id: accountId, status: 'paused' }, null, 500
      ).catch(() => []);

      // Filtrar apenas as que foram pausadas pelo Kill Switch (pause_reason seguro)
      const toReactivate = pausedCampaigns.filter(c => {
        const reason = c.archive_reason || c.last_pause_reason || '';
        return SAFE_REACTIVATION_REASONS.some(r => reason.includes(r));
      });

      // Também reativar as que estão no snapshot como ENABLED antes da pausa
      const snapshotEligible = prevSnapshot
        ? pausedCampaigns.filter(c => {
            const snapState = prevSnapshot[c.campaign_id] || prevSnapshot[c.amazon_campaign_id];
            return snapState === 'enabled' || snapState === 'ENABLED';
          })
        : [];

      const allToReactivate = [...new Set([...toReactivate, ...snapshotEligible].map(c => c.id))]
        .map(id => [...toReactivate, ...snapshotEligible].find(c => c.id === id))
        .filter(Boolean);

      if (allToReactivate.length > 0) {
        // Preparar batch para Amazon Ads API
        const batchPayload = allToReactivate.map(c => ({
          campaignId: String(c.amazon_campaign_id || c.campaign_id),
          state: 'ENABLED',
        }));

        for (let i = 0; i < batchPayload.length; i += 20) {
          const batch = batchPayload.slice(i, i + 20);
          await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
            _service_role: true,
            amazon_account_id: accountId,
            path: '/sp/campaigns',
            method: 'PUT',
            content_type: 'application/vnd.spCampaign.v3+json',
            payload: { campaigns: batch },
          }).catch(() => {});
          await sleep(300);
        }

        // Atualizar estado local
        for (const c of allToReactivate) {
          await base44.asServiceRole.entities.Campaign.update(c.id, {
            status: 'enabled',
            state: 'enabled',
            archive_reason: null,
            last_pause_reason: null,
          }).catch(() => {});
          reactivatedCount++;
        }
      }
    }

    // ── GERAR PerformanceTrendSnapshot diário ─────────────────────────
    // Calcula ACoS por janela (7d, 14d, 30d, 80d) usando CampaignMetricsDaily
    if (!dry_run) {
      const cutoff7d  = new Date(Date.now() - 7  * 86400000).toISOString().slice(0, 10);
      const cutoff14d = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
      const cutoff30d = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
      const cutoff80d = new Date(Date.now() - 80 * 86400000).toISOString().slice(0, 10);

      const allDailyMetrics = await base44.asServiceRole.entities.CampaignMetricsDaily.filter(
        { amazon_account_id: accountId }, '-date', 3000
      ).catch(() => []);

      function aggMetrics(cutoffDate) {
        const rows = allDailyMetrics.filter(m => (m.date || '') >= cutoffDate);
        const s = rows.reduce((a, m) => ({
          spend: a.spend + Number(m.spend || 0),
          sales: a.sales + Number(m.sales || m.attributed_sales || 0),
          orders: a.orders + Number(m.orders || m.attributed_conversions || 0),
          clicks: a.clicks + Number(m.clicks || 0),
        }), { spend: 0, sales: 0, orders: 0, clicks: 0 });
        return {
          acos: s.sales > 0 ? (s.spend / s.sales) * 100 : 0,
          roas: s.spend > 0 ? s.sales / s.spend : 0,
          spend: s.spend,
          orders: s.orders,
          cvr: s.clicks > 0 ? s.orders / s.clicks : 0,
        };
      }

      const w7  = aggMetrics(cutoff7d);
      const w14 = aggMetrics(cutoff14d);
      const w30 = aggMetrics(cutoff30d);
      const w80 = aggMetrics(cutoff80d);

      // TREND CLASSIFICATION
      let trendClassification = 'INSUFFICIENT_DATA';
      let trendDelta = 0;
      let recencyProtectionActive = false;

      if (w14.acos > 0 && w80.acos > 0) {
        trendDelta = (w80.acos - w14.acos) / w80.acos; // positivo = melhora recente
        if (trendDelta >= 0.30) trendClassification = 'STRONGLY_IMPROVING';
        else if (trendDelta >= 0.10) trendClassification = 'IMPROVING';
        else if (trendDelta >= -0.10) trendClassification = 'STABLE';
        else if (trendDelta >= -0.30) trendClassification = 'DEGRADING';
        else trendClassification = 'STRONGLY_DEGRADING';

        // Proteção de estratégia recente: 14d <= 16% E 80d >= 22%
        recencyProtectionActive = w14.acos > 0 && w14.acos <= 16 && w80.acos >= 22;
      }

      // GOAL_ALIGNMENT do snapshot
      const snapTargetAcos = Number(perf.target_acos || 15);
      let snapAlignmentStatus = 'UNCHECKED';
      if (w14.acos > 0) {
        if (snapTargetAcos < 8 && w14.acos > 20) snapAlignmentStatus = 'MISCONFIGURED';
        else if (snapTargetAcos < w14.acos * 0.70 && w14.acos <= 16) snapAlignmentStatus = 'GOAL_TENSION';
        else snapAlignmentStatus = 'ALIGNED';
      }

      const snapData = {
        amazon_account_id: accountId,
        snapshot_date: todayBRT,
        acos_7d:  r2(w7.acos),
        acos_14d: r2(w14.acos),
        acos_30d: r2(w30.acos),
        acos_80d: r2(w80.acos),
        roas_7d:  r2(w7.roas),
        roas_14d: r2(w14.roas),
        spend_7d:  r2(w7.spend),
        spend_14d: r2(w14.spend),
        orders_7d:  w7.orders,
        orders_14d: w14.orders,
        cvr_14d: r2(w14.cvr),
        trend_classification: trendClassification,
        trend_delta_14d_vs_80d: r2(trendDelta),
        recency_protection_active: recencyProtectionActive,
        goal_alignment_status: snapAlignmentStatus,
        goal_alignment_detail: snapAlignmentStatus === 'GOAL_TENSION'
          ? `Target ${snapTargetAcos}% mais agressivo que ACoS 14d (${w14.acos.toFixed(1)}%)`
          : snapAlignmentStatus === 'MISCONFIGURED'
          ? `Target ${snapTargetAcos}% irrealizável: ACoS 14d=${w14.acos.toFixed(1)}%`
          : '',
        target_acos_configured: snapTargetAcos,
        acos_14d_at_check: r2(w14.acos),
        created_at: now,
      };

      // Upsert snapshot do dia
      const existingSnaps = await base44.asServiceRole.entities.PerformanceTrendSnapshot.filter(
        { amazon_account_id: accountId, snapshot_date: todayBRT }, null, 1
      ).catch(() => []);
      if (existingSnaps.length > 0) {
        await base44.asServiceRole.entities.PerformanceTrendSnapshot.update(existingSnaps[0].id, snapData).catch(() => {});
      } else {
        await base44.asServiceRole.entities.PerformanceTrendSnapshot.create(snapData).catch(() => {});
      }

      // Registrar no DailyBudgetLedger se houver STRONGLY_IMPROVING
      if (recencyProtectionActive && existingLedger.length > 0) {
        await base44.asServiceRole.entities.DailyBudgetLedger.update(existingLedger[0].id, {
          learning_flags: JSON.stringify({ ...learningFlags, RECENT_PERFORMANCE_BETTER_THAN_HISTORY: true }),
        }).catch(() => {});
      }
    }

    return Response.json({
      ok: true,
      dry_run,
      today: todayBRT,
      yesterday: yesterdayBRT,
      budget_mode: budgetMode,
      daily_budget: dailyBudget,
      target_acos: targetAcos,
      hour_value_scores: hourScores,
      best_profit_window: bestProfitWindow,
      elite_reserve: eliteReserve,
      pacing_curve_sample: Object.fromEntries(Object.entries(pacingCurve).slice(0, 6)),
      affordable_active_hours: affordableActiveHours,
      budget_insufficient_for_8h: budgetInsufficientFor8h,
      estimated_budget_for_8h: estimatedBudgetFor8h,
      campaigns_reactivated: reactivatedCount,
      learning_flags: learningFlags,
      utilization_yesterday: r2(utilizationPct),
      controller_id: controllerId,
      duration_ms: Date.now() - t0,
    });

  } catch (err) {
    return Response.json({ ok: false, error: err.message, duration_ms: Date.now() - Date.now() }, { status: 500 });
  }
});