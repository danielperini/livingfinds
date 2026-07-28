import {
  aggregateIntradaySnapshots,
  brtClock,
  buildCampaignProfiles,
  buildPacingCurve,
  clamp,
  expectedFraction,
  pacingClassification,
  parseArray,
  positive,
  r2,
  resolveDailyCap,
} from './portfolioBudgetMath.ts';
import {
  acquireControllerLock,
  capStatus,
  controllerLockActive,
  nextDayAt,
  releaseControllerLock,
  setCampaignState,
  upsertDailyController,
  writePacingAudit,
} from './portfolioBudgetActions.ts';

const MAX_PAUSES = 6;
const MAX_HARD_CAP_PAUSES = 25;
const MAX_RESUMES = 8;

export async function runPortfolioBudgetPacing(base44: any, account: any, body: any = {}) {
  const startedAt = Date.now();
  const clock = brtClock();
  const runId = String(body.run_id || crypto.randomUUID());
  const dryRun = body.dry_run === true;
  const accountId = String(account?.id || '');
  if (!accountId) return { ok: false, error: 'AmazonAccount inválida' };

  const [performanceRows, configRows, campaigns, products, economics, patterns, snapshots] = await Promise.all([
    base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id: accountId }, '-updated_at', 1).catch(() => []),
    base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: accountId }, '-updated_at', 1).catch(() => []),
    base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: accountId }, null, 3000).catch(() => []),
    base44.asServiceRole.entities.Product.filter({ amazon_account_id: accountId }, null, 3000).catch(() => []),
    base44.asServiceRole.entities.ProductEconomics.filter({ amazon_account_id: accountId }, null, 3000).catch(() => []),
    base44.asServiceRole.entities.HourlySalesPattern.filter({ amazon_account_id: accountId }, null, 5000).catch(() => []),
    base44.asServiceRole.entities.IntradaySpendSnapshot.filter(
      { amazon_account_id: accountId, spend_date: clock.date }, '-observed_at', 10000,
    ).catch(() => []),
  ]);

  const performance = performanceRows[0] || {};
  const config = configRows[0] || {};
  if (performance?.pacing_enabled === false || config?.budget_optimization_enabled === false) {
    return { ok: true, skipped: true, reason: 'Pacing de orçamento desabilitado', amazon_account_id: accountId };
  }

  const { cap: dailyCap, source: dailyCapSource } = resolveDailyCap(performance, config, account);
  const controller = await upsertDailyController(base44, {
    accountId,
    marketplaceId: account?.marketplace_id || account?.marketplace || null,
    date: clock.date,
    cap: dailyCap,
    capSource: dailyCapSource,
    timezone: String(config?.marketplace_timezone || account?.timezone || 'America/Sao_Paulo'),
    now: clock.iso,
    dryRun,
  });

  if (controller?.global_kill_switch === true) {
    return { ok: true, skipped: true, reason: 'Kill Switch global ativo', daily_cap: dailyCap };
  }
  if (!dryRun && controllerLockActive(controller, runId)) {
    return { ok: true, skipped: true, reason: 'Outro ciclo de pacing está em execução', lock_until: controller.pacing_lock_until };
  }
  if (!dryRun && controller?.id) await acquireControllerLock(base44, controller, runId, clock.iso);

  try {
    const targetAcos = positive(performance?.target_acos, config?.target_acos, 15);
    const curve = buildPacingCurve(patterns, clock.dayOfWeek);
    const expectedPct = expectedFraction(curve.weights, clock.minuteOfDay);
    const expectedSpend = r2(Math.max(2, dailyCap * expectedPct));
    const intraday = aggregateIntradaySnapshots(snapshots, Date.now());
    const profiles = buildCampaignProfiles(campaigns, products, economics, intraday.campaignRows, targetAcos);
    const activeProfiles = profiles.filter((profile: any) =>
      profile.active && profile.stock > 0 && profile.campaignId &&
      String(profile.campaign?.campaign_type || 'SP').toUpperCase() === 'SP',
    );
    const temporaryPaused = profiles.filter((profile: any) =>
      profile.paused && profile.temporaryPause && profile.stock > 0 && profile.campaignId,
    );

    const actions: any[] = [];
    let actionsExecuted = 0;
    const pausedIds = new Set<string>(parseArray(controller?.campaigns_paused_today).map(String));
    const windowKey = `${clock.hour}-${Math.floor(clock.minute / 30)}`;

    // Pausas de pacing nunca atravessam o dia sem tentativa de retomada.
    const previousDayPaused = temporaryPaused
      .filter((profile: any) => {
        const date = String(profile.campaign?.pacing_pause_date || '');
        return date && date < clock.date;
      })
      .sort((a: any, b: any) => b.priorityScore - a.priorityScore)
      .slice(0, MAX_RESUMES);
    for (const profile of previousDayPaused) {
      const result = await setCampaignState(base44, {
        accountId, profile, state: 'ENABLED', reason: 'PACING_NEW_DAY_AUTO_RESUME',
        date: clock.date, now: clock.iso, dryRun, windowKey,
      });
      actions.push(result);
      if (result.ok && !result.dry_run) {
        actionsExecuted++;
        pausedIds.delete(profile.campaignId);
      }
    }

    // Sem gasto real do dia, o motor não usa Campaign.spend/current_spend como substituto.
    if (!intraday.available) {
      if (!dryRun && controller?.id) {
        await base44.asServiceRole.entities.AccountDailySpendController.update(controller.id, {
          confirmed_spend: intraday.confirmedSpend,
          estimated_pending_spend: intraday.estimatedPendingSpend,
          projected_total_spend: intraday.estimatedCurrentSpend,
          remaining_spend: r2(Math.max(0, dailyCap - intraday.estimatedCurrentSpend)),
          spend_pacing: 'unknown',
          intraday_metrics_status: intraday.status,
          intraday_metric_source: intraday.source,
          intraday_metrics_observed_at: intraday.observedAt,
          expected_spend_by_now: expectedSpend,
          expected_spend_pct: r2(expectedPct * 100),
          pacing_curve: JSON.stringify(curve.curve),
          pacing_curve_source: curve.source,
          campaigns_paused_today: [...pausedIds],
          last_pacing_action_summary: JSON.stringify({ actions, blocked: 'intraday_metrics_unavailable' }).slice(0, 4000),
          last_pacing_check_at: clock.iso,
          updated_at: clock.iso,
        }).catch(() => {});
      }
      return {
        ok: true,
        skipped: true,
        reason: intraday.status === 'stale'
          ? 'Métricas intradiárias antigas; escritas Amazon bloqueadas'
          : 'Sem métricas intradiárias reais; escritas Amazon bloqueadas',
        amazon_account_id: accountId,
        daily_cap: dailyCap,
        daily_cap_source: dailyCapSource,
        metrics_status: intraday.status,
        metrics_observed_at: intraday.observedAt,
        expected_spend_by_now: expectedSpend,
        actions_executed: actionsExecuted,
        actions,
        duration_ms: Date.now() - startedAt,
      };
    }

    const estimatedSpend = intraday.estimatedCurrentSpend;
    const elapsedHours = Math.max(0.5, clock.hour + clock.minute / 60);
    const velocity = intraday.velocityPerHour || estimatedSpend / elapsedHours;
    const projectedEod = r2(estimatedSpend + velocity * Math.max(0, 24 - elapsedHours));
    const safetyBuffer = r2(Math.max(dailyCap * 0.03, intraday.estimatedPendingSpend, 2));
    const effectiveCap = r2(Math.max(0, dailyCap - safetyBuffer));
    const pacingRatio = expectedSpend > 0 ? estimatedSpend / expectedSpend : 1;
    const classification = pacingClassification(pacingRatio, estimatedSpend, effectiveCap, projectedEod, dailyCap);
    const remaining = r2(Math.max(0, dailyCap - estimatedSpend));
    const currentHourWeight = curve.weights[clock.hour] || 0;
    const futureMaxWeight = Math.max(0, ...curve.weights.slice(clock.hour + 1));
    const currentWindowStrong = currentHourWeight >= Math.max(...curve.weights) * 0.75;
    const futureStrongerWindow = futureMaxWeight > currentHourWeight * 1.20;

    if (classification === 'underpacing' && remaining > Math.max(5, dailyCap * 0.10)) {
      const resumeCandidates = temporaryPaused
        .filter((profile: any) => !previousDayPaused.includes(profile))
        .sort((a: any, b: any) => b.priorityScore - a.priorityScore)
        .slice(0, MAX_RESUMES);
      for (const profile of resumeCandidates) {
        const result = await setCampaignState(base44, {
          accountId, profile, state: 'ENABLED', reason: 'PACING_UNDERSPEND_RESUME',
          date: clock.date, now: clock.iso, dryRun, windowKey,
        });
        actions.push(result);
        if (result.ok && !result.dry_run) {
          actionsExecuted++;
          pausedIds.delete(profile.campaignId);
        }
      }
    }

    const hardCap = classification === 'hard_cap_risk';
    const overpacing = classification === 'overpacing' || hardCap;
    if (overpacing) {
      const normalCandidates = activeProfiles
        .filter((profile: any) => !profile.protected)
        .sort((a: any, b: any) => b.wasteScore - a.wasteScore || b.todaySpend - a.todaySpend);
      const protectedLastResort = hardCap
        ? activeProfiles.filter((profile: any) => profile.protected)
          .sort((a: any, b: any) => a.priorityScore - b.priorityScore)
        : [];
      const candidates = [...normalCandidates, ...protectedLastResort];
      const limit = hardCap ? MAX_HARD_CAP_PAUSES : MAX_PAUSES;
      const reasonCode = hardCap ? 'PACING_HARD_CAP_STOP' : 'PACING_OVERSPEND_TEMP_STOP';
      const activeByAsin = new Map<string, number>();
      activeProfiles.forEach((profile: any) => activeByAsin.set(profile.asin, (activeByAsin.get(profile.asin) || 0) + 1));
      let selected = 0;
      for (const profile of candidates) {
        if (selected >= limit) break;
        const countForAsin = activeByAsin.get(profile.asin) || 0;
        if (!hardCap && (countForAsin <= 1 || profile.protected)) continue;
        const reason = `${reasonCode}: pacing ${r2(pacingRatio)}x, gasto estimado R$ ${estimatedSpend.toFixed(2)}, ` +
          `esperado R$ ${expectedSpend.toFixed(2)}, projeção R$ ${projectedEod.toFixed(2)}, teto R$ ${dailyCap.toFixed(2)}`;
        const result = await setCampaignState(base44, {
          accountId, profile, state: 'PAUSED', reason, date: clock.date, now: clock.iso, dryRun,
          resumeAfter: hardCap ? nextDayAt(0) : new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
          windowKey,
        });
        actions.push(result);
        if (result.ok) {
          selected++;
          if (!result.dry_run) {
            actionsExecuted++;
            pausedIds.add(profile.campaignId);
            activeByAsin.set(profile.asin, Math.max(0, countForAsin - 1));
          }
        }
      }
    }

    // Bids continuam no motor canônico de dayparting; este retorno limita o escopo.
    let bidIncreasePct = 0;
    if (classification === 'underpacing' && !futureStrongerWindow) {
      bidIncreasePct = pacingRatio < 0.60 ? 15 : pacingRatio < 0.75 ? 10 : 5;
    }
    bidIncreasePct = Math.min(
      bidIncreasePct,
      clamp(positive(performance?.max_bid_increase_pct, config?.max_bid_increase_pct, 15), 0, 20),
    );
    const bidScope = (classification === 'underpacing'
      ? activeProfiles.filter((profile: any) => profile.protected && !profile.economicRisk)
        .sort((a: any, b: any) => b.priorityScore - a.priorityScore)
      : overpacing
        ? activeProfiles.filter((profile: any) => !profile.protected && profile.todaySpend > 0)
          .sort((a: any, b: any) => b.wasteScore - a.wasteScore)
        : activeProfiles.filter((profile: any) => profile.protected && currentWindowStrong)
          .sort((a: any, b: any) => b.priorityScore - a.priorityScore)
    ).slice(0, 20);
    const eligibleAsins = [...new Set(bidScope.map((profile: any) => profile.asin).filter(Boolean))];
    const allowBidActions = !hardCap && eligibleAsins.length > 0 &&
      (classification !== 'underpacing' || bidIncreasePct > 0);
    const status = capStatus(dailyCap > 0 ? estimatedSpend / dailyCap : 0);
    const summary = {
      classification, daily_cap: dailyCap, confirmed_spend: intraday.confirmedSpend,
      estimated_pending_spend: intraday.estimatedPendingSpend, estimated_current_spend: estimatedSpend,
      expected_spend_by_now: expectedSpend, projected_eod: projectedEod, pacing_ratio: r2(pacingRatio),
      actions, bid_scope_asins: eligibleAsins, bid_increase_pct: bidIncreasePct,
    };

    if (!dryRun && controller?.id) {
      await base44.asServiceRole.entities.AccountDailySpendController.update(controller.id, {
        user_daily_spend_cap: dailyCap,
        effective_daily_spend_cap: dailyCap,
        daily_cap_source: dailyCapSource,
        confirmed_spend: intraday.confirmedSpend,
        estimated_pending_spend: intraday.estimatedPendingSpend,
        projected_total_spend: estimatedSpend,
        projected_end_of_day_spend: projectedEod,
        remaining_spend: remaining,
        cap_status: status,
        spend_pacing: hardCap ? 'overpacing' : classification,
        pacing_ratio: r2(pacingRatio),
        current_hour_brt: clock.hour,
        expected_spend_by_now: expectedSpend,
        expected_spend_pct: r2(expectedPct * 100),
        spend_velocity_per_hour: r2(velocity),
        time_to_cap_hours: velocity > 0 ? r2(Math.max(0, effectiveCap - estimatedSpend) / velocity) : 99,
        safety_buffer: safetyBuffer,
        hard_cap_triggered: hardCap,
        intraday_metrics_status: intraday.status,
        intraday_metric_source: intraday.source,
        intraday_metrics_observed_at: intraday.observedAt,
        pacing_curve: JSON.stringify(curve.curve),
        pacing_curve_source: curve.source,
        hour_value_scores: JSON.stringify(Object.fromEntries(curve.weights.map((weight, hour) => [hour, r2(weight * 100)]))),
        campaigns_paused_today: [...pausedIds],
        campaigns_paused_count: pausedIds.size,
        last_pacing_action_summary: JSON.stringify(summary).slice(0, 4000),
        last_pacing_check_at: clock.iso,
        last_action_at: actionsExecuted > 0 ? clock.iso : controller.last_action_at || null,
        updated_at: clock.iso,
      }).catch(() => {});
    }

    if (!dryRun) await writePacingAudit(base44, {
      accountId,
      decisionType: 'portfolio_daily_budget_pacing',
      entityType: 'account',
      campaignId: 'account',
      action: classification,
      before: intraday.confirmedSpend,
      after: estimatedSpend,
      reason: `Pacing ${classification}: estimado R$ ${estimatedSpend.toFixed(2)}, esperado R$ ${expectedSpend.toFixed(2)}, ` +
        `projeção R$ ${projectedEod.toFixed(2)}, teto R$ ${dailyCap.toFixed(2)} (${dailyCapSource}).`,
      risk: hardCap ? 'high' : overpacing ? 'medium' : 'low',
      idempotencyKey: `${accountId}|portfolio_pacing_summary|${clock.date}|${clock.hour}|${Math.floor(clock.minute / 30)}`,
      status: 'executed',
      now: clock.iso,
    });

    return {
      ok: true,
      dry_run: dryRun,
      engine: 'portfolio-daily-budget-pacing-v1',
      amazon_account_id: accountId,
      date_brt: clock.date,
      hour_brt: clock.hour,
      daily_cap: dailyCap,
      daily_cap_source: dailyCapSource,
      confirmed_spend: intraday.confirmedSpend,
      estimated_pending_spend: intraday.estimatedPendingSpend,
      estimated_current_spend: estimatedSpend,
      remaining_spend: remaining,
      expected_spend_by_now: expectedSpend,
      expected_spend_pct: r2(expectedPct * 100),
      projected_eod: projectedEod,
      pacing_ratio: r2(pacingRatio),
      spend_pacing: classification,
      cap_status: status,
      metrics_source: intraday.source,
      metrics_observed_at: intraday.observedAt,
      metrics_age_minutes: intraday.ageMinutes,
      pacing_curve_source: curve.source,
      learned_hours: curve.matureHours,
      actions_proposed: actions.length,
      actions_executed: actionsExecuted,
      actions,
      allow_bid_actions: allowBidActions,
      eligible_asins_for_bid_adjustment: eligibleAsins,
      bid_increase_pct: bidIncreasePct,
      bid_multiplier_override: bidIncreasePct > 0 ? r2(1 + bidIncreasePct / 100) : null,
      current_window_strong: currentWindowStrong,
      future_stronger_window: futureStrongerWindow,
      duration_ms: Date.now() - startedAt,
    };
  } finally {
    if (!dryRun && controller?.id) await releaseControllerLock(base44, controller);
  }
}
