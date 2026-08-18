import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';
import { runCanonicalNativeDaypartSync } from '../../shared/canonicalNativeDaypartSync.ts';
import { readConfirmedTodaySpend, resolveDailyCap } from '../../shared/portfolioBudgetMath.ts';
import { evaluateCentralGoals } from '../../shared/centralPerformanceGoals.ts';

/**
 * Motor canônico de dayparting híbrido.
 *
 * - bid-base persistido por entidade;
 * - envelope absoluto 0,50x–1,50x;
 * - regras Amazon usadas somente quando cobrem o dia/hora/campanha atual;
 * - pacing, lucro, safe CPC e limite transitório podem pausar a regra nativa;
 * - subentrega econômica pode autorizar micro-recuperação de exposição;
 * - dry-run não persiste nada.
 */
const ENGINE_VERSION = 'canonical-dayparting-v5-sales-recovery';
const MIN_REDUCTION_IMPRESSIONS = 200;
const MIN_REDUCTION_CLICKS = 10;
const MIN_REDUCTION_SPEND = 12;
const DAY_NAMES = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const r2 = (value: number) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
const norm = (value: any) => String(value || '').trim().toLowerCase();
const active = (value: any) => ['enabled', 'active'].includes(norm(value));

function plannedBudgetShare(hour: number) {
  if (hour < 7) return 0.04;
  if (hour < 10) return 0.22;
  if (hour < 12) return 0.34;
  if (hour < 14) return 0.45;
  if (hour < 17) return 0.55;
  if (hour < 19) return 0.68;
  if (hour < 22) return 0.86;
  return 1;
}

function isDemandProbeWindow(hour: number) {
  return (hour >= 7 && hour < 10) || (hour >= 11 && hour < 14);
}

function brtClock() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value || '';
  const dow: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    iso: now.toISOString(),
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hour: Number(get('hour') || 0) % 24,
    minute: Number(get('minute') || 0),
    dayOfWeek: dow[get('weekday')] ?? new Date(Date.now() - 3 * 3600000).getUTCDay(),
  };
}

function stock(product: any) {
  return Number(product?.fba_inventory ?? product?.available_quantity ?? product?.fulfillable_quantity ?? product?.stock ?? 0);
}

function campaignType(campaign: any): 'AUTO' | 'MANUAL' {
  const explicit = String(campaign?.targeting_type || campaign?.targetingType || '').toUpperCase();
  if (explicit === 'AUTO' || explicit === 'MANUAL') return explicit;
  return /manual/i.test(String(campaign?.name || campaign?.campaign_name || '')) ? 'MANUAL' : 'AUTO';
}

function amazonCampaignId(campaign: any) {
  return String(campaign?.amazon_campaign_id || campaign?.campaign_id || '');
}

function parseObject(value: any) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(String(value)); } catch { return {}; }
}

function classify(value: any): 'ELITE_TIME' | 'STRONG_TIME' | 'NORMAL_TIME' | 'WEAK_TIME' | 'LOSS_TIME' | 'COLLECTING_DATA' {
  const text = String(value || '').toUpperCase();
  if (text === 'PEAK_ELITE' || text === 'ELITE_TIME') return 'ELITE_TIME';
  if (text === 'PEAK_STRONG' || text === 'STRONG_TIME') return 'STRONG_TIME';
  if (text === 'NORMAL' || text === 'NORMAL_TIME') return 'NORMAL_TIME';
  if (text === 'WEAK' || text === 'WEAK_TIME') return 'WEAK_TIME';
  if (text === 'LOSS' || text === 'LOSS_TIME') return 'LOSS_TIME';
  return 'COLLECTING_DATA';
}

function timestamp(row: any) {
  return new Date(row?.updated_at || row?.created_at || row?.last_calculated_at || 0).getTime();
}

function isCanonicalAudit(row: any) {
  return String(row?.rule_id || '') === 'canonical_bid_envelope_050_150' ||
    String(row?.rule_version || '').startsWith('canonical-dayparting');
}

function isDayAggregatePattern(row: any) {
  const granularity = String(row?.granularity || row?.metric_granularity || '').toUpperCase();
  const label = String(row?.slot_label || '').toLowerCase();
  if (granularity === 'DAY' || label.endsWith('_dia')) return true;
  return Number(row?.hour) === 0 && !row?.asin && !row?.campaign_id && Number(row?.occurrences || 0) > 24;
}

function resolveSlot(decisions: any[], patterns: any[], controller: any, dayOfWeek: number, hour: number) {
  const learnedDecision = decisions
    .filter((row) => Number(row.day_of_week) === dayOfWeek && Number(row.hour) === hour && !isCanonicalAudit(row))
    .sort((a, b) => timestamp(b) - timestamp(a))[0] || null;
  const pattern = patterns
    .filter((row) => Number(row.day_of_week) === dayOfWeek && Number(row.hour) === hour && !isDayAggregatePattern(row))
    .sort((a, b) => timestamp(b) - timestamp(a))[0] || null;

  if (learnedDecision && (!pattern || timestamp(learnedDecision) >= timestamp(pattern))) {
    return {
      classification: classify(learnedDecision.slot_classification),
      score: Number(learnedDecision.time_slot_score || 0),
      mature: learnedDecision.data_mature === true || ['HIGH', 'VERY_HIGH'].includes(String(learnedDecision.data_confidence || '')),
      source: 'DaypartingDecision_learned',
      source_updated_at: learnedDecision.updated_at || learnedDecision.created_at || null,
    };
  }
  if (pattern) {
    return {
      classification: classify(pattern.classification),
      score: Number(pattern.peak_score || 0),
      mature: Number(pattern.occurrences || 0) >= 3 && String(pattern.classification || '') !== 'INSUFFICIENT_DATA',
      source: 'HourlySalesPattern',
      source_updated_at: pattern.updated_at || pattern.created_at || null,
    };
  }

  const scores = parseObject(controller?.hour_value_scores);
  const score = Number(scores?.[hour] || 0);
  return {
    classification: score >= 90 ? 'ELITE_TIME'
      : score >= 75 ? 'STRONG_TIME'
      : score >= 55 ? 'NORMAL_TIME'
      : score >= 35 ? 'WEAK_TIME'
      : score > 0 ? 'LOSS_TIME'
      : 'COLLECTING_DATA',
    score,
    mature: score > 0,
    source: score > 0 ? 'AccountDailySpendController' : 'no_hourly_data',
    source_updated_at: controller?.updated_at || null,
  };
}

function campaignMetrics(campaign: any) {
  const spend = Number(campaign.current_spend ?? campaign.spend ?? 0);
  const sales = Number(campaign.sales || 0);
  const orders = Number(campaign.orders || 0);
  const impressions = Number(campaign.impressions || 0);
  const clicks = Number(campaign.clicks || 0);
  const storedAcos = Number(campaign.acos || 0);
  const acos = sales > 0 ? (spend / sales) * 100 : storedAcos > 0 ? storedAcos : null;
  return { spend, sales, orders, impressions, clicks, acos };
}

function overridePct(value: any): number | null {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  if (number >= 1 && number <= 3) return Math.max(0, (number - 1) * 100);
  if (number < 1) return number * 100;
  return number;
}

function toMinutes(value: any) {
  const [hour, minute] = String(value || '00:00').split(':').map(Number);
  return (Number.isFinite(hour) ? hour : 0) * 60 + (Number.isFinite(minute) ? minute : 0);
}

function ruleTimeMatches(rule: any, clock: ReturnType<typeof brtClock>) {
  const days = Array.isArray(rule.days_of_week) ? rule.days_of_week.map((day: any) => String(day).toUpperCase()) : [];
  if (days.length > 0 && !days.includes(DAY_NAMES[clock.dayOfWeek])) return false;
  const current = clock.hour * 60 + clock.minute;
  const start = toMinutes(rule.start_time);
  const end = toMinutes(rule.end_time);
  if (start === end) return true;
  return start < end ? current >= start && current < end : current >= start || current < end;
}

function ruleCampaigns(rule: any) {
  const associated = Array.isArray(rule.associated_campaign_ids) ? rule.associated_campaign_ids : [];
  return new Set(associated.map(String));
}

function ruleApplies(rule: any, campaignId: string, slotClassification: string, clock: ReturnType<typeof brtClock>, statuses: string[]) {
  if (!statuses.includes(String(rule.status || ''))) return false;
  if (rule.native_api_supported !== true || !rule.optimization_rule_id) return false;
  if (!ruleCampaigns(rule).has(campaignId)) return false;
  const ruleSlot = String(rule.slot_classification || '');
  if (ruleSlot && !['PICO', 'PISO', 'EFICIENTE'].includes(ruleSlot) && ruleSlot !== slotClassification) return false;
  return ruleTimeMatches(rule, clock);
}

function commandOk(response: any, key: string) {
  const data = response?.data || response || {};
  if (data?.ok === false) return false;
  if (Number(data?.status || 0) !== 207) return data?.ok === true;
  const payload = data?.payload || {};
  const success = payload?.[key]?.success || payload?.success || [];
  return Array.isArray(success) ? success.length > 0 : true;
}

async function setNativeRuleState(base44: any, accountId: string, rule: any, status: 'PAUSED' | 'ENABLED', reason: string, now: string) {
  const response = await base44.asServiceRole.functions.invoke('amazonAdsOptimizationRulesCommand', {
    amazon_account_id: accountId,
    operation: 'update_rules',
    payload: { optimizationRules: [{ optimizationRuleId: String(rule.optimization_rule_id), status }] },
    max_attempts: 3,
    trigger_type: 'automatic',
    _service_role: true,
  }).catch((error: any) => ({ data: { ok: false, error: error?.message || String(error) } }));
  const data = response?.data || response || {};
  const ok = data?.ok === true || data?.conflict_existing === true;
  if (ok) {
    const localStatus = status === 'PAUSED' ? 'paused' : 'enabled';
    await base44.asServiceRole.entities.AmazonScheduledRule.update(rule.id, {
      status: localStatus,
      reason,
      amazon_request_id: data?.request_id || rule.amazon_request_id || null,
      amazon_response_status: Number(data?.status || 0) || null,
      amazon_response: JSON.stringify(data?.payload || data || {}).slice(0, 4000),
      last_error: null,
      last_synced_at: now,
      updated_at: now,
    }).catch(() => {});
    rule.status = localStatus;
    rule.reason = reason;
  }
  return { ok, data };
}

function chooseMultiplier(params: {
  slot: ReturnType<typeof resolveSlot>;
  nativeCovered: boolean;
  nativeCompensationMultiplier: number | null;
  pacing: string;
  winner: boolean;
  sampleMature: boolean;
  orders: number;
  acos: number | null;
  targetAcos: number;
  economicRisk: boolean;
  hour: number;
  explorationEligible: boolean;
  deliveryRecoveryEligible: boolean;
  maxIncreasePct: number;
  maxDecreasePct: number;
}) {
  const { slot, nativeCovered, nativeCompensationMultiplier, pacing, winner, sampleMature, orders, acos, targetAcos, economicRisk, hour, explorationEligible, deliveryRecoveryEligible, maxIncreasePct, maxDecreasePct } = params;
  const maxUpMultiplier = Math.min(1.20, 1 + Math.max(0, Math.min(50, maxIncreasePct)) / 100);
  const minDownMultiplier = Math.max(0.50, 1 - Math.max(0, Math.min(50, maxDecreasePct)) / 100);
  const profitable = sampleMature && orders > 0 && acos !== null && acos <= targetAcos;
  const exceptional = sampleMature && orders >= 2 && acos !== null && acos <= targetAcos * 0.80;
  const canRecoverDelivery = deliveryRecoveryEligible && !economicRisk && !nativeCovered && !['overpacing', 'morning_reserve'].includes(pacing);
  const recoveryMultiplier = Math.min(winner ? 1.08 : 1.05, maxUpMultiplier);

  if (!slot.mature || slot.classification === 'COLLECTING_DATA') {
    if (canRecoverDelivery) return { multiplier: recoveryMultiplier, reason: `Subentrega econômica: micro-recuperação de exposição em +${r2((recoveryMultiplier - 1) * 100)}%, limitada por safe CPC e pacing.` };
    if (pacing === 'morning_reserve' && !winner) return { multiplier: 0.95, reason: 'Pacing matinal acima da trajetória: contenção mínima de 5%, preservando presença no leilão.' };
    if (isDemandProbeWindow(hour) && explorationEligible && !economicRisk && !nativeCovered) {
      const probe = winner ? 1.05 : 1.03;
      return { multiplier: Math.min(probe, maxUpMultiplier), reason: `Exploração econômica controlada de ${Math.round((Math.min(probe, maxUpMultiplier) - 1) * 100)}% em janela de demanda.` };
    }
    return { multiplier: 1, reason: 'Dados horários insuficientes; manter bid-base sem cortar exposição.' };
  }

  if (slot.classification === 'ELITE_TIME' || slot.classification === 'STRONG_TIME') {
    if (nativeCompensationMultiplier !== null) return { multiplier: Math.max(minDownMultiplier, Math.min(1, nativeCompensationMultiplier)), reason: 'Compensação local: regra Amazon não pôde ser pausada diante de guardrail.' };
    if (pacing === 'overpacing' || pacing === 'morning_reserve' || economicRisk) return { multiplier: 1, reason: 'Aumento bloqueado por pacing/proteção de lucro; baseline preservado.' };
    if (nativeCovered) return { multiplier: 1, reason: 'Regra Amazon aplicável cobre a janela; manter/restaurar bid-base local.' };
    if (!sampleMature || !profitable) {
      if (canRecoverDelivery) return { multiplier: recoveryMultiplier, reason: `${slot.classification} com subentrega e economia segura: recuperação moderada antes da maturidade.` };
      return { multiplier: 1, reason: `${slot.classification} ainda sem evidência econômica madura; manter baseline, sem redução.` };
    }

    const desired = slot.classification === 'ELITE_TIME'
      ? exceptional ? 1.20 : 1.12
      : exceptional ? 1.15 : 1.10;
    const multiplier = Math.min(desired, maxUpMultiplier);
    return { multiplier, reason: `${slot.classification} + economia madura: SCALE controlado em +${r2((multiplier - 1) * 100)}%.` };
  }

  if (slot.classification === 'NORMAL_TIME') {
    if (canRecoverDelivery) {
      const multiplier = Math.min(winner ? 1.06 : 1.04, maxUpMultiplier);
      return { multiplier, reason: `NORMAL com subentrega econômica: recuperação de +${r2((multiplier - 1) * 100)}% para preservar volume de vendas.` };
    }
    if (pacing === 'morning_reserve' && !winner) return { multiplier: 0.95, reason: 'NORMAL matinal acima da trajetória: contenção mínima de 5%.' };
    if (isDemandProbeWindow(hour) && explorationEligible && !economicRisk && !nativeCovered) {
      const probe = winner ? 1.05 : 1.03;
      return { multiplier: Math.min(probe, maxUpMultiplier), reason: `NORMAL com exploração econômica de ${Math.round((Math.min(probe, maxUpMultiplier) - 1) * 100)}%.` };
    }
    return { multiplier: 1, reason: 'NORMAL: manter/restaurar bid-base.' };
  }

  if (winner) return { multiplier: 1, reason: 'Entidade vencedora protegida contra redução horária.' };
  if (!sampleMature) return { multiplier: 1, reason: 'Redução bloqueada por amostra insuficiente; preservar capacidade de gerar impressões.' };

  if (slot.classification === 'WEAK_TIME') {
    const materiallyAboveTarget = acos !== null && acos > targetAcos * 1.20;
    const desired = economicRisk ? 0.90 : (orders === 0 || materiallyAboveTarget || pacing === 'overpacing' || pacing === 'morning_reserve') ? 0.95 : 1;
    return { multiplier: Math.max(desired, minDownMultiplier), reason: desired < 1 ? 'WEAK com evidência madura: contenção leve, preservando presença e potencial de venda.' : 'WEAK com economia protegida.' };
  }

  if (slot.classification === 'LOSS_TIME') {
    const severeLoss = economicRisk && orders === 0;
    const aboveTarget = acos !== null && acos > targetAcos;
    const desired = severeLoss ? 0.85 : aboveTarget || orders === 0 ? 0.90 : 1;
    return { multiplier: Math.max(desired, minDownMultiplier), reason: desired === 0.85 ? 'LOSS + risco econômico maduro: contenção forte, porém sem retirar competitividade excessivamente.' : desired === 0.90 ? 'LOSS maduro: redução moderada e reversível.' : 'LOSS estatístico, mas economia/conversão protegida.' };
  }

  return { multiplier: 1, reason: 'Sem ajuste aplicável.' };
}

async function logBid(base44: any, data: any) {
  await base44.asServiceRole.entities.AdsBidChangeLog.create({
    amazon_account_id: data.amazon_account_id,
    campaign_id: data.campaign_id,
    ad_group_id: data.ad_group_id || null,
    entity_type: data.entity_type,
    entity_id: data.entity_id,
    keyword_id: data.keyword_id || null,
    keyword_text: data.keyword_text || null,
    target_id: data.target_id || null,
    asin: data.asin || null,
    bid_before: data.bid_before,
    bid_after: data.bid_after,
    old_bid: data.bid_before,
    new_bid: data.bid_after,
    change_pct: data.bid_before > 0 ? r2(((data.bid_after - data.bid_before) / data.bid_before) * 100) : 0,
    direction: data.bid_after > data.bid_before ? 'increase' : data.bid_after < data.bid_before ? 'decrease' : 'restore',
    action: data.bid_after > data.bid_before ? 'bid_increase' : data.bid_after < data.bid_before ? 'bid_decrease' : 'bid_restore',
    reason: data.reason,
    classification: data.classification,
    source: 'runCanonicalDaypartingEngine',
    status: 'executed',
    created_at: data.now,
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
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, undefined, 1)
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-updated_at', 1);
    const account = accounts[0];
    if (!account) return Response.json({ ok: false, error: 'Nenhuma conta Amazon Ads conectada' }, { status: 404 });

    const aid = account.id;
    const clock = brtClock();
    const dryRun = body.dry_run === true;

    let nativePreflight: any = null;
    let queuePreflight: any = null;
    if (!dryRun && body.skip_native_preflight !== true) {
      nativePreflight = await runCanonicalNativeDaypartSync(base44, account, {
        trigger_type: body._service_role ? 'automatic' : 'manual',
        max_campaigns: Number(body.native_max_campaigns || 10),
      }).catch((error: any) => ({ ok: false, error: error?.message || String(error) }));
    }
    if (!dryRun && body.skip_queue_preflight !== true) {
      const response = await base44.asServiceRole.functions.invoke('reconcileLegacyDaypartingQueue', { amazon_account_id: aid, _service_role: true })
        .catch((error: any) => ({ data: { ok: false, error: error?.message || String(error) } }));
      queuePreflight = response?.data || response || {};
    }

    const [configs, performance, controllers, campaigns, products, economics, adGroups, keywords, productTargets, patterns, decisions, nativeRules, intradaySnapshots, todayMetrics] = await Promise.all([
      base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: aid }, undefined, 1).catch(() => []),
      base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id: aid }, undefined, 1).catch(() => []),
      base44.asServiceRole.entities.AccountDailySpendController.filter({ amazon_account_id: aid, spend_date: clock.date }, undefined, 1).catch(() => []),
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid }, undefined, 1000).catch(() => []),
      base44.asServiceRole.entities.Product.filter({ amazon_account_id: aid }, undefined, 1000).catch(() => []),
      base44.asServiceRole.entities.ProductEconomics.filter({ amazon_account_id: aid }, undefined, 1000).catch(() => []),
      base44.asServiceRole.entities.AdGroup.filter({ amazon_account_id: aid }, undefined, 3000).catch(() => []),
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: aid }, '-spend', 10000).catch(() => []),
      base44.asServiceRole.entities.ProductTarget.filter({ amazon_account_id: aid }, '-spend', 10000).catch(() => []),
      base44.asServiceRole.entities.HourlySalesPattern.filter({ amazon_account_id: aid }, undefined, 2000).catch(() => []),
      base44.asServiceRole.entities.DaypartingDecision.filter({ amazon_account_id: aid }, '-created_at', 5000).catch(() => []),
      base44.asServiceRole.entities.AmazonScheduledRule.filter({ amazon_account_id: aid }, '-updated_at', 3000).catch(() => []),
      base44.asServiceRole.entities.IntradaySpendSnapshot.filter({ amazon_account_id: aid, spend_date: clock.date }, '-observed_at', 10000).catch(() => []),
      base44.asServiceRole.entities.CampaignMetricsDaily.filter({ amazon_account_id: aid, date: clock.date }, '-updated_at', 10000).catch(() => []),
    ]);

    const cfg = configs[0] || {};
    const perf = performance[0] || {};
    const controller = controllers[0] || {};
    if (cfg.enabled === false || cfg.dayparting_enabled === false) return Response.json({ ok: true, skipped: true, reason: 'Autopilot/dayparting desabilitado' });
    if (controller.global_kill_switch === true) return Response.json({ ok: true, skipped: true, reason: 'Kill Switch global ativo' });

    const absoluteMinBid = Math.max(0.02, Number(body.daypart_absolute_min_bid ?? cfg.daypart_absolute_min_bid ?? 0.02));
    const absoluteMaxBid = Number(perf.max_bid || cfg.max_bid || 5);
    const targetAcos = Number(perf.target_acos || cfg.target_acos || 15);
    const minManualOrders = Number(cfg.min_orders_for_scale || 2);
    const configuredUp = Number(cfg.daypart_max_increase_pct ?? 50);
    const configuredDown = Number(cfg.daypart_max_decrease_pct ?? 50);
    const callerOverride = overridePct(body.bid_multiplier_override);
    const maxIncreasePct = Math.max(0, Math.min(50, callerOverride === null ? configuredUp : Math.min(configuredUp, callerOverride)));
    const maxDecreasePct = Math.max(0, Math.min(50, configuredDown));
    const eligibleAsins = Array.isArray(body.eligible_asins) && body.eligible_asins.length > 0
      ? new Set(body.eligible_asins.map((asin: any) => String(asin)))
      : null;

    const dailyCap = resolveDailyCap(perf, cfg, account, controller).cap;
    const todaySpend = readConfirmedTodaySpend({ snapshots: intradaySnapshots, dailyMetrics: todayMetrics, spendDate: clock.date });
    const confirmedSpend = todaySpend.confirmedSpend;
    if (!todaySpend.available) {
      return Response.json({ ok: true, skipped: true, reason: 'pacing_data_stale', data_source: todaySpend.source, freshness_seconds: todaySpend.freshnessSeconds, confidence: todaySpend.confidence, amazon_writes_blocked: true });
    }
    const plannedSpendByNow = dailyCap > 0 ? dailyCap * plannedBudgetShare(clock.hour) : 0;
    const morningReserve = clock.hour >= 7 && clock.hour < 12 && dailyCap > 0 && confirmedSpend > plannedSpendByNow * 1.10;
    const deliveryGap = clock.hour >= 7 && dailyCap > 0 && plannedSpendByNow > 0 && confirmedSpend < plannedSpendByNow * 0.75;
    const pacing = morningReserve
      ? 'morning_reserve'
      : String(controller.spend_pacing || (dailyCap > 0 && confirmedSpend > plannedSpendByNow * 1.10 ? 'overpacing' : 'on_track'));

    const productByAsin = new Map(products.map((product: any) => [String(product.asin || ''), product]));
    const economicsByAsin = new Map(economics.map((economic: any) => [String(economic.asin || ''), economic]));
    const slot = resolveSlot(decisions, patterns, controller, clock.dayOfWeek, clock.hour);
    const results: any[] = [];
    let executed = 0, restored = 0, skipped = 0, failed = 0, nativeRulesPaused = 0, nativeRulesReactivated = 0;

    for (const campaign of campaigns) {
      const cid = amazonCampaignId(campaign);
      const type = campaignType(campaign);
      const asin = String(campaign.asin || '');
      const product = productByAsin.get(asin);
      if (!cid || !active(campaign.state || campaign.status) || campaign.archived === true || stock(product) <= 0 || String(campaign.campaign_type || 'SP').toUpperCase() !== 'SP') continue;
      if (eligibleAsins && !eligibleAsins.has(asin)) {
        skipped++;
        results.push({ campaign_id: cid, asin, skipped: true, reason: 'outside_eligible_asins_scope' });
        continue;
      }

      const cm = campaignMetrics(campaign);
      const centralGoals = evaluateCentralGoals({
        targetAcos: perf.target_acos || cfg.target_acos,
        maximumAcos: perf.max_acos || cfg.maximum_acos,
        targetRoas: perf.target_roas || cfg.target_roas,
        targetTacos: perf.target_tacos || cfg.target_tacos,
        maximumCpc: perf.max_cpc || cfg.maximum_cpc,
        dailyBudget: dailyCap,
        acos: cm.acos,
        roas: cm.spend > 0 ? cm.sales / cm.spend : null,
        tacos: null,
        cpc: cm.clicks > 0 ? cm.spend / cm.clicks : null,
        spend: confirmedSpend,
        profitPositive: true,
        dataComplete: cm.spend > 0 || cm.impressions > 0,
      });

      const economic = economicsByAsin.get(asin) || {};
      const safeMaxCpc = Number(economic.safe_max_cpc || economic.maximum_safe_cpc || perf.max_cpc || 0);
      const breakEvenAcos = Number(economic.break_even_acos || campaign.break_even_acos || 0) || null;
      const winner = cm.orders > 0 && cm.acos !== null && cm.acos <= targetAcos;
      const economicRisk = String(economic.profit_protection_mode || '').toLowerCase() === 'paused' ||
        Number(economic.profit_after_ads_3d || 0) < 0 ||
        (breakEvenAcos !== null && cm.acos !== null && cm.acos >= breakEvenAcos * 0.95);
      const sampleMature = cm.impressions >= MIN_REDUCTION_IMPRESSIONS && cm.clicks >= MIN_REDUCTION_CLICKS && cm.spend >= MIN_REDUCTION_SPEND;
      const currentCpc = cm.clicks > 0 ? cm.spend / cm.clicks : 0;
      const cpcHasRoom = safeMaxCpc > 0 && (cm.clicks === 0 || currentCpc <= safeMaxCpc * 0.90);
      const deliveryRecoveryEligible = deliveryGap && !economicRisk && cpcHasRoom && centralGoals.permissions.topOfSearch &&
        cm.impressions < MIN_REDUCTION_IMPRESSIONS && cm.clicks < MIN_REDUCTION_CLICKS &&
        (cm.acos === null || cm.acos <= targetAcos * 1.10);
      const explorationEligible = safeMaxCpc > 0 && !economicRisk && (
        winner || deliveryRecoveryEligible || (cm.clicks >= 1 && (cm.acos === null || cm.acos <= targetAcos * 1.20))
      );
      const strategicManual = type === 'MANUAL' && cm.orders >= minManualOrders && cm.sales > 0 && cm.acos !== null && cm.acos <= targetAcos;
      const manualExplorationEligible = type === 'MANUAL' && explorationEligible && centralGoals.permissions.topOfSearch;
      if (type === 'MANUAL' && !strategicManual && !manualExplorationEligible) {
        skipped++;
        results.push({ campaign_id: cid, targeting_type: type, skipped: true, reason: 'manual_not_strategic_or_safe_exploration' });
        continue;
      }

      const groups = adGroups.filter((group: any) => String(group.campaign_id || '') === cid && active(group.state || group.status));
      const campaignBaseBids: number[] = [];
      for (const group of groups) {
        const gid = String(group.ad_group_id || '');
        const groupKeywords = keywords.filter((keyword: any) => String(keyword.ad_group_id || '') === gid && active(keyword.state || keyword.status));
        const groupTargets = productTargets.filter((target: any) => String(target.ad_group_id || '') === gid && active(target.state || target.status) && target.is_negative !== true);
        if (type === 'AUTO') campaignBaseBids.push(Number(group.daypart_base_bid || group.default_bid || 0));
        else {
          for (const keyword of groupKeywords) campaignBaseBids.push(Number(keyword.daypart_base_bid || keyword.current_bid || keyword.bid || 0));
          for (const target of groupTargets) campaignBaseBids.push(Number(target.daypart_base_bid || target.bid || 0));
        }
      }

      const enabledApplicable = nativeRules.filter((rule: any) => ruleApplies(rule, cid, slot.classification, clock, ['enabled']));
      const pausedGuardApplicable = nativeRules.filter((rule: any) => ruleApplies(rule, cid, slot.classification, clock, ['paused']) && String(rule.reason || '').startsWith('GUARDRAIL_TEMP_PAUSE:'));
      const maxEnabledAdjustment = enabledApplicable.reduce((max, rule) => Math.max(max, Number(rule.adjustment_value || 0)), 0);
      const maxProjectedBid = campaignBaseBids.reduce((max, base) => Math.max(max, base * (1 + maxEnabledAdjustment / 100)), 0);
      const nativeGuardReasons: string[] = [];
      if (pacing === 'overpacing') nativeGuardReasons.push('overpacing');
      if (economicRisk) nativeGuardReasons.push('profit_protection');
      if (!centralGoals.permissions.topOfSearch) nativeGuardReasons.push(`central_goals_${centralGoals.mode.toLowerCase()}`);
      if (maxEnabledAdjustment > maxIncreasePct + 0.001) nativeGuardReasons.push(`rule_${maxEnabledAdjustment}%_above_cap_${maxIncreasePct}%`);
      if (safeMaxCpc > 0 && maxProjectedBid > safeMaxCpc + 0.001) nativeGuardReasons.push('safe_max_cpc');

      let nativeCompensationMultiplier: number | null = null;
      if (!dryRun && enabledApplicable.length > 0 && nativeGuardReasons.length > 0) {
        const failedRulePcts: number[] = [];
        for (const rule of enabledApplicable) {
          const state = await setNativeRuleState(base44, aid, rule, 'PAUSED', `GUARDRAIL_TEMP_PAUSE:${nativeGuardReasons.join('|')}`, clock.iso);
          if (state.ok) nativeRulesPaused++;
          else failedRulePcts.push(Number(rule.adjustment_value || 0));
        }
        if (failedRulePcts.length > 0) {
          const rulePct = Math.max(...failedRulePcts);
          const allowedEffectivePct = nativeGuardReasons.includes('overpacing') || nativeGuardReasons.includes('profit_protection') ? 0 : maxIncreasePct;
          nativeCompensationMultiplier = (1 + allowedEffectivePct / 100) / (1 + rulePct / 100);
        }
      } else if (!dryRun && pausedGuardApplicable.length > 0 && nativeGuardReasons.length === 0) {
        for (const rule of pausedGuardApplicable) {
          const adjustment = Number(rule.adjustment_value || 0);
          const projected = campaignBaseBids.reduce((max, base) => Math.max(max, base * (1 + adjustment / 100)), 0);
          if (adjustment > maxIncreasePct + 0.001 || (safeMaxCpc > 0 && projected > safeMaxCpc + 0.001)) continue;
          const state = await setNativeRuleState(base44, aid, rule, 'ENABLED', `Guardrail liberado em ${clock.iso}; regra novamente ativa.`, clock.iso);
          if (state.ok) nativeRulesReactivated++;
        }
      }

      const nativeCovered = nativeRules.some((rule: any) => ruleApplies(rule, cid, slot.classification, clock, ['enabled']));

      for (const group of groups) {
        const gid = String(group.ad_group_id || '');
        if (!gid) continue;
        const groupKeywords = keywords.filter((keyword: any) => String(keyword.ad_group_id || '') === gid && active(keyword.state || keyword.status));
        const groupTargets = productTargets.filter((target: any) => String(target.ad_group_id || '') === gid && active(target.state || target.status) && target.is_negative !== true);
        const entities: any[] = [];

        if (type === 'AUTO') {
          entities.push({ entityType: 'ad_group', entityId: gid, row: group, currentBid: Number(group.default_bid || 0), keyword: null, target: null });
        } else {
          const exact = groupKeywords.filter((keyword: any) => norm(keyword.match_type || keyword.matchType) === 'exact');
          if (exact.length === 1 && groupKeywords.length === 1) {
            const keyword = exact[0];
            entities.push({ entityType: 'keyword', entityId: String(keyword.keyword_id || keyword.id || ''), row: keyword, currentBid: Number(keyword.current_bid || keyword.bid || group.default_bid || 0), keyword, target: null });
          } else if (groupTargets.length > 0 && groupKeywords.length === 0) {
            for (const target of groupTargets.slice(0, 25)) entities.push({ entityType: 'product_target', entityId: String(target.target_id || target.id || ''), row: target, currentBid: Number(target.bid || group.default_bid || 0), keyword: null, target });
          } else {
            skipped++;
            results.push({ campaign_id: cid, ad_group_id: gid, skipped: true, reason: `manual_group_noncanonical:${groupKeywords.length}_keywords:${exact.length}_exact:${groupTargets.length}_targets` });
            continue;
          }
        }

        for (const entity of entities) {
          if (!entity.entityId) { skipped++; continue; }
          const currentBid = Number(entity.currentBid || absoluteMinBid);
          const storedBase = Number(entity.row.daypart_base_bid || 0);
          const baseBid = r2(storedBase > 0 ? storedBase : currentBid);
          const floor = r2(Math.max(absoluteMinBid, baseBid * 0.50));
          const caps = [absoluteMaxBid, baseBid * 1.50];
          if (safeMaxCpc > 0) caps.push(safeMaxCpc);
          const cap = r2(Math.max(floor, Math.min(...caps)));
          const wasAdjusted = entity.row.daypart_active === true || (entity.entityType !== 'product_target' && group.daypart_active === true);

          const choice = chooseMultiplier({ slot, nativeCovered, nativeCompensationMultiplier, pacing, winner, sampleMature, orders: cm.orders, acos: cm.acos, targetAcos, economicRisk, hour: clock.hour, explorationEligible, deliveryRecoveryEligible, maxIncreasePct, maxDecreasePct });
          const targetBid = r2(Math.max(floor, Math.min(cap, baseBid * choice.multiplier)));
          const changed = Math.abs(targetBid - currentBid) >= 0.01;
          const restoring = changed && wasAdjusted && choice.multiplier === 1;
          const idem = `${aid}|canonical_daypart|${entity.entityType}|${entity.entityId}|${clock.date}|${clock.hour}|${targetBid}`;
          const reason = `${choice.reason} Base R$${baseBid.toFixed(2)}; faixa R$${floor.toFixed(2)}–R$${cap.toFixed(2)}; multiplicador ${choice.multiplier.toFixed(3)}x; fonte ${slot.source}.`;

          if (dryRun) {
            results.push({ campaign_id: cid, ad_group_id: gid, entity_type: entity.entityType, entity_id: entity.entityId, dry_run: true, changed, bid_before: currentBid, bid_after: targetBid, base_bid: baseBid, floor, cap, native_covered: nativeCovered, delivery_recovery_eligible: deliveryRecoveryEligible, reason });
            continue;
          }

          const existing = await base44.asServiceRole.entities.DaypartingDecision.filter({ amazon_account_id: aid, idempotency_key: idem }, '-updated_at', 1).catch(() => []);
          let audit = existing[0] || null;
          if (audit && ['executed', 'executing', 'approved'].includes(String(audit.status || ''))) { skipped++; continue; }

          const auditData: any = {
            amazon_account_id: aid,
            entity_type: entity.entityType,
            entity_id: entity.entityId,
            campaign_id: cid,
            ad_group_id: gid,
            keyword_id: entity.keyword?.keyword_id || null,
            target_id: entity.target?.target_id || null,
            targeting_type: type,
            asin,
            keyword_text: entity.keyword?.keyword_text || entity.target?.target_value || null,
            match_type: entity.keyword?.match_type || null,
            day_of_week: clock.dayOfWeek,
            hour: clock.hour,
            slot_label: `${clock.dayOfWeek}_${clock.hour}h`,
            time_slot_score: slot.score,
            slot_classification: slot.classification,
            decision_type: targetBid > currentBid ? 'BID_UP' : targetBid < currentBid ? 'BID_DOWN_ACOS' : restoring ? 'RESTORE_BASE' : 'MAINTAIN',
            rule_id: 'canonical_bid_envelope_050_150',
            rule_version: ENGINE_VERSION,
            current_bid: currentBid,
            base_bid: baseBid,
            bid_floor: floor,
            bid_cap: cap,
            proposed_bid: targetBid,
            bid_change_pct: currentBid > 0 ? r2(((targetBid - currentBid) / currentBid) * 100) : 0,
            bid_change_vs_baseline_pct: baseBid > 0 ? r2(((targetBid - baseBid) / baseBid) * 100) : 0,
            bid_multiplier: choice.multiplier,
            envelope_min_multiplier: 0.50,
            envelope_max_multiplier: 1.50,
            bid_floor_applied: targetBid === floor,
            bid_cap_applied: targetBid === cap,
            metric_window: 'persisted_campaign_metrics',
            decision_window: 'current_hour_brt',
            baseline_window: 'daypart_base_bid',
            requires_approval: false,
            status: changed ? 'executing' : 'executed',
            slot_orders: cm.orders,
            slot_clicks: cm.clicks,
            slot_spend: cm.spend,
            slot_sales: cm.sales,
            slot_impressions: cm.impressions,
            slot_acos: cm.acos,
            target_acos: targetAcos,
            sustainable_cpc: safeMaxCpc || null,
            data_confidence: sampleMature ? 'HIGH' : slot.mature ? 'MEDIUM' : 'LOW',
            data_mature: slot.mature && (choice.multiplier >= 1 || sampleMature),
            reason,
            idempotency_key: idem,
            cycle_date: clock.date,
            updated_at: clock.iso,
          };

          if (audit?.id) await base44.asServiceRole.entities.DaypartingDecision.update(audit.id, auditData).catch(() => {});
          else audit = await base44.asServiceRole.entities.DaypartingDecision.create({ ...auditData, created_at: clock.iso }).catch(() => null);

          if (!changed) {
            if (audit?.id) await base44.asServiceRole.entities.DaypartingDecision.update(audit.id, { status: 'executed', executed_at: clock.iso }).catch(() => {});
            skipped++;
            results.push({ campaign_id: cid, entity_type: entity.entityType, entity_id: entity.entityId, changed: false, base_bid: baseBid, current_bid: currentBid, reason: choice.reason });
            continue;
          }

          let ok = false;
          let responseData: any = null;
          let requestId = '';
          try {
            if (entity.entityType === 'keyword') {
              const decision = await base44.asServiceRole.entities.OptimizationDecision.create({
                amazon_account_id: aid,
                decision_type: 'bid_adjustment',
                entity_type: 'keyword',
                entity_id: entity.entityId,
                campaign_id: cid,
                ad_group_id: gid,
                keyword_id: entity.entityId,
                keyword_text: entity.keyword?.keyword_text || null,
                asin,
                action: 'set_bid',
                current_value: currentBid,
                proposed_value: targetBid,
                value_before: currentBid,
                value_after: targetBid,
                rationale: reason,
                risk: targetBid > currentBid ? 'medium' : 'low',
                requires_approval: false,
                approval_status: 'auto_approved',
                status: 'approved',
                queue_status: 'scheduled',
                idempotency_key: idem,
                source_function: 'runCanonicalDaypartingEngine',
                created_at: clock.iso,
                updated_at: clock.iso,
              });
              const response = await base44.asServiceRole.functions.invoke('executePairedManualBidDecision', { decision_id: decision.id, decision_ids: [decision.id], _service_role: true });
              responseData = response?.data || response || {};
              const item = responseData?.results?.[0] || responseData;
              ok = item?.ok === true || item?.status === 'executed';
              requestId = String(item?.request_id || '');
            } else if (entity.entityType === 'product_target') {
              const response = await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
                amazon_account_id: aid,
                operation: 'canonical_daypart_product_target_bid',
                method: 'PUT',
                path: '/sp/targets',
                content_type: 'application/vnd.spTargetingClause.v3+json',
                accept: 'application/vnd.spTargetingClause.v3+json',
                payload: { targetingClauses: [{ targetId: entity.entityId, bid: targetBid }] },
                max_attempts: 3,
                _service_role: true,
              });
              responseData = response?.data || response || {};
              ok = commandOk(response, 'targetingClauses') || commandOk(response, 'targets');
              requestId = String(responseData?.request_id || '');
            } else {
              const response = await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
                amazon_account_id: aid,
                operation: 'canonical_daypart_auto_adgroup_bid',
                method: 'PUT',
                path: '/sp/adGroups',
                content_type: 'application/vnd.spAdGroup.v3+json',
                accept: 'application/vnd.spAdGroup.v3+json',
                payload: { adGroups: [{ adGroupId: gid, defaultBid: targetBid }] },
                max_attempts: 3,
                _service_role: true,
              });
              responseData = response?.data || response || {};
              ok = commandOk(response, 'adGroups');
              requestId = String(responseData?.request_id || '');
            }

            if (ok) {
              const state = {
                daypart_base_bid: baseBid,
                daypart_bid_floor: floor,
                daypart_bid_cap: cap,
                daypart_active: choice.multiplier !== 1,
                daypart_multiplier: choice.multiplier,
                daypart_last_slot: slot.classification,
                daypart_last_adjusted_at: clock.iso,
                daypart_last_restored_at: restoring ? clock.iso : null,
              };
              if (entity.entityType === 'keyword') {
                await base44.asServiceRole.entities.Keyword.update(entity.row.id, { ...state, current_bid: targetBid, bid: targetBid }).catch(() => {});
                await base44.asServiceRole.entities.AdGroup.update(group.id, { ...state, default_bid: targetBid }).catch(() => {});
              } else if (entity.entityType === 'product_target') {
                await base44.asServiceRole.entities.ProductTarget.update(entity.row.id, { ...state, bid: targetBid, synced_at: clock.iso }).catch(() => {});
              } else {
                await base44.asServiceRole.entities.AdGroup.update(group.id, { ...state, default_bid: targetBid }).catch(() => {});
              }

              await logBid(base44, { amazon_account_id: aid, campaign_id: cid, ad_group_id: gid, entity_type: entity.entityType, entity_id: entity.entityId, keyword_id: entity.keyword?.keyword_id || null, keyword_text: entity.keyword?.keyword_text || entity.target?.target_value || null, target_id: entity.target?.target_id || null, asin, bid_before: currentBid, bid_after: targetBid, base_bid: baseBid, reason, classification: slot.classification, now: clock.iso });
              executed++;
              if (restoring) restored++;
            } else failed++;

            if (audit?.id) await base44.asServiceRole.entities.DaypartingDecision.update(audit.id, {
              status: ok ? 'executed' : 'failed',
              executed_at: ok ? clock.iso : null,
              amazon_request_id: requestId || null,
              amazon_response_status: Number(responseData?.status || (ok ? 200 : 0)),
              amazon_response: JSON.stringify(responseData || {}).slice(0, 4000),
              updated_at: clock.iso,
            }).catch(() => {});
          } catch (error: any) {
            failed++;
            if (audit?.id) await base44.asServiceRole.entities.DaypartingDecision.update(audit.id, { status: 'failed', reason: `${reason} ERRO: ${error?.message || String(error)}`.slice(0, 1000), updated_at: clock.iso }).catch(() => {});
          }

          results.push({ campaign_id: cid, ad_group_id: gid, entity_type: entity.entityType, entity_id: entity.entityId, targeting_type: type, strategic_manual: strategicManual, manual_exploration_eligible: manualExplorationEligible, native_covered: nativeCovered, native_compensation_multiplier: nativeCompensationMultiplier, delivery_recovery_eligible: deliveryRecoveryEligible, slot: slot.classification, base_bid: baseBid, floor, cap, bid_before: currentBid, bid_after: targetBid, multiplier: choice.multiplier, ok, reason: choice.reason });
          await wait(500);
        }
      }
    }

    if (!dryRun) {
      await base44.asServiceRole.entities.SyncExecutionLog.create({
        amazon_account_id: aid,
        operation: 'canonical_dayparting_cycle',
        trigger_type: body._service_role ? 'automatic' : 'manual',
        status: failed > 0 && executed === 0 ? 'error' : failed > 0 ? 'partial' : 'success',
        execution_date: clock.date,
        started_at: new Date(startedAt).toISOString(),
        completed_at: new Date().toISOString(),
        duration_ms: Date.now() - startedAt,
        records_processed: executed,
        result_summary: JSON.stringify({ hour_brt: clock.hour, slot: slot.classification, delivery_gap: deliveryGap, executed, restored, skipped, failed, native_rules_paused: nativeRulesPaused, native_rules_reactivated: nativeRulesReactivated }).slice(0, 1500),
        error_message: failed > 0 ? `${failed} ajuste(s) sem confirmação da Amazon.` : null,
      }).catch(() => {});
    }

    return Response.json({
      ok: failed === 0 || executed > 0 || dryRun,
      dry_run: dryRun,
      engine_version: ENGINE_VERSION,
      hour_brt: clock.hour,
      day_of_week: clock.dayOfWeek,
      slot,
      bid_envelope: {
        minimum_multiplier: 0.50,
        maximum_multiplier: 1.50,
        max_increase_pct_this_cycle: maxIncreasePct,
        max_decrease_pct_this_cycle: maxDecreasePct,
        absolute_min_bid: absoluteMinBid,
        example_base_0_30: { floor: 0.15, intermediate_down: 0.27, base: 0.30, recovery_up: 0.315, cap: 0.45 },
      },
      eligible_asins_scope: eligibleAsins ? [...eligibleAsins] : null,
      native_preflight: nativePreflight,
      queue_preflight: queuePreflight,
      native_rules_paused: nativeRulesPaused,
      native_rules_reactivated: nativeRulesReactivated,
      pacing,
      delivery_gap: deliveryGap,
      confirmed_spend_today: r2(confirmedSpend),
      daily_cap: dailyCap,
      planned_spend_by_now: r2(plannedSpendByNow),
      planned_budget_share: plannedBudgetShare(clock.hour),
      executed,
      restored,
      skipped,
      failed,
      results: results.slice(0, 300),
      duration_ms: Date.now() - startedAt,
    });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || 'Falha no motor canônico de dayparting' }, { status: 500 });
  }
});