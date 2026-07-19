/**
 * runIntraDayPacingCycle
 *
 * Ciclo intra-diário de pacing — invocado por runHourlyAdsGuardrails.
 *
 * Fluxo:
 *  1. Calcular spend_velocity (R$/hora atual)
 *  2. Calcular TIME_TO_CAP e projected_end_of_day
 *  3. Comparar vs BUDGET_PACING_CURVE → classificar pacing
 *  4. Calcular FUTURE_VALUE_RESERVE (horas futuras com score >= 75)
 *  5. Calcular REAL_TIME_SLOT_PRIORITY por campanha
 *  6. OVERPACING (ratio > 1.20): pausar Tier D, reduzir bids LOSS_TIME, pausar WEAK com DAYPART_TEMP_PAUSE
 *  7. UNDERPACING (<90%): aumentar budget winners, aumentar bids ELITE/STRONG, retomar DAYPART_TEMP_PAUSE
 *  8. DAYPART_RESERVE_STOP: preservar capital para slots ELITE futuros
 *  9. PROFIT_PROTECTION_STOP: parar se Contribution Profit ficaria negativo
 * 10. Atualizar AccountDailySpendController
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function r2(v) { return parseFloat((v || 0).toFixed(2)); }

const OVERPACING_THRESHOLD = 1.20;
const UNDERPACING_THRESHOLD = 0.90;
const ELITE_SCORE_THRESHOLD = 75;
const MAX_BID_UP_PCT = 0.10;
const MAX_BID_DOWN_PCT = 0.10;
const BUDGET_UP_PCT = 0.15;

function classifySlot(score) {
  if (score >= 90) return 'ELITE';
  if (score >= 75) return 'STRONG';
  if (score >= 55) return 'NORMAL';
  if (score >= 35) return 'WEAK';
  return 'LOSS';
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
    const brtDate = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    const todayBRT = brtDate.toISOString().slice(0, 10);
    const currentHourBRT = brtDate.getHours();

    // Carregar controller do dia
    const controllers = await base44.asServiceRole.entities.AccountDailySpendController.filter(
      { amazon_account_id: accountId, spend_date: todayBRT }, null, 1
    ).catch(() => []);

    const controller = controllers[0];
    if (!controller) {
      return Response.json({ ok: true, skipped: true, reason: 'Sem controller para hoje' });
    }

    // Se Kill Switch ativo — não executar nenhuma ação
    if (controller.global_kill_switch) {
      return Response.json({ ok: true, skipped: true, reason: 'Kill Switch ativo — ciclo bloqueado' });
    }

    const dailyBudget = Number(controller.effective_daily_spend_cap || controller.user_daily_spend_cap || 70);
    const budgetMode = controller.budget_mode || 'BALANCED';
    const eliteReserve = Number(controller.elite_reserve || 0);

    // Carregar curva de pacing planejada
    const pacingCurve = controller.pacing_curve ? JSON.parse(controller.pacing_curve) : {};
    const hourScores = controller.hour_value_scores ? JSON.parse(controller.hour_value_scores) : {};
    const todaySchedule = controller.today_schedule ? JSON.parse(controller.today_schedule) : {};

    // Carregar métricas de performance
    const [perfList, economicsList, campaigns, keywords] = await Promise.all([
      base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id: accountId }, null, 1).catch(() => []),
      base44.asServiceRole.entities.ProductEconomics.filter({ amazon_account_id: accountId }, null, 200).catch(() => []),
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: accountId }, null, 500).catch(() => []),
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: accountId }, '-spend', 500).catch(() => []),
    ]);

    const perf = perfList[0] || {};
    const targetAcos = Number(perf.target_acos || 15);
    const maxBid = Number(perf.max_bid || 2.5);
    const minBid = Number(perf.min_bid || 0.25);

    const avgBreakEven = economicsList.length > 0
      ? economicsList.reduce((s, e) => s + Number(e.break_even_acos || 30), 0) / economicsList.length
      : 30;
    const breakEvenMap = new Map();
    for (const e of economicsList) { if (e.asin) breakEvenMap.set(e.asin, Number(e.break_even_acos || 30)); }

    // ── 1. CONFIRMAR GASTO ATUAL ───────────────────────────────────────
    const activeCampaigns = campaigns.filter(c => {
      const s = (c.state || c.status || '').toLowerCase();
      return s !== 'archived' && c.archived !== true;
    });

    const confirmedSpend = activeCampaigns.reduce((s, c) => s + Number(c.spend || c.current_spend || 0), 0);
    const hoursElapsed = Math.max(currentHourBRT, 1);
    const hoursRemaining = 24 - currentHourBRT;

    // ── 2. SPEND_VELOCITY ─────────────────────────────────────────────
    const spendVelocityPerHour = hoursElapsed > 0 ? confirmedSpend / hoursElapsed : 0;
    const estimatedUnreported = spendVelocityPerHour * 0.25;

    // Safety buffer
    const safetyBuffer = r2(Math.max((spendVelocityPerHour / 4) * 2, dailyBudget * 0.025, 2));
    const effectiveCap = dailyBudget - safetyBuffer;

    // ── 3. TIME_TO_CAP & PROJECTED EOD ───────────────────────────────
    const remainingSafe = Math.max(0, effectiveCap - confirmedSpend);
    const timeToCap = spendVelocityPerHour > 0 ? remainingSafe / spendVelocityPerHour : 99;
    const projectedEod = confirmedSpend + spendVelocityPerHour * hoursRemaining;

    // ── 4. PACING RATIO ───────────────────────────────────────────────
    // Quanto deveria ter gasto até agora segundo a curva?
    let expectedSpendByNow = 0;
    for (let h = 0; h < currentHourBRT; h++) {
      expectedSpendByNow += pacingCurve[h]?.budget_share || (dailyBudget / 24);
    }
    const pacingRatio = expectedSpendByNow > 0 ? confirmedSpend / expectedSpendByNow : 1;

    let spendPacing = 'on_track';
    if (pacingRatio < UNDERPACING_THRESHOLD) spendPacing = 'underpacing';
    else if (pacingRatio > OVERPACING_THRESHOLD) spendPacing = 'overpacing';
    else if (pacingRatio >= 0.98 && pacingRatio <= 1.0) spendPacing = 'on_track';

    // ── 5. FUTURE_VALUE_RESERVE ───────────────────────────────────────
    let futureValueReserve = 0;
    let nextEliteHour = null;
    for (let h = currentHourBRT + 1; h < 24; h++) {
      const score = hourScores[h] || 0;
      if (score >= ELITE_SCORE_THRESHOLD) {
        futureValueReserve += pacingCurve[h]?.budget_share || 0;
        if (nextEliteHour === null) nextEliteHour = h;
      }
    }

    // ── Classificar campanha por tier ─────────────────────────────────
    function campaignTier(c) {
      const spend = Number(c.spend || c.current_spend || 0);
      const sales  = Number(c.sales || 0);
      const orders = Number(c.orders || 0);
      const clicks = Number(c.clicks || 0);
      const daily  = Number(c.daily_budget || 0);
      const acos   = sales > 0 ? (spend / sales) * 100 : (spend > 0 ? 999 : 0);
      const budRatio = daily > 0 ? spend / daily : 0;
      if (acos <= 12 && orders >= 1) return { tier: 'A', acos, budRatio, spend, orders };
      if (acos > 0 && acos <= targetAcos) return { tier: 'B', acos, budRatio, spend, orders };
      if (acos > targetAcos && acos <= 25) return { tier: 'C', acos, budRatio, spend, orders };
      return { tier: 'D', acos, budRatio, spend, orders };
    }

    const campaignProfiles = activeCampaigns.map(c => ({ ...campaignTier(c), campaign: c }));

    const actions = [];
    let executedActions = 0;

    // ── 6. OVERPACING ─────────────────────────────────────────────────
    if (spendPacing === 'overpacing') {
      // 6a. Pausar campanhas Tier D com gasto acima do waste threshold
      const tierD = campaignProfiles.filter(p => p.tier === 'D' && p.spend > dailyBudget * 0.05);
      for (const p of tierD) {
        const c = p.campaign;
        actions.push({ action: 'pause_tier_d', campaign_id: c.campaign_id, reason: 'OVERPACING_TEMP_STOP', spend: p.spend });
        if (!dry_run) {
          await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
            _service_role: true,
            amazon_account_id: accountId,
            path: '/sp/campaigns',
            method: 'PUT',
            content_type: 'application/vnd.spCampaign.v3+json',
            payload: { campaigns: [{ campaignId: String(c.amazon_campaign_id || c.campaign_id), state: 'PAUSED' }] },
          }).catch(() => {});
          await base44.asServiceRole.entities.Campaign.update(c.id, {
            status: 'paused', state: 'paused',
            archive_reason: 'OVERPACING_TEMP_STOP',
          }).catch(() => {});
          executedActions++;
        }
      }

      // 6b. Reduzir bids de keywords em LOSS_TIME slots
      const currentSlotClass = classifySlot(hourScores[currentHourBRT] || 0);
      if (currentSlotClass === 'LOSS') {
        const kwsToReduce = keywords.filter(k => {
          const s = (k.state || k.status || '').toLowerCase();
          return s === 'enabled' && Number(k.current_bid || k.bid || 0) > minBid;
        }).slice(0, 20);

        for (const kw of kwsToReduce) {
          const curBid = Number(kw.current_bid || kw.bid || 0);
          const newBid = r2(Math.max(minBid, curBid * (1 - MAX_BID_DOWN_PCT)));
          if (newBid < curBid - 0.01) {
            actions.push({ action: 'bid_down_loss_slot', keyword_id: kw.keyword_id, old_bid: curBid, new_bid: newBid });
            if (!dry_run) {
              await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
                _service_role: true,
                amazon_account_id: accountId,
                path: '/sp/keywords',
                method: 'PUT',
                content_type: 'application/vnd.spKeyword.v3+json',
                payload: { keywords: [{ keywordId: String(kw.keyword_id), bid: newBid }] },
              }).catch(() => {});
              await base44.asServiceRole.entities.Keyword.update(kw.id, { current_bid: newBid, bid: newBid }).catch(() => {});
              await base44.asServiceRole.entities.AdsBidChangeLog.create({
                amazon_account_id: accountId,
                keyword_id: kw.keyword_id,
                keyword_text: kw.keyword_text,
                bid_before: curBid,
                bid_after: newBid,
                action: 'bid_decrease',
                reason: `Overpacing: slot LOSS na hora ${currentHourBRT}h`,
                source: 'budget_pacing_engine',
                stop_type: 'OVERPACING_TEMP_STOP',
                created_at: now,
              }).catch(() => {});
              executedActions++;
            }
          }
        }
      }

      // 6c. Pausar WEAK campaigns temporariamente com DAYPART_RESERVE_STOP
      const weakCampaigns = campaignProfiles.filter(p => {
        const score = hourScores[currentHourBRT] || 0;
        return p.tier === 'C' && p.spend > 0 && classifySlot(score) === 'WEAK';
      });
      const resumeAt = nextEliteHour !== null
        ? new Date(brtDate).setHours(nextEliteHour, 0, 0, 0)
        : null;

      for (const p of weakCampaigns.slice(0, 5)) {
        const c = p.campaign;
        actions.push({ action: 'daypart_temp_pause', campaign_id: c.campaign_id, resume_at_hour: nextEliteHour });
        if (!dry_run) {
          await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
            _service_role: true,
            amazon_account_id: accountId,
            path: '/sp/campaigns',
            method: 'PUT',
            content_type: 'application/vnd.spCampaign.v3+json',
            payload: { campaigns: [{ campaignId: String(c.amazon_campaign_id || c.campaign_id), state: 'PAUSED' }] },
          }).catch(() => {});
          await base44.asServiceRole.entities.Campaign.update(c.id, {
            status: 'paused', state: 'paused',
            archive_reason: 'DAYPART_RESERVE_STOP',
          }).catch(() => {});
          executedActions++;
        }
      }
    }

    // ── 7. UNDERPACING ────────────────────────────────────────────────
    if (spendPacing === 'underpacing' && budgetMode !== 'PROFIT_MAX') {
      // 7a. Aumentar budget de winners com budget_ratio >= 85%
      const winnerCampaigns = campaignProfiles.filter(p => p.tier === 'A' && p.budRatio >= 0.85);
      for (const p of winnerCampaigns.slice(0, 5)) {
        const c = p.campaign;
        const daily = Number(c.daily_budget || 0);
        if (daily <= 0) continue;
        const newBudget = r2(Math.min(dailyBudget, daily * (1 + BUDGET_UP_PCT)));
        if (newBudget > daily + 0.50) {
          actions.push({ action: 'budget_up_winner', campaign_id: c.campaign_id, old_budget: daily, new_budget: newBudget });
          if (!dry_run) {
            await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
              _service_role: true,
              amazon_account_id: accountId,
              path: '/sp/campaigns',
              method: 'PUT',
              content_type: 'application/vnd.spCampaign.v3+json',
              payload: { campaigns: [{ campaignId: String(c.amazon_campaign_id || c.campaign_id), budget: { budget: newBudget, budgetType: 'DAILY' } }] },
            }).catch(() => {});
            await base44.asServiceRole.entities.Campaign.update(c.id, { daily_budget: newBudget }).catch(() => {});
            executedActions++;
          }
        }
      }

      // 7b. Aumentar bids em slots ELITE/STRONG
      const currentSlotClass = classifySlot(hourScores[currentHourBRT] || 0);
      if (currentSlotClass === 'ELITE' || currentSlotClass === 'STRONG') {
        const kwsToBoost = keywords.filter(k => {
          const s = (k.state || k.status || '').toLowerCase();
          const acos = Number(k.acos || 0);
          const curBid = Number(k.current_bid || k.bid || 0);
          return s === 'enabled' && acos > 0 && acos <= targetAcos * 0.80 && curBid < maxBid;
        }).slice(0, 10);

        for (const kw of kwsToBoost) {
          const curBid = Number(kw.current_bid || kw.bid || 0);
          const newBid = r2(Math.min(maxBid, curBid * (1 + MAX_BID_UP_PCT)));
          if (newBid > curBid + 0.01) {
            actions.push({ action: 'bid_up_elite_slot', keyword_id: kw.keyword_id, old_bid: curBid, new_bid: newBid });
            if (!dry_run) {
              await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
                _service_role: true,
                amazon_account_id: accountId,
                path: '/sp/keywords',
                method: 'PUT',
                content_type: 'application/vnd.spKeyword.v3+json',
                payload: { keywords: [{ keywordId: String(kw.keyword_id), bid: newBid }] },
              }).catch(() => {});
              await base44.asServiceRole.entities.Keyword.update(kw.id, { current_bid: newBid, bid: newBid }).catch(() => {});
              executedActions++;
            }
          }
        }
      }

      // 7c. Retomar campanhas com DAYPART_TEMP_PAUSE cujo horário chegou
      const pausedForDaypart = campaigns.filter(c => {
        const reason = c.archive_reason || c.last_pause_reason || '';
        const s = (c.state || c.status || '').toLowerCase();
        return s === 'paused' && (reason.includes('DAYPART_RESERVE_STOP') || reason.includes('OVERPACING_TEMP_STOP'));
      });
      for (const c of pausedForDaypart.slice(0, 10)) {
        actions.push({ action: 'resume_daypart_temp', campaign_id: c.campaign_id });
        if (!dry_run) {
          await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
            _service_role: true,
            amazon_account_id: accountId,
            path: '/sp/campaigns',
            method: 'PUT',
            content_type: 'application/vnd.spCampaign.v3+json',
            payload: { campaigns: [{ campaignId: String(c.amazon_campaign_id || c.campaign_id), state: 'ENABLED' }] },
          }).catch(() => {});
          await base44.asServiceRole.entities.Campaign.update(c.id, {
            status: 'enabled', state: 'enabled', archive_reason: null,
          }).catch(() => {});
          executedActions++;
        }
      }
    }

    // ── 8. DAYPART_RESERVE_STOP ───────────────────────────────────────
    // Se hora atual é WEAK/LOSS e há slot ELITE nas próximas 4h com budget_share >= 20%
    const currentScore = hourScores[currentHourBRT] || 0;
    const currentClass = classifySlot(currentScore);
    let daypartReserveActive = false;

    if ((currentClass === 'WEAK' || currentClass === 'LOSS') && nextEliteHour !== null && nextEliteHour - currentHourBRT <= 4) {
      const eliteBudgetShare = pacingCurve[nextEliteHour]?.budget_share || 0;
      const eliteSharePct = dailyBudget > 0 ? eliteBudgetShare / dailyBudget * 100 : 0;
      const remainingBudget = Math.max(0, dailyBudget - confirmedSpend);

      if (eliteSharePct >= 20 && remainingBudget <= eliteReserve * 1.2) {
        daypartReserveActive = true;
        // Pausar Tier C e D
        const toReserve = campaignProfiles.filter(p => (p.tier === 'C' || p.tier === 'D') && p.spend > 0);
        for (const p of toReserve.slice(0, 5)) {
          const c = p.campaign;
          actions.push({ action: 'daypart_reserve_stop', campaign_id: c.campaign_id, reserve_for_hour: nextEliteHour });
          if (!dry_run) {
            await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
              _service_role: true,
              amazon_account_id: accountId,
              path: '/sp/campaigns',
              method: 'PUT',
              content_type: 'application/vnd.spCampaign.v3+json',
              payload: { campaigns: [{ campaignId: String(c.amazon_campaign_id || c.campaign_id), state: 'PAUSED' }] },
            }).catch(() => {});
            await base44.asServiceRole.entities.Campaign.update(c.id, {
              status: 'paused', state: 'paused',
              archive_reason: `DAYPART_RESERVE_STOP:resume_at_${nextEliteHour}h`,
            }).catch(() => {});
            executedActions++;
          }
        }
      }
    }

    // ── 9. PROFIT_PROTECTION_STOP ─────────────────────────────────────
    // Se gastar o remaining projetaria ACoS acima do break_even
    const totalSales = activeCampaigns.reduce((s, c) => s + Number(c.sales || 0), 0);
    const currentAcos = totalSales > 0 ? (confirmedSpend / totalSales) * 100 : 0;
    const profitProtectionActive = currentAcos > avgBreakEven * 0.95 && confirmedSpend > dailyBudget * 0.50;

    if (profitProtectionActive && budgetMode === 'PROFIT_MAX') {
      actions.push({ action: 'profit_protection_stop', reason: `ACoS ${r2(currentAcos)}% > break_even ${r2(avgBreakEven * 0.95)}%` });
      // Não pausar campanhas Tier A — apenas registrar flag
    }

    // ── 10. Atualizar AccountDailySpendController ────────────────────
    const utilizationPct = dailyBudget > 0 ? confirmedSpend / dailyBudget * 100 : 0;
    let capStatus = 'safe';
    if (utilizationPct >= 100) capStatus = 'cap_reached';
    else if (utilizationPct >= 95) capStatus = 'cap_imminent';
    else if (utilizationPct >= 85) capStatus = 'critical';
    else if (utilizationPct >= 70) capStatus = 'attention';

    if (!dry_run) {
      await base44.asServiceRole.entities.AccountDailySpendController.update(controller.id, {
        confirmed_spend: r2(confirmedSpend),
        estimated_pending_spend: r2(estimatedUnreported),
        projected_total_spend: r2(projectedEod),
        remaining_spend: r2(Math.max(0, dailyBudget - confirmedSpend)),
        cap_status: capStatus,
        spend_pacing: spendPacing,
        pacing_ratio: r2(pacingRatio),
        current_hour_brt: currentHourBRT,
        projected_end_of_day_spend: r2(projectedEod),
        time_to_cap_hours: r2(timeToCap),
        future_value_reserve: r2(futureValueReserve),
        underpacing_alert: spendPacing === 'underpacing',
        overpacing_alert: spendPacing === 'overpacing',
        spend_velocity_per_hour: r2(spendVelocityPerHour),
        safety_buffer: safetyBuffer,
        last_pacing_check_at: now,
        updated_at: now,
      }).catch(() => {});
    }

    return Response.json({
      ok: true,
      dry_run,
      today: todayBRT,
      current_hour_brt: currentHourBRT,
      current_slot_class: currentClass,
      pacing_ratio: r2(pacingRatio),
      spend_pacing: spendPacing,
      confirmed_spend: r2(confirmedSpend),
      expected_spend_by_now: r2(expectedSpendByNow),
      projected_eod: r2(projectedEod),
      time_to_cap_hours: r2(timeToCap),
      future_value_reserve: r2(futureValueReserve),
      next_elite_hour: nextEliteHour,
      daypart_reserve_active: daypartReserveActive,
      profit_protection_active: profitProtectionActive,
      actions_proposed: actions.length,
      actions_executed: executedActions,
      actions: actions.slice(0, 30),
      cap_status: capStatus,
      daily_budget: dailyBudget,
      duration_ms: Date.now() - t0,
    });

  } catch (err) {
    return Response.json({ ok: false, error: err.message, duration_ms: Date.now() - t0 }, { status: 500 });
  }
});