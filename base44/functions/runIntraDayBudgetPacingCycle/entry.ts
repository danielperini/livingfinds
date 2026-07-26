import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';

/**
 * Controlador intra-diário de orçamento e estado de campanha.
 *
 * Preserva as responsabilidades não relacionadas a bid que existiam na rota
 * antiga: pacing, aumento de budget de vencedoras, pausas temporárias,
 * retomadas e atualização do AccountDailySpendController.
 *
 * Ajustes de lance pertencem exclusivamente ao runCanonicalDaypartingEngine.
 */
const OVERPACING_THRESHOLD = 1.20;
const UNDERPACING_THRESHOLD = 0.90;
const BUDGET_UP_PCT = 0.15;
const MAX_PAUSES_PER_RUN = 5;
const MAX_RESUMES_PER_RUN = 10;
const r2 = (value: number) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
const norm = (value: any) => String(value || '').trim().toLowerCase();
const active = (value: any) => ['enabled', 'active'].includes(norm(value));

function brtClock() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value || '';
  return {
    iso: now.toISOString(),
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hour: Number(get('hour') || 0) % 24,
  };
}

function parseObject(value: any) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(String(value)); } catch { return {}; }
}

function stock(product: any) {
  return Number(product?.fba_inventory ?? product?.available_quantity ?? product?.fulfillable_quantity ?? product?.stock ?? 0);
}

function metrics(campaign: any, targetAcos: number) {
  const spend = Number(campaign.current_spend ?? 0);
  const sales = Number(campaign.sales || 0);
  const orders = Number(campaign.orders || 0);
  const budget = Number(campaign.daily_budget || 0);
  const acos = sales > 0 ? (spend / sales) * 100 : spend > 0 ? 999 : 0;
  const budgetRatio = budget > 0 ? spend / budget : 0;
  const winner = orders > 0 && acos > 0 && acos <= targetAcos;
  const tier = winner && acos <= Math.min(12, targetAcos) ? 'A'
    : winner ? 'B'
    : acos > targetAcos && acos <= Math.max(25, targetAcos * 1.5) ? 'C'
    : 'D';
  return { spend, sales, orders, budget, acos, budgetRatio, winner, tier };
}

function commandOk(response: any, key = 'campaigns') {
  const data = response?.data || response || {};
  if (data?.ok === false) return false;
  if (Number(data?.status || 0) !== 207) return data?.ok === true;
  const payload = data?.payload || {};
  const success = payload?.[key]?.success || payload?.success || [];
  return Array.isArray(success) ? success.length > 0 : true;
}

async function once(base44: any, accountId: string, key: string) {
  const rows = await base44.asServiceRole.entities.OptimizationDecision.filter({
    amazon_account_id: accountId,
    idempotency_key: key,
  }, '-created_at', 10).catch(() => []);
  return !rows.some((row: any) => ['approved', 'executing', 'executed'].includes(String(row.status || '')));
}

async function audit(base44: any, data: any) {
  await base44.asServiceRole.entities.OptimizationDecision.create({
    amazon_account_id: data.accountId,
    decision_type: data.decisionType,
    entity_type: 'campaign',
    entity_id: data.campaignId,
    campaign_id: data.campaignId,
    asin: data.asin || null,
    action: data.action,
    current_value: data.before ?? null,
    proposed_value: data.after ?? null,
    value_before: data.before ?? null,
    value_after: data.after ?? null,
    rationale: data.reason,
    risk: data.risk || 'low',
    requires_approval: false,
    approval_status: 'auto_approved',
    status: 'executed',
    queue_status: 'completed',
    idempotency_key: data.idempotencyKey,
    source_function: 'runIntraDayBudgetPacingCycle',
    executed_at: data.now,
    created_at: data.now,
    updated_at: data.now,
  }).catch(() => {});
}

Deno.serve(async (request) => {
  const startedAt = Date.now();
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    if (!body._service_role) {
      const user = await base44.auth.me().catch(() => null);
      if (!user) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    const accounts = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1)
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-updated_at', 1);
    const account = accounts[0];
    if (!account) return Response.json({ ok: false, error: 'Nenhuma conta configurada' }, { status: 404 });

    const clock = brtClock();
    const accountId = account.id;
    const dryRun = body.dry_run === true;
    const [controllers, configs, performance, campaigns, products] = await Promise.all([
      base44.asServiceRole.entities.AccountDailySpendController.filter({ amazon_account_id: accountId, spend_date: clock.date }, null, 1).catch(() => []),
      base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: accountId }, null, 1).catch(() => []),
      base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id: accountId }, null, 1).catch(() => []),
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: accountId }, null, 1000).catch(() => []),
      base44.asServiceRole.entities.Product.filter({ amazon_account_id: accountId }, null, 1000).catch(() => []),
    ]);

    const controller = controllers[0];
    if (!controller) return Response.json({ ok: true, skipped: true, reason: 'Sem AccountDailySpendController para hoje', actions_executed: 0 });
    if (controller.global_kill_switch === true) return Response.json({ ok: true, skipped: true, reason: 'Kill Switch ativo', actions_executed: 0 });

    const cfg = configs[0] || {};
    const perf = performance[0] || {};
    const dailyCap = Number(controller.effective_daily_spend_cap || controller.user_daily_spend_cap || cfg.total_daily_budget || cfg.daily_budget_limit || account.max_daily_budget_limit || 0);
    const targetAcos = Number(perf.target_acos || cfg.target_acos || 15);
    const pacingCurve = parseObject(controller.pacing_curve);
    const hourScores = parseObject(controller.hour_value_scores);
    const productByAsin = new Map(products.map((product: any) => [String(product.asin || ''), product]));

    const activeCampaigns = campaigns.filter((campaign: any) =>
      active(campaign.state || campaign.status) &&
      campaign.archived !== true &&
      stock(productByAsin.get(String(campaign.asin || ''))) > 0,
    );
    const profiles = activeCampaigns.map((campaign: any) => ({ campaign, ...metrics(campaign, targetAcos) }));
    const confirmedSpend = profiles.reduce((sum, profile) => sum + profile.spend, 0);
    const totalCampaignBudgets = profiles.reduce((sum, profile) => sum + profile.budget, 0);
    const hoursElapsed = Math.max(clock.hour, 1);
    const hoursRemaining = Math.max(0, 24 - clock.hour);
    const spendVelocity = confirmedSpend / hoursElapsed;
    const safetyBuffer = r2(Math.max((spendVelocity / 4) * 2, dailyCap * 0.025, 2));
    const effectiveCap = Math.max(0, dailyCap - safetyBuffer);
    const projectedEndOfDay = confirmedSpend + spendVelocity * hoursRemaining;
    const timeToCap = spendVelocity > 0 ? Math.max(0, effectiveCap - confirmedSpend) / spendVelocity : 99;

    let expectedSpend = 0;
    for (let hour = 0; hour < clock.hour; hour++) {
      expectedSpend += Number(pacingCurve?.[hour]?.budget_share ?? (dailyCap > 0 ? dailyCap / 24 : 0));
    }
    const pacingRatio = expectedSpend > 0 ? confirmedSpend / expectedSpend : 1;
    const spendPacing = pacingRatio > OVERPACING_THRESHOLD ? 'overpacing'
      : pacingRatio < UNDERPACING_THRESHOLD ? 'underpacing'
      : 'on_track';

    const currentScore = Number(hourScores?.[clock.hour] || 0);
    const currentSlot = currentScore >= 90 ? 'ELITE'
      : currentScore >= 75 ? 'STRONG'
      : currentScore >= 55 ? 'NORMAL'
      : currentScore >= 35 ? 'WEAK'
      : currentScore > 0 ? 'LOSS'
      : 'UNKNOWN';

    let nextEliteHour: number | null = null;
    for (let hour = clock.hour + 1; hour < 24; hour++) {
      if (Number(hourScores?.[hour] || 0) >= 75) {
        nextEliteHour = hour;
        break;
      }
    }

    const actions: any[] = [];
    let actionsExecuted = 0;
    let remainingActive = activeCampaigns.length;

    const pauseCampaign = async (profile: any, reasonCode: string, reason: string) => {
      const campaign = profile.campaign;
      const cid = String(campaign.amazon_campaign_id || campaign.campaign_id || '');
      if (!cid || remainingActive <= 1 || profile.winner) return;
      const key = `${accountId}|pacing_pause|${cid}|${reasonCode}|${clock.date}|${clock.hour}`;
      if (!(await once(base44, accountId, key))) return;
      actions.push({ action: 'pause_campaign', campaign_id: cid, reason: reasonCode });
      if (dryRun) return;

      const response = await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
        amazon_account_id: accountId,
        operation: 'intraday_pacing_pause',
        method: 'PUT',
        path: '/sp/campaigns',
        content_type: 'application/vnd.spCampaign.v3+json',
        accept: 'application/vnd.spCampaign.v3+json',
        payload: { campaigns: [{ campaignId: cid, state: 'PAUSED' }] },
        max_attempts: 3,
        _service_role: true,
      }).catch(() => null);
      if (!commandOk(response)) return;

      await base44.asServiceRole.entities.Campaign.update(campaign.id, {
        state: 'paused',
        status: 'paused',
        original_state: campaign.original_state || 'enabled',
        archive_reason: reasonCode,
        last_activity_at: clock.iso,
      }).catch(() => {});
      await audit(base44, {
        accountId,
        decisionType: 'pause',
        campaignId: cid,
        asin: campaign.asin,
        action: 'pause_campaign',
        reason,
        risk: 'low',
        idempotencyKey: key,
        now: clock.iso,
      });
      remainingActive--;
      actionsExecuted++;
    };

    if (spendPacing === 'overpacing') {
      const waste = profiles
        .filter((profile) => profile.tier === 'D' && profile.spend > dailyCap * 0.05 && !profile.winner)
        .sort((a, b) => b.spend - a.spend)
        .slice(0, MAX_PAUSES_PER_RUN);
      for (const profile of waste) {
        await pauseCampaign(profile, 'OVERPACING_TEMP_STOP', `Overpacing ${r2(pacingRatio)}x: campanha Tier D sem proteção de performance.`);
      }
    }

    const reserveNeeded = ['WEAK', 'LOSS'].includes(currentSlot) && nextEliteHour !== null && nextEliteHour - clock.hour <= 4 && confirmedSpend >= effectiveCap * 0.80;
    if (reserveNeeded) {
      const reserve = profiles
        .filter((profile) => ['C', 'D'].includes(profile.tier) && profile.spend > 0 && !profile.winner && active(profile.campaign.state || profile.campaign.status))
        .sort((a, b) => b.spend - a.spend)
        .slice(0, Math.min(3, MAX_PAUSES_PER_RUN));
      for (const profile of reserve) {
        await pauseCampaign(profile, `DAYPART_RESERVE_STOP:resume_at_${nextEliteHour}h`, `Reserva de orçamento para slot forte às ${nextEliteHour}h BRT.`);
      }
    }

    if (spendPacing === 'underpacing' && controller.budget_mode !== 'PROFIT_MAX') {
      let availableBudget = Math.max(0, dailyCap - totalCampaignBudgets);
      const winners = profiles
        .filter((profile) => profile.winner && profile.budgetRatio >= 0.85 && profile.budget > 0)
        .sort((a, b) => a.acos - b.acos)
        .slice(0, 5);

      for (const profile of winners) {
        if (availableBudget < 0.5) break;
        const campaign = profile.campaign;
        const cid = String(campaign.amazon_campaign_id || campaign.campaign_id || '');
        const desiredIncrease = Math.min(profile.budget * BUDGET_UP_PCT, availableBudget);
        const newBudget = r2(profile.budget + desiredIncrease);
        if (!cid || newBudget <= profile.budget + 0.49) continue;
        const key = `${accountId}|pacing_budget_up|${cid}|${clock.date}|${clock.hour}`;
        if (!(await once(base44, accountId, key))) continue;
        actions.push({ action: 'budget_up_winner', campaign_id: cid, old_budget: profile.budget, new_budget: newBudget });
        if (dryRun) continue;

        const response = await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
          amazon_account_id: accountId,
          operation: 'intraday_pacing_budget_up',
          method: 'PUT',
          path: '/sp/campaigns',
          content_type: 'application/vnd.spCampaign.v3+json',
          accept: 'application/vnd.spCampaign.v3+json',
          payload: { campaigns: [{ campaignId: cid, budget: { budget: newBudget, budgetType: 'DAILY' } }] },
          max_attempts: 3,
          _service_role: true,
        }).catch(() => null);
        if (!commandOk(response)) continue;

        await base44.asServiceRole.entities.Campaign.update(campaign.id, { daily_budget: newBudget, last_activity_at: clock.iso }).catch(() => {});
        await audit(base44, {
          accountId,
          decisionType: 'budget_adjustment',
          campaignId: cid,
          asin: campaign.asin,
          action: 'increase_budget',
          before: profile.budget,
          after: newBudget,
          reason: `Underpacing ${r2(pacingRatio)}x: aumento de budget da campanha vencedora dentro do limite global.`,
          risk: 'low',
          idempotencyKey: key,
          now: clock.iso,
        });
        availableBudget = Math.max(0, availableBudget - desiredIncrease);
        actionsExecuted++;
      }

      const paused = campaigns.filter((campaign: any) => {
        const reason = String(campaign.archive_reason || '');
        return norm(campaign.state || campaign.status) === 'paused' &&
          (reason.startsWith('DAYPART_RESERVE_STOP') || reason === 'OVERPACING_TEMP_STOP') &&
          stock(productByAsin.get(String(campaign.asin || ''))) > 0;
      }).slice(0, MAX_RESUMES_PER_RUN);

      for (const campaign of paused) {
        const cid = String(campaign.amazon_campaign_id || campaign.campaign_id || '');
        if (!cid) continue;
        const key = `${accountId}|pacing_resume|${cid}|${clock.date}|${clock.hour}`;
        if (!(await once(base44, accountId, key))) continue;
        actions.push({ action: 'resume_daypart_temp', campaign_id: cid });
        if (dryRun) continue;

        const response = await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
          amazon_account_id: accountId,
          operation: 'intraday_pacing_resume',
          method: 'PUT',
          path: '/sp/campaigns',
          content_type: 'application/vnd.spCampaign.v3+json',
          accept: 'application/vnd.spCampaign.v3+json',
          payload: { campaigns: [{ campaignId: cid, state: 'ENABLED' }] },
          max_attempts: 3,
          _service_role: true,
        }).catch(() => null);
        if (!commandOk(response)) continue;

        await base44.asServiceRole.entities.Campaign.update(campaign.id, {
          state: 'enabled',
          status: 'enabled',
          archive_reason: null,
          last_activity_at: clock.iso,
        }).catch(() => {});
        await audit(base44, {
          accountId,
          decisionType: 'reactivate',
          campaignId: cid,
          asin: campaign.asin,
          action: 'resume_campaign',
          reason: 'Pacing voltou a underpacing; campanha temporariamente pausada foi retomada com estoque confirmado.',
          risk: 'low',
          idempotencyKey: key,
          now: clock.iso,
        });
        actionsExecuted++;
      }
    }

    const utilizationPct = dailyCap > 0 ? confirmedSpend / dailyCap * 100 : 0;
    const capStatus = utilizationPct >= 100 ? 'cap_reached'
      : utilizationPct >= 95 ? 'cap_imminent'
      : utilizationPct >= 85 ? 'critical'
      : utilizationPct >= 70 ? 'attention'
      : 'safe';

    if (!dryRun) {
      await base44.asServiceRole.entities.AccountDailySpendController.update(controller.id, {
        confirmed_spend: r2(confirmedSpend),
        estimated_pending_spend: r2(spendVelocity * 0.25),
        projected_total_spend: r2(projectedEndOfDay),
        remaining_spend: r2(Math.max(0, dailyCap - confirmedSpend)),
        cap_status: capStatus,
        spend_pacing: spendPacing,
        pacing_ratio: r2(pacingRatio),
        current_hour_brt: clock.hour,
        projected_end_of_day_spend: r2(projectedEndOfDay),
        time_to_cap_hours: r2(timeToCap),
        underpacing_alert: spendPacing === 'underpacing',
        overpacing_alert: spendPacing === 'overpacing',
        spend_velocity_per_hour: r2(spendVelocity),
        safety_buffer: safetyBuffer,
        last_pacing_check_at: clock.iso,
        updated_at: clock.iso,
      }).catch(() => {});
    }

    return Response.json({
      ok: true,
      dry_run: dryRun,
      current_hour_brt: clock.hour,
      current_slot_class: currentSlot,
      spend_pacing: spendPacing,
      pacing_ratio: r2(pacingRatio),
      confirmed_spend: r2(confirmedSpend),
      expected_spend_by_now: r2(expectedSpend),
      projected_eod: r2(projectedEndOfDay),
      time_to_cap_hours: r2(timeToCap),
      next_elite_hour: nextEliteHour,
      actions_proposed: actions.length,
      actions_executed: actionsExecuted,
      actions,
      cap_status: capStatus,
      daily_budget: dailyCap,
      duration_ms: Date.now() - startedAt,
    });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || 'Falha no pacing intra-diário', actions_executed: 0 }, { status: 500 });
  }
});
