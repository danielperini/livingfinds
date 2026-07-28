import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';
import { eligibleForBudgetIncrease } from '../../shared/manualZeroDeliveryBootstrap.ts';

/**
 * Controlador intra-diário de orçamento e estado de campanha.
 *
 * Modos de execução:
 *   1. Checkpoint (payload.checkpoint = 'morning'|'afternoon'|'evening'|'night'):
 *      - Executa lógica específica do horário com gasto real do CampaignMetricsDaily.
 *   2. Pacing genérico (sem checkpoint):
 *      - Preserva a lógica existente de pacing, pausas e retomadas.
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

function campaignMetrics(campaign: any, targetAcos: number) {
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

async function auditDecision(base44: any, data: any) {
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
    status: data.status || 'executed',
    queue_status: 'completed',
    idempotency_key: data.idempotencyKey,
    scheduled_for: data.scheduled_for || null,
    source_function: 'runIntraDayBudgetPacingCycle',
    executed_at: data.status === 'executed' ? data.now : null,
    created_at: data.now,
    updated_at: data.now,
  }).catch(() => {});
}

async function logSync(base44: any, data: any) {
  await base44.asServiceRole.entities.SyncExecutionLog.create({
    amazon_account_id: data.accountId,
    operation: data.operation,
    trigger_type: data.trigger || 'scheduler',
    status: data.status,
    started_at: data.startedAt,
    completed_at: new Date().toISOString(),
    records_processed: data.actions || 0,
    result_summary: JSON.stringify(data.summary),
  }).catch(() => {});
}

// ── Leitura do gasto real via CampaignMetricsDaily ───────────────────────────
async function readRealSpend(base44: any, accountId: string, dateBRT: string, fallbackCampaigns: any[]): Promise<{ spend: number; source: string }> {
  const metrics = await base44.asServiceRole.entities.CampaignMetricsDaily.filter(
    { amazon_account_id: accountId, date: dateBRT }, null, 1000
  ).catch(() => []);

  if (metrics.length > 0) {
    const spend = metrics.reduce((sum: number, m: any) => sum + Number(m.spend || 0), 0);
    return { spend: r2(spend), source: 'campaign_metrics_daily' };
  }

  // Fallback: current_spend das campanhas ativas
  const spend = fallbackCampaigns.reduce((sum: number, c: any) => sum + Number(c.current_spend || 0), 0);
  return { spend: r2(spend), source: 'fallback_current_spend' };
}

// ── CHECKPOINT 06H: Calibração Matinal ──────────────────────────────────────
async function checkpointMorning(base44: any, params: any) {
  const { accountId, clock, dailyCap, controller, configs, activeCampaigns, profiles, hourScores, idempotencyKey } = params;

  // Idempotência: pular se já executado hoje
  const existing = await base44.asServiceRole.entities.OptimizationDecision.filter(
    { amazon_account_id: accountId, idempotency_key: idempotencyKey }, null, 1
  ).catch(() => []);
  if (existing.length > 0) return { skipped: true, reason: 'Já executado hoje' };

  const { spend: confirmedSpend, source: dataSource } = await readRealSpend(base44, accountId, clock.date, activeCampaigns);
  const hoursElapsed = Math.max(clock.hour, 1);
  const hoursRemaining = 24 - clock.hour; // = 18
  const spendRatePerHour = confirmedSpend / hoursElapsed;
  const projectedEod = confirmedSpend + spendRatePerHour * hoursRemaining;
  const budgetRemaining = dailyCap - confirmedSpend;
  const deviationPct = projectedEod > 0 && dailyCap > 0 ? ((projectedEod - dailyCap) / dailyCap) * 100 : 0;

  // Atualizar controller
  await base44.asServiceRole.entities.AccountDailySpendController.update(controller.id, {
    confirmed_spend: confirmedSpend,
    projected_end_of_day_spend: r2(projectedEod),
    remaining_spend: r2(budgetRemaining),
    last_pacing_check_at: clock.iso,
    checkpoint_morning_at: clock.iso,
    checkpoint_morning_spend: confirmedSpend,
    updated_at: clock.iso,
  }).catch(() => {});

  const actionsTaken: string[] = [];
  let actionsCount = 0;

  if (projectedEod > dailyCap * 1.10) {
    // Overpacing: acionar dayparting nas horas fracas
    const weakHours = Object.entries(hourScores)
      .filter(([h, s]) => Number(h) > clock.hour && Number(s) < 40)
      .map(([h]) => Number(h));

    if (weakHours.length > 0) {
      await base44.asServiceRole.functions.invoke('runCanonicalDaypartingEngine', {
        amazon_account_id: accountId,
        force: true,
        checkpoint_mode: true,
        pacing_deviation_pct: r2(deviationPct),
        _service_role: true,
      }).catch(() => {});
      actionsTaken.push(`Dayparting ativado: desvio +${r2(deviationPct)}% (${weakHours.length}h fracas)`);
      actionsCount++;
    }
  } else if (projectedEod <= dailyCap * 1.05) {
    // Underpacing: aumentar bid em campanhas conservadoras sem impressões
    const minImpressions = Number(configs[0]?.min_daily_impressions || 100);
    const conservative = profiles.filter((p: any) =>
      p.winner && Number(p.campaign.impressions || 0) < minImpressions && p.budget > 0
    ).slice(0, 5);

    for (const p of conservative) {
      const campaign = p.campaign;
      const cid = String(campaign.amazon_campaign_id || campaign.campaign_id || '');
      if (!cid) continue;
      const key = `${accountId}|checkpoint_morning_bid_up|${cid}|${clock.date}`;
      if (!(await once(base44, accountId, key))) continue;

      // Invocar ajuste de bid via engine existente
      await base44.asServiceRole.functions.invoke('runCanonicalDaypartingEngine', {
        amazon_account_id: accountId,
        force: true,
        checkpoint_mode: true,
        pacing_deviation_pct: r2(deviationPct),
        _service_role: true,
      }).catch(() => {});
      actionsTaken.push(`Bid boost: ${conservative.length} campanhas conservadoras`);
      actionsCount += conservative.length;
      break; // Invocar uma vez, engine processa todas
    }
  }

  await auditDecision(base44, {
    accountId,
    decisionType: 'budget_checkpoint_morning',
    campaignId: 'account',
    action: 'checkpoint_morning',
    reason: `Checkpoint 06h: gasto ${fmtBRL(confirmedSpend)}, projetado EOD ${fmtBRL(projectedEod)}, desvio ${r2(deviationPct)}%`,
    idempotencyKey,
    status: 'executed',
    now: clock.iso,
  });

  return { confirmedSpend, projectedEod, deviationPct: r2(deviationPct), budgetRemaining, actionsCount, actionsTaken, dataSource };
}

// ── CHECKPOINT 13H: Rebalanceamento do Meio-Dia ─────────────────────────────
async function checkpointAfternoon(base44: any, params: any) {
  const { accountId, clock, dailyCap, controller, activeCampaigns, profiles, idempotencyKey } = params;

  const existing = await base44.asServiceRole.entities.OptimizationDecision.filter(
    { amazon_account_id: accountId, idempotency_key: idempotencyKey }, null, 1
  ).catch(() => []);
  if (existing.length > 0) return { skipped: true, reason: 'Já executado hoje' };

  const { spend: confirmedSpend, source: dataSource } = await readRealSpend(base44, accountId, clock.date, activeCampaigns);
  const idealMidSpend = dailyCap * (13 / 24);
  const deviationPct = idealMidSpend > 0 ? ((confirmedSpend - idealMidSpend) / idealMidSpend) * 100 : 0;
  const budgetRemaining = dailyCap - confirmedSpend;
  const hoursRemaining = 11;
  const projectedEod = confirmedSpend + (confirmedSpend / Math.max(clock.hour, 1)) * hoursRemaining;

  await base44.asServiceRole.entities.AccountDailySpendController.update(controller.id, {
    confirmed_spend: confirmedSpend,
    projected_end_of_day_spend: r2(projectedEod),
    remaining_spend: r2(budgetRemaining),
    last_pacing_check_at: clock.iso,
    checkpoint_afternoon_at: clock.iso,
    checkpoint_afternoon_spend: confirmedSpend,
    updated_at: clock.iso,
  }).catch(() => {});

  const actionsTaken: string[] = [];
  let actionsCount = 0;

  if (deviationPct > 15) {
    // Gastando demais: acionar dayparting nas próximas 3h de menor score
    await base44.asServiceRole.functions.invoke('runCanonicalDaypartingEngine', {
      amazon_account_id: accountId,
      force: true,
      checkpoint_mode: true,
      pacing_deviation_pct: r2(deviationPct),
      _service_role: true,
    }).catch(() => {});

    // Pausar Tier C e D
    const slowDown = profiles.filter((p: any) => ['C', 'D'].includes(p.tier) && !p.winner).slice(0, 3);
    for (const profile of slowDown) {
      const campaign = profile.campaign;
      const cid = String(campaign.amazon_campaign_id || campaign.campaign_id || '');
      if (!cid) continue;
      const key = `${accountId}|checkpoint_afternoon_pause|${cid}|${clock.date}`;
      if (!(await once(base44, accountId, key))) continue;
      await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
        amazon_account_id: accountId, operation: 'checkpoint_afternoon_pause',
        method: 'PUT', path: '/sp/campaigns',
        content_type: 'application/vnd.spCampaign.v3+json',
        accept: 'application/vnd.spCampaign.v3+json',
        payload: { campaigns: [{ campaignId: cid, state: 'PAUSED' }] },
        max_attempts: 2, _service_role: true,
      }).catch(() => {});
      await base44.asServiceRole.entities.Campaign.update(campaign.id, {
        state: 'paused', status: 'paused',
        archive_reason: 'CHECKPOINT_13H_SLOW_DOWN',
        last_activity_at: clock.iso,
      }).catch(() => {});
      actionsCount++;
    }
    actionsTaken.push(`Daypart+pause: desvio +${r2(deviationPct)}% — ${actionsCount} campanhas Tier C/D`);
  } else if (deviationPct < -15) {
    // Gastando pouco: aumentar budget de vencedoras
    const winners = profiles.filter((p: any) => eligibleForBudgetIncrease(p)).slice(0, 5);
    for (const profile of winners) {
      const campaign = profile.campaign;
      const cid = String(campaign.amazon_campaign_id || campaign.campaign_id || '');
      if (!cid) continue;
      const newBudget = r2(profile.budget * 1.15);
      if (newBudget <= profile.budget + 0.49) continue;
      const key = `${accountId}|checkpoint_afternoon_budget_up|${cid}|${clock.date}`;
      if (!(await once(base44, accountId, key))) continue;
      await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
        amazon_account_id: accountId, operation: 'checkpoint_afternoon_budget_up',
        method: 'PUT', path: '/sp/campaigns',
        content_type: 'application/vnd.spCampaign.v3+json',
        accept: 'application/vnd.spCampaign.v3+json',
        payload: { campaigns: [{ campaignId: cid, budget: { budget: newBudget, budgetType: 'DAILY' } }] },
        max_attempts: 2, _service_role: true,
      }).catch(() => {});
      await base44.asServiceRole.entities.Campaign.update(campaign.id, {
        daily_budget: newBudget, last_activity_at: clock.iso,
      }).catch(() => {});
      actionsCount++;
    }
    actionsTaken.push(`Budget +15% em ${actionsCount} vencedoras: underpacing ${r2(deviationPct)}%`);

    // Acionar dayparting em modo boost
    await base44.asServiceRole.functions.invoke('runCanonicalDaypartingEngine', {
      amazon_account_id: accountId, force: true,
      checkpoint_mode: true, pacing_deviation_pct: r2(deviationPct), _service_role: true,
    }).catch(() => {});
  } else {
    actionsTaken.push(`Dentro da faixa: desvio ${r2(deviationPct)}% — nenhuma ação necessária`);
  }

  await auditDecision(base44, {
    accountId, decisionType: 'budget_checkpoint_afternoon', campaignId: 'account',
    action: 'checkpoint_afternoon',
    reason: `Checkpoint 13h: gasto ${fmtBRL(confirmedSpend)}, ideal ${fmtBRL(idealMidSpend)}, desvio ${r2(deviationPct)}%`,
    idempotencyKey, status: 'executed', now: clock.iso,
  });

  return { confirmedSpend, projectedEod, deviationPct: r2(deviationPct), budgetRemaining, actionsCount, actionsTaken, dataSource };
}

// ── CHECKPOINT 19H: Proteção da Janela Noturna ──────────────────────────────
async function checkpointEvening(base44: any, params: any) {
  const { accountId, clock, dailyCap, controller, activeCampaigns, campaigns, profiles, idempotencyKey } = params;

  const existing = await base44.asServiceRole.entities.OptimizationDecision.filter(
    { amazon_account_id: accountId, idempotency_key: idempotencyKey }, null, 1
  ).catch(() => []);
  if (existing.length > 0) return { skipped: true, reason: 'Já executado hoje' };

  const { spend: confirmedSpend, source: dataSource } = await readRealSpend(base44, accountId, clock.date, activeCampaigns);
  const hoursElapsed = Math.max(clock.hour, 1);
  const hoursRemaining = 5;
  const spendRatePerHour = confirmedSpend / hoursElapsed;
  const targetRemainingSpend = dailyCap - confirmedSpend;
  const sustainableHourlyRate = targetRemainingSpend / hoursRemaining;
  const projectedEod = confirmedSpend + spendRatePerHour * hoursRemaining;
  const budgetRemaining = targetRemainingSpend;

  await base44.asServiceRole.entities.AccountDailySpendController.update(controller.id, {
    confirmed_spend: confirmedSpend,
    projected_end_of_day_spend: r2(projectedEod),
    remaining_spend: r2(budgetRemaining),
    last_pacing_check_at: clock.iso,
    checkpoint_evening_at: clock.iso,
    checkpoint_evening_spend: confirmedSpend,
    updated_at: clock.iso,
  }).catch(() => {});

  const actionsTaken: string[] = [];
  let actionsCount = 0;

  if (spendRatePerHour > sustainableHourlyRate * 1.20) {
    // Overpacing noturno: pausar Tier D
    const tierD = profiles.filter((p: any) => p.tier === 'D' && !p.winner && active(p.campaign.state || p.campaign.status)).slice(0, 4);
    for (const profile of tierD) {
      const campaign = profile.campaign;
      const cid = String(campaign.amazon_campaign_id || campaign.campaign_id || '');
      if (!cid) continue;
      const key = `${accountId}|checkpoint_evening_pause|${cid}|${clock.date}`;
      if (!(await once(base44, accountId, key))) continue;
      await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
        amazon_account_id: accountId, operation: 'checkpoint_evening_pause',
        method: 'PUT', path: '/sp/campaigns',
        content_type: 'application/vnd.spCampaign.v3+json', accept: 'application/vnd.spCampaign.v3+json',
        payload: { campaigns: [{ campaignId: cid, state: 'PAUSED' }] }, max_attempts: 2, _service_role: true,
      }).catch(() => {});
      await base44.asServiceRole.entities.Campaign.update(campaign.id, {
        state: 'paused', status: 'paused',
        archive_reason: 'CHECKPOINT_19H_TEMP_STOP', last_activity_at: clock.iso,
      }).catch(() => {});
      actionsCount++;
    }
    actionsTaken.push(`Pausa preventiva noturna: ${actionsCount} campanhas Tier D`);
  } else if (spendRatePerHour < sustainableHourlyRate * 0.80) {
    // Underpacing noturno: retomar campanhas pausadas pelo motor
    const paused = campaigns.filter((c: any) => {
      const reason = String(c.archive_reason || '');
      return norm(c.state || c.status) === 'paused' &&
        (reason.includes('CHECKPOINT') || reason.startsWith('DAYPART_RESERVE_STOP') || reason === 'OVERPACING_TEMP_STOP');
    }).slice(0, 5);
    for (const campaign of paused) {
      const cid = String(campaign.amazon_campaign_id || campaign.campaign_id || '');
      if (!cid) continue;
      const key = `${accountId}|checkpoint_evening_resume|${cid}|${clock.date}`;
      if (!(await once(base44, accountId, key))) continue;
      await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
        amazon_account_id: accountId, operation: 'checkpoint_evening_resume',
        method: 'PUT', path: '/sp/campaigns',
        content_type: 'application/vnd.spCampaign.v3+json', accept: 'application/vnd.spCampaign.v3+json',
        payload: { campaigns: [{ campaignId: cid, state: 'ENABLED' }] }, max_attempts: 2, _service_role: true,
      }).catch(() => {});
      await base44.asServiceRole.entities.Campaign.update(campaign.id, {
        state: 'enabled', status: 'enabled', archive_reason: null, last_activity_at: clock.iso,
      }).catch(() => {});
      actionsCount++;
    }
    actionsTaken.push(`Retomada noturna: ${actionsCount} campanhas`);
  } else {
    actionsTaken.push(`Dentro da faixa noturna: ritmo ${fmtBRL(spendRatePerHour)}/h vs sustentável ${fmtBRL(sustainableHourlyRate)}/h`);
  }

  await auditDecision(base44, {
    accountId, decisionType: 'budget_checkpoint_evening', campaignId: 'account',
    action: 'checkpoint_evening',
    reason: `Checkpoint 19h: gasto ${fmtBRL(confirmedSpend)}, ritmo ${fmtBRL(spendRatePerHour)}/h, sustentável ${fmtBRL(sustainableHourlyRate)}/h`,
    idempotencyKey, status: 'executed', now: clock.iso,
  });

  return { confirmedSpend, projectedEod, spendRatePerHour: r2(spendRatePerHour), sustainableHourlyRate: r2(sustainableHourlyRate), budgetRemaining, actionsCount, actionsTaken, dataSource };
}

// ── CHECKPOINT 22H: Proteção Final + Pausa Calculada ────────────────────────
async function checkpointNight(base44: any, params: any) {
  const { accountId, clock, dailyCap, controller, activeCampaigns, campaigns, profiles, cfg, idempotencyKey } = params;

  const existing = await base44.asServiceRole.entities.OptimizationDecision.filter(
    { amazon_account_id: accountId, idempotency_key: idempotencyKey }, null, 1
  ).catch(() => []);
  if (existing.length > 0) return { skipped: true, reason: 'Já executado hoje' };

  const { spend: confirmedSpend, source: dataSource } = await readRealSpend(base44, accountId, clock.date, activeCampaigns);
  const spendRatePerHour = confirmedSpend / 22;
  const budgetRemaining = dailyCap - confirmedSpend;
  const hoursUntilCap = spendRatePerHour > 0 ? budgetRemaining / spendRatePerHour : 99;
  const pauseHourBRT = Math.floor(22 + hoursUntilCap);
  const projectedEod = confirmedSpend + spendRatePerHour * 2;

  await base44.asServiceRole.entities.AccountDailySpendController.update(controller.id, {
    confirmed_spend: confirmedSpend,
    projected_end_of_day_spend: r2(projectedEod),
    remaining_spend: r2(budgetRemaining),
    last_pacing_check_at: clock.iso,
    checkpoint_night_at: clock.iso,
    checkpoint_night_spend: confirmedSpend,
    scheduled_pause_hour: pauseHourBRT < 24 ? pauseHourBRT : null,
    updated_at: clock.iso,
  }).catch(() => {});

  const actionsTaken: string[] = [];
  let actionsCount = 0;
  let scheduledPauseHour: number | null = null;

  if (pauseHourBRT < 23 && spendRatePerHour > 0 && budgetRemaining > 0) {
    // Agendar pausa de não-vencedoras
    scheduledPauseHour = pauseHourBRT;
    const nonWinners = profiles.filter((p: any) => !p.winner && active(p.campaign.state || p.campaign.status));
    const today = clock.date;
    const pauseISO = new Date(`${today}T${String(pauseHourBRT).padStart(2, '0')}:00:00-03:00`).toISOString();

    for (const profile of nonWinners.slice(0, 10)) {
      const campaign = profile.campaign;
      const cid = String(campaign.amazon_campaign_id || campaign.campaign_id || '');
      if (!cid) continue;
      const key = `${accountId}|checkpoint_night_sched_pause|${cid}|${clock.date}`;
      if (!(await once(base44, accountId, key))) continue;
      await auditDecision(base44, {
        accountId, decisionType: 'scheduled_pause', campaignId: cid,
        action: 'schedule_pause',
        reason: `Checkpoint 22h: budget será atingido às ${pauseHourBRT}h BRT. Agendando pausa de não-vencedora.`,
        idempotencyKey: key, status: 'pending',
        scheduled_for: pauseISO, now: clock.iso,
      });
      actionsCount++;
    }
    actionsTaken.push(`Pausa agendada para ${pauseHourBRT}h BRT em ${actionsCount} campanhas não-vencedoras`);
  } else {
    actionsTaken.push(`Budget suficiente: pausa não necessária (hora estimada de cap: ${pauseHourBRT >= 24 ? 'após meia-noite' : pauseHourBRT + 'h'})`);
  }

  // Proteção de vencedoras: aumentar budget se necessário para cobrir até 23:59
  const maxBudgetIncreasePct = Math.min((Number(cfg?.max_budget_increase_pct) || 20) / 100, 0.20);
  const winners = profiles.filter((p: any) => eligibleForBudgetIncrease(p) && (p.tier === 'A' || p.tier === 'B'));
  let budgetBoosts = 0;

  for (const profile of winners) {
    const campaign = profile.campaign;
    const cid = String(campaign.amazon_campaign_id || campaign.campaign_id || '');
    if (!cid || profile.budget <= 0) continue;
    const hoursUntilMidnight = 24 - clock.hour;
    const budgetNeeded = r2(spendRatePerHour * hoursUntilMidnight);
    const budgetRatioRemaining = profile.budget > 0 ? budgetRemaining / profile.budget : 1;
    if (budgetRatioRemaining >= 0.15) continue; // Suficiente
    if (budgetNeeded <= profile.budget) continue;

    const newBudget = r2(Math.min(profile.budget * (1 + maxBudgetIncreasePct), budgetNeeded));
    if (newBudget <= profile.budget + 0.49) continue;
    const key = `${accountId}|checkpoint_night_winner_budget|${cid}|${clock.date}`;
    if (!(await once(base44, accountId, key))) continue;

    await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
      amazon_account_id: accountId, operation: 'checkpoint_night_winner_budget',
      method: 'PUT', path: '/sp/campaigns',
      content_type: 'application/vnd.spCampaign.v3+json', accept: 'application/vnd.spCampaign.v3+json',
      payload: { campaigns: [{ campaignId: cid, budget: { budget: newBudget, budgetType: 'DAILY' } }] },
      max_attempts: 3, _service_role: true,
    }).catch(() => {});
    await base44.asServiceRole.entities.Campaign.update(campaign.id, {
      daily_budget: newBudget, last_activity_at: clock.iso,
    }).catch(() => {});
    await auditDecision(base44, {
      accountId, decisionType: 'budget_adjustment', campaignId: cid,
      action: 'increase_budget', before: profile.budget, after: newBudget,
      reason: `Checkpoint 22h: vencedora tier ${profile.tier} precisa de ${fmtBRL(budgetNeeded)} até 23:59 — budget aumentado para ${fmtBRL(newBudget)}.`,
      idempotencyKey: key, status: 'executed', now: clock.iso,
    });
    budgetBoosts++;
  }

  if (budgetBoosts > 0) actionsTaken.push(`Budget aumentado em ${budgetBoosts} vencedoras para cobertura até 23:59`);

  // Executar pausas calculadas de checkpoints anteriores cujo scheduled_for <= agora
  const pendingPauses = await base44.asServiceRole.entities.OptimizationDecision.filter({
    amazon_account_id: accountId,
    decision_type: 'scheduled_pause',
    status: 'pending',
  }, '-created_at', 50).catch(() => []);

  const nowMs = Date.now();
  let executedScheduledPauses = 0;
  for (const decision of pendingPauses) {
    const scheduledFor = decision.scheduled_for;
    if (!scheduledFor || new Date(scheduledFor).getTime() > nowMs) continue;
    const cid = decision.campaign_id;
    if (!cid) continue;

    await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
      amazon_account_id: accountId, operation: 'scheduled_pause_execution',
      method: 'PUT', path: '/sp/campaigns',
      content_type: 'application/vnd.spCampaign.v3+json', accept: 'application/vnd.spCampaign.v3+json',
      payload: { campaigns: [{ campaignId: cid, state: 'PAUSED' }] },
      max_attempts: 3, _service_role: true,
    }).catch(() => {});

    // Atualizar campanha local
    const campRec = campaigns.find((c: any) =>
      c.campaign_id === cid || c.amazon_campaign_id === cid
    );
    if (campRec) {
      await base44.asServiceRole.entities.Campaign.update(campRec.id, {
        state: 'paused', status: 'paused',
        archive_reason: 'BUDGET_CAP_SCHEDULED_PAUSE', last_activity_at: clock.iso,
      }).catch(() => {});
    }
    await base44.asServiceRole.entities.OptimizationDecision.update(decision.id, {
      status: 'executed', executed_at: clock.iso,
    }).catch(() => {});
    executedScheduledPauses++;
    actionsCount++;
  }
  if (executedScheduledPauses > 0) actionsTaken.push(`${executedScheduledPauses} pausas agendadas executadas`);

  await auditDecision(base44, {
    accountId, decisionType: 'budget_checkpoint_night', campaignId: 'account',
    action: 'checkpoint_night',
    reason: `Checkpoint 22h: gasto ${fmtBRL(confirmedSpend)}, ritmo ${fmtBRL(spendRatePerHour)}/h, hora pausa: ${scheduledPauseHour ?? 'N/A'}, ${budgetBoosts} boosts vencedoras`,
    idempotencyKey, status: 'executed', now: clock.iso,
  });

  return { confirmedSpend, projectedEod, spendRatePerHour: r2(spendRatePerHour), budgetRemaining, scheduledPauseHour, budgetBoosts, actionsCount, actionsTaken, dataSource };
}

// ── Helper de formatação (usado nos logs inline) ─────────────────────────────
function fmtBRL(v: number) {
  return `R$${Number(v || 0).toFixed(2)}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// HANDLER PRINCIPAL
// ═══════════════════════════════════════════════════════════════════════════

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
    const checkpoint = body.checkpoint as string | undefined;

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
    const hourScores = parseObject(controller.hour_value_scores);
    const productByAsin = new Map(products.map((product: any) => [String(product.asin || ''), product]));
    const activeCampaigns = campaigns.filter((c: any) =>
      active(c.state || c.status) && c.archived !== true &&
      stock(productByAsin.get(String(c.asin || ''))) > 0,
    );
    const profiles = activeCampaigns.map((c: any) => ({ campaign: c, ...campaignMetrics(c, targetAcos) }));

    // ── MODO CHECKPOINT ─────────────────────────────────────────────────────
    if (checkpoint) {
      const iKey = `${accountId}|checkpoint_${checkpoint}|${clock.date}`;
      const commonParams = { accountId, clock, dailyCap, controller, configs, cfg, activeCampaigns, campaigns, profiles, hourScores, idempotencyKey: iKey };
      let result: any;

      if (checkpoint === 'morning') {
        result = await checkpointMorning(base44, commonParams);
      } else if (checkpoint === 'afternoon') {
        result = await checkpointAfternoon(base44, commonParams);
      } else if (checkpoint === 'evening') {
        result = await checkpointEvening(base44, commonParams);
      } else if (checkpoint === 'night') {
        result = await checkpointNight(base44, commonParams);
      } else {
        return Response.json({ ok: false, error: `Checkpoint desconhecido: ${checkpoint}` }, { status: 400 });
      }

      const operationMap: Record<string, string> = {
        morning: 'budget_checkpoint_morning',
        afternoon: 'budget_checkpoint_afternoon',
        evening: 'budget_checkpoint_evening',
        night: 'budget_checkpoint_night',
      };

      await logSync(base44, {
        accountId, operation: operationMap[checkpoint], trigger: 'scheduler',
        status: result.skipped ? 'skipped' : result.error ? 'error' : 'success',
        startedAt: clock.iso, actions: result.actionsCount || 0,
        summary: {
          checkpoint, confirmed_spend: result.confirmedSpend, daily_cap: dailyCap,
          deviation_pct: result.deviationPct, hours_remaining: 24 - clock.hour,
          actions_taken: result.actionsTaken || [], projected_eod: result.projectedEod,
          data_source: result.dataSource, skipped: result.skipped || false,
          scheduled_pause_hour: result.scheduledPauseHour,
          budget_boosts: result.budgetBoosts,
        },
      });

      return Response.json({
        ok: true, checkpoint, ...result, daily_cap: dailyCap,
        current_hour_brt: clock.hour, duration_ms: Date.now() - startedAt,
      });
    }

    // ── MODO GENÉRICO DE PACING (lógica existente) ──────────────────────────
    const pacingCurve = parseObject(controller.pacing_curve);
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
      if (Number(hourScores?.[hour] || 0) >= 75) { nextEliteHour = hour; break; }
    }

    const actions: any[] = [];
    let actionsExecuted = 0;
    let remainingActive = activeCampaigns.length;

    const pauseCampaignFn = async (profile: any, reasonCode: string, reason: string) => {
      const campaign = profile.campaign;
      const cid = String(campaign.amazon_campaign_id || campaign.campaign_id || '');
      if (!cid || remainingActive <= 1 || profile.winner) return;
      const key = `${accountId}|pacing_pause|${cid}|${reasonCode}|${clock.date}|${clock.hour}`;
      if (!(await once(base44, accountId, key))) return;
      actions.push({ action: 'pause_campaign', campaign_id: cid, reason: reasonCode });
      if (dryRun) return;
      const response = await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
        amazon_account_id: accountId, operation: 'intraday_pacing_pause',
        method: 'PUT', path: '/sp/campaigns',
        content_type: 'application/vnd.spCampaign.v3+json', accept: 'application/vnd.spCampaign.v3+json',
        payload: { campaigns: [{ campaignId: cid, state: 'PAUSED' }] }, max_attempts: 3, _service_role: true,
      }).catch(() => null);
      if (!commandOk(response)) return;
      await base44.asServiceRole.entities.Campaign.update(campaign.id, {
        state: 'paused', status: 'paused',
        original_state: campaign.original_state || 'enabled',
        archive_reason: reasonCode, last_activity_at: clock.iso,
      }).catch(() => {});
      await auditDecision(base44, {
        accountId, decisionType: 'pause', campaignId: cid, asin: campaign.asin,
        action: 'pause_campaign', reason, risk: 'low', idempotencyKey: key, now: clock.iso,
      });
      remainingActive--;
      actionsExecuted++;
    };

    if (spendPacing === 'overpacing') {
      const waste = profiles.filter((p) => p.tier === 'D' && p.spend > dailyCap * 0.05 && !p.winner).sort((a, b) => b.spend - a.spend).slice(0, MAX_PAUSES_PER_RUN);
      for (const profile of waste) {
        await pauseCampaignFn(profile, 'OVERPACING_TEMP_STOP', `Overpacing ${r2(pacingRatio)}x: campanha Tier D sem proteção de performance.`);
      }
    }

    const reserveNeeded = ['WEAK', 'LOSS'].includes(currentSlot) && nextEliteHour !== null && nextEliteHour - clock.hour <= 4 && confirmedSpend >= effectiveCap * 0.80;
    if (reserveNeeded) {
      const reserve = profiles.filter((p) => ['C', 'D'].includes(p.tier) && p.spend > 0 && !p.winner && active(p.campaign.state || p.campaign.status)).sort((a, b) => b.spend - a.spend).slice(0, Math.min(3, MAX_PAUSES_PER_RUN));
      for (const profile of reserve) {
        await pauseCampaignFn(profile, `DAYPART_RESERVE_STOP:resume_at_${nextEliteHour}h`, `Reserva de orçamento para slot forte às ${nextEliteHour}h BRT.`);
      }
    }

    if (spendPacing === 'underpacing' && controller.budget_mode !== 'PROFIT_MAX') {
      let availableBudget = Math.max(0, dailyCap - totalCampaignBudgets);
      const winners = profiles.filter((p) => eligibleForBudgetIncrease(p) && p.budget > 0).sort((a, b) => a.acos - b.acos).slice(0, 5);
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
          amazon_account_id: accountId, operation: 'intraday_pacing_budget_up',
          method: 'PUT', path: '/sp/campaigns',
          content_type: 'application/vnd.spCampaign.v3+json', accept: 'application/vnd.spCampaign.v3+json',
          payload: { campaigns: [{ campaignId: cid, budget: { budget: newBudget, budgetType: 'DAILY' } }] },
          max_attempts: 3, _service_role: true,
        }).catch(() => null);
        if (!commandOk(response)) continue;
        await base44.asServiceRole.entities.Campaign.update(campaign.id, { daily_budget: newBudget, last_activity_at: clock.iso }).catch(() => {});
        await auditDecision(base44, {
          accountId, decisionType: 'budget_adjustment', campaignId: cid, asin: campaign.asin,
          action: 'increase_budget', before: profile.budget, after: newBudget,
          reason: `Underpacing ${r2(pacingRatio)}x: aumento de budget da campanha vencedora.`,
          risk: 'low', idempotencyKey: key, now: clock.iso,
        });
        availableBudget = Math.max(0, availableBudget - desiredIncrease);
        actionsExecuted++;
      }

      const paused = campaigns.filter((c: any) => {
        const reason = String(c.archive_reason || '');
        return norm(c.state || c.status) === 'paused' &&
          (reason.startsWith('DAYPART_RESERVE_STOP') || reason === 'OVERPACING_TEMP_STOP') &&
          stock(productByAsin.get(String(c.asin || ''))) > 0;
      }).slice(0, MAX_RESUMES_PER_RUN);
      for (const campaign of paused) {
        const cid = String(campaign.amazon_campaign_id || campaign.campaign_id || '');
        if (!cid) continue;
        const key = `${accountId}|pacing_resume|${cid}|${clock.date}|${clock.hour}`;
        if (!(await once(base44, accountId, key))) continue;
        actions.push({ action: 'resume_daypart_temp', campaign_id: cid });
        if (dryRun) continue;
        const response = await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
          amazon_account_id: accountId, operation: 'intraday_pacing_resume',
          method: 'PUT', path: '/sp/campaigns',
          content_type: 'application/vnd.spCampaign.v3+json', accept: 'application/vnd.spCampaign.v3+json',
          payload: { campaigns: [{ campaignId: cid, state: 'ENABLED' }] },
          max_attempts: 3, _service_role: true,
        }).catch(() => null);
        if (!commandOk(response)) continue;
        await base44.asServiceRole.entities.Campaign.update(campaign.id, {
          state: 'enabled', status: 'enabled', archive_reason: null, last_activity_at: clock.iso,
        }).catch(() => {});
        await auditDecision(base44, {
          accountId, decisionType: 'reactivate', campaignId: cid, asin: campaign.asin,
          action: 'resume_campaign', reason: 'Pacing voltou a underpacing; campanha temporariamente pausada foi retomada.',
          risk: 'low', idempotencyKey: key, now: clock.iso,
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
      ok: true, dry_run: dryRun, current_hour_brt: clock.hour,
      current_slot_class: currentSlot, spend_pacing: spendPacing,
      pacing_ratio: r2(pacingRatio), confirmed_spend: r2(confirmedSpend),
      expected_spend_by_now: r2(expectedSpend), projected_eod: r2(projectedEndOfDay),
      time_to_cap_hours: r2(timeToCap), next_elite_hour: nextEliteHour,
      actions_proposed: actions.length, actions_executed: actionsExecuted, actions,
      cap_status: capStatus, daily_budget: dailyCap, duration_ms: Date.now() - startedAt,
    });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || 'Falha no pacing intra-diário', actions_executed: 0 }, { status: 500 });
  }
});
