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
 * - fim de semana/feriado usa uplift adaptativo somente com evidência econômica;
 * - toda janela temporária restaura o bid-base, evitando bid drift;
 * - dry-run não persiste nada.
 */
const ENGINE_VERSION = 'canonical-dayparting-v4-weekend-holiday-ai';
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

function resolveSlot(decisions: any[], patterns: any[], controller: any, dayOfWeek: number, hour: number) {
  const learnedDecision = decisions
    .filter((row) => Number(row.day_of_week) === dayOfWeek && Number(row.hour) === hour && !isCanonicalAudit(row))
    .sort((a, b) => timestamp(b) - timestamp(a))[0] || null;
  const pattern = patterns
    .filter((row) => Number(row.day_of_week) === dayOfWeek && Number(row.hour) === hour)
    .sort((a, b) => timestamp(b) - timestamp(a))[0] || null;
  if (learnedDecision && (!pattern || timestamp(learnedDecision) >= timestamp(pattern))) {
    return { classification: classify(learnedDecision.slot_classification), score: Number(learnedDecision.time_slot_score || 0), mature: learnedDecision.data_mature === true || ['HIGH', 'VERY_HIGH'].includes(String(learnedDecision.data_confidence || '')), source: 'DaypartingDecision_learned', source_updated_at: learnedDecision.updated_at || learnedDecision.created_at || null };
  }
  if (pattern) return { classification: classify(pattern.classification), score: Number(pattern.peak_score || 0), mature: Number(pattern.occurrences || 0) >= 3 && String(pattern.classification || '') !== 'INSUFFICIENT_DATA', source: 'HourlySalesPattern', source_updated_at: pattern.updated_at || pattern.created_at || null };
  const scores = parseObject(controller?.hour_value_scores);
  const score = Number(scores?.[hour] || 0);
  return { classification: score >= 90 ? 'ELITE_TIME' : score >= 75 ? 'STRONG_TIME' : score >= 55 ? 'NORMAL_TIME' : score >= 35 ? 'WEAK_TIME' : score > 0 ? 'LOSS_TIME' : 'COLLECTING_DATA', score, mature: score > 0, source: score > 0 ? 'AccountDailySpendController' : 'no_hourly_data', source_updated_at: controller?.updated_at || null };
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
  const response = await base44.asServiceRole.functions.invoke('amazonAdsOptimizationRulesCommand', { amazon_account_id: accountId, operation: 'update_rules', payload: { optimizationRules: [{ optimizationRuleId: String(rule.optimization_rule_id), status }] }, max_attempts: 3, trigger_type: 'automatic', _service_role: true }).catch((error: any) => ({ data: { ok: false, error: error?.message || String(error) } }));
  const data = response?.data || response || {};
  const ok = data?.ok === true || data?.conflict_existing === true;
  if (ok) {
    const localStatus = status === 'PAUSED' ? 'paused' : 'enabled';
    await base44.asServiceRole.entities.AmazonScheduledRule.update(rule.id, { status: localStatus, reason, amazon_request_id: data?.request_id || rule.amazon_request_id || null, amazon_response_status: Number(data?.status || 0) || null, amazon_response: JSON.stringify(data?.payload || data || {}).slice(0, 4000), last_error: null, last_synced_at: now, updated_at: now }).catch(() => {});
    rule.status = localStatus;
    rule.reason = reason;
  }
  return { ok, data };
}

function isWeekendOrHoliday(clock: ReturnType<typeof brtClock>, holidayDates: Set<string>) {
  return clock.dayOfWeek === 0 || clock.dayOfWeek === 6 || holidayDates.has(clock.date);
}

function weekendHolidayUplift(params: { activePeriod: boolean; slot: ReturnType<typeof resolveSlot>; winner: boolean; explorationEligible: boolean; economicRisk: boolean; pacing: string; acos: number | null; targetAcos: number; maxIncreasePct: number; nativeCovered: boolean; }) {
  const { activePeriod, slot, winner, explorationEligible, economicRisk, pacing, acos, targetAcos, maxIncreasePct, nativeCovered } = params;
  if (!activePeriod || economicRisk || pacing === 'overpacing' || pacing === 'morning_reserve' || nativeCovered) return { multiplier: 1, applied: false, reason: null };
  if (!winner && !explorationEligible) return { multiplier: 1, applied: false, reason: null };
  if (acos !== null && acos > targetAcos) return { multiplier: 1, applied: false, reason: 'Fim de semana/feriado sem uplift: ACoS acima da meta.' };
  let pct = 10;
  if (winner && (slot.classification === 'STRONG_TIME' || slot.classification === 'ELITE_TIME')) pct = 15;
  if (winner && slot.classification === 'ELITE_TIME' && acos !== null && acos <= targetAcos * 0.8) pct = 20;
  pct = Math.min(pct, Math.max(0, Math.min(20, maxIncreasePct)));
  if (pct <= 0) return { multiplier: 1, applied: false, reason: null };
  return { multiplier: 1 + pct / 100, applied: true, reason: `Fim de semana/feriado: uplift adaptativo de ${pct}% com evidência econômica e reversão automática ao baseline.` };
}

function chooseMultiplier(params: { slot: ReturnType<typeof resolveSlot>; nativeCovered: boolean; nativeCompensationMultiplier: number | null; pacing: string; winner: boolean; sampleMature: boolean; orders: number; acos: number | null; targetAcos: number; economicRisk: boolean; hour: number; explorationEligible: boolean; maxIncreasePct: number; maxDecreasePct: number; weekendHolidayActive: boolean; }) {
  const { slot, nativeCovered, nativeCompensationMultiplier, pacing, winner, sampleMature, orders, acos, targetAcos, economicRisk, hour, explorationEligible, maxIncreasePct, maxDecreasePct, weekendHolidayActive } = params;
  const seasonal = weekendHolidayUplift({ activePeriod: weekendHolidayActive, slot, winner, explorationEligible, economicRisk, pacing, acos, targetAcos, maxIncreasePct, nativeCovered });
  if (seasonal.applied) return { multiplier: seasonal.multiplier, reason: seasonal.reason };
  if (!slot.mature || slot.classification === 'COLLECTING_DATA') {
    if (pacing === 'morning_reserve' && !winner) return { multiplier: 0.85, reason: 'Pacing matinal: reserva de orçamento para faixas posteriores até haver evidência horária.' };
    if (isDemandProbeWindow(hour) && explorationEligible && !economicRisk && !nativeCovered) {
      const probe = winner ? 1.08 : 1.03;
      return { multiplier: probe, reason: `Janela de demanda ${hour < 10 ? 'início da manhã' : 'pré-almoço'}: teste controlado de ${Math.round((probe - 1) * 100)}% com CPC econômico.` };
    }
    return { multiplier: 1, reason: seasonal.reason || 'Dados horários insuficientes; manter bid-base.' };
  }
  const maxUpMultiplier = 1 + Math.max(0, Math.min(50, maxIncreasePct)) / 100;
  const minDownMultiplier = Math.max(0.50, 1 - Math.max(0, Math.min(50, maxDecreasePct)) / 100);
  const profitable = orders > 0 && acos !== null && acos <= targetAcos;
  const exceptional = orders >= 2 && acos !== null && acos <= targetAcos * 0.80;
  if (slot.classification === 'ELITE_TIME' || slot.classification === 'STRONG_TIME') {
    if (nativeCompensationMultiplier !== null) return { multiplier: Math.max(minDownMultiplier, Math.min(1, nativeCompensationMultiplier)), reason: 'Compensação local: regra Amazon não pôde ser pausada diante de um guardrail.' };
    if (pacing === 'overpacing' || pacing === 'morning_reserve' || economicRisk) return { multiplier: 1, reason: 'Aumento bloqueado por pacing ou proteção de lucro.' };
    if (nativeCovered) return { multiplier: 1, reason: 'Regra Amazon aplicável cobre esta campanha e esta janela; manter/restaurar bid-base local.' };
    const desired = slot.classification === 'ELITE_TIME' ? exceptional ? 1.50 : profitable ? 1.25 : 1 : exceptional ? 1.25 : profitable ? 1.15 : 1;
    return { multiplier: Math.min(desired, maxUpMultiplier), reason: desired > 1 ? `${slot.classification} rentável; aumento local limitado a ${r2((Math.min(desired, maxUpMultiplier) - 1) * 100)}%.` : `${slot.classification} sem evidência econômica suficiente.` };
  }
  if (slot.classification === 'NORMAL_TIME') {
    if (pacing === 'morning_reserve' && !winner) return { multiplier: 0.85, reason: 'NORMAL matinal: reduzir 15% para preservar verba do período de maior conversão.' };
    if (isDemandProbeWindow(hour) && explorationEligible && !economicRisk && !nativeCovered) { const probe = winner ? 1.06 : 1.02; return { multiplier: probe, reason: `NORMAL com entrega saudável no ${hour < 10 ? 'início da manhã' : 'pré-almoço'}: exploração econômica de ${Math.round((probe - 1) * 100)}%.` }; }
    return { multiplier: 1, reason: seasonal.reason || 'NORMAL: manter/restaurar bid-base.' };
  }
  if (winner) return { multiplier: 1, reason: 'Entidade vencedora protegida contra redução horária.' };
  if (!sampleMature) return { multiplier: 1, reason: 'Redução bloqueada por amostra insuficiente.' };
  if (slot.classification === 'WEAK_TIME') { const desired = orders === 0 || (acos !== null && acos > targetAcos * 1.20) || pacing === 'overpacing' || pacing === 'morning_reserve' ? 0.75 : 1; return { multiplier: Math.max(desired, minDownMultiplier), reason: desired < 1 ? 'WEAK com desperdício/overpacing: redução intermediária.' : 'WEAK com conversão protegida.' }; }
  if (slot.classification === 'LOSS_TIME') { const desired = orders === 0 && (acos === null || acos > targetAcos * 1.20) ? 0.50 : acos !== null && acos > targetAcos ? 0.75 : 1; return { multiplier: Math.max(desired, minDownMultiplier), reason: desired === 0.50 ? 'LOSS sem conversão rentável: redução máxima permitida.' : desired === 0.75 ? 'LOSS acima da meta: redução intermediária.' : 'LOSS, mas com conversão/ACoS protegido.' }; }
  return { multiplier: 1, reason: 'Sem ajuste aplicável.' };
}

async function logBid(base44: any, data: any) {
  await base44.asServiceRole.entities.AdsBidChangeLog.create({ amazon_account_id: data.amazon_account_id, campaign_id: data.campaign_id, ad_group_id: data.ad_group_id || null, entity_type: data.entity_type, entity_id: data.entity_id, keyword_id: data.keyword_id || null, keyword_text: data.keyword_text || null, target_id: data.target_id || null, asin: data.asin || null, bid_before: data.bid_before, bid_after: data.bid_after, old_bid: data.bid_before, new_bid: data.bid_after, change_pct: data.base_bid > 0 ? r2(((data.bid_after - data.base_bid) / data.base_bid) * 100) : 0, direction: data.bid_after > data.bid_before ? 'increase' : data.bid_after < data.bid_before ? 'decrease' : 'restore', action: data.bid_after > data.bid_before ? 'bid_increase' : data.bid_after < data.bid_before ? 'bid_decrease' : 'bid_restore', reason: data.reason, classification: data.classification, source: 'runCanonicalDaypartingEngine', status: 'executed', created_at: data.now }).catch(() => {});
}

Deno.serve(async (request) => {
  const startedAt = Date.now();
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    if (!body._service_role) { const user = await base44.auth.me().catch(() => null); if (!user) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 }); }
    const accounts = body.amazon_account_id ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1) : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-updated_at', 1);
    const account = accounts[0];
    if (!account) return Response.json({ ok: false, error: 'Nenhuma conta Amazon Ads conectada' }, { status: 404 });
    const aid = account.id;
    const clock = brtClock();
    const dryRun = body.dry_run === true;
    let nativePreflight: any = null;
    let queuePreflight: any = null;
    if (!dryRun && body.skip_native_preflight !== true) nativePreflight = await runCanonicalNativeDaypartSync(base44, account, { trigger_type: body._service_role ? 'automatic' : 'manual', max_campaigns: Number(body.native_max_campaigns || 10) }).catch((error: any) => ({ ok: false, error: error?.message || String(error) }));
    if (!dryRun && body.skip_queue_preflight !== true) { const response = await base44.asServiceRole.functions.invoke('reconcileLegacyDaypartingQueue', { amazon_account_id: aid, _service_role: true }).catch((error: any) => ({ data: { ok: false, error: error?.message || String(error) } })); queuePreflight = response?.data || response || {}; }
    const [configs, performance, controllers, campaigns, products, economics, adGroups, keywords, productTargets, patterns, decisions, nativeRules, intradaySnapshots, todayMetrics, scheduledRules] = await Promise.all([
      base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: aid }, null, 1).catch(() => []), base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id: aid }, null, 1).catch(() => []), base44.asServiceRole.entities.AccountDailySpendController.filter({ amazon_account_id: aid, spend_date: clock.date }, null, 1).catch(() => []), base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid }, null, 1000).catch(() => []), base44.asServiceRole.entities.Product.filter({ amazon_account_id: aid }, null, 1000).catch(() => []), base44.asServiceRole.entities.ProductEconomics.filter({ amazon_account_id: aid }, null, 1000).catch(() => []), base44.asServiceRole.entities.AdGroup.filter({ amazon_account_id: aid }, null, 3000).catch(() => []), base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: aid }, '-spend', 10000).catch(() => []), base44.asServiceRole.entities.ProductTarget.filter({ amazon_account_id: aid }, '-spend', 10000).catch(() => []), base44.asServiceRole.entities.HourlySalesPattern.filter({ amazon_account_id: aid }, null, 2000).catch(() => []), base44.asServiceRole.entities.DaypartingDecision.filter({ amazon_account_id: aid }, '-created_at', 5000).catch(() => []), base44.asServiceRole.entities.AmazonScheduledRule.filter({ amazon_account_id: aid }, '-updated_at', 3000).catch(() => []), base44.asServiceRole.entities.IntradaySpendSnapshot.filter({ amazon_account_id: aid, spend_date: clock.date }, '-observed_at', 10000).catch(() => []), base44.asServiceRole.entities.CampaignMetricsDaily.filter({ amazon_account_id: aid, date: clock.date }, '-updated_at', 10000).catch(() => []), base44.asServiceRole.entities.AmazonScheduledRule.filter({ amazon_account_id: aid }, '-updated_at', 3000).catch(() => []),
    ]);
    const cfg = configs[0] || {}; const perf = performance[0] || {}; const controller = controllers[0] || {};
    if (cfg.enabled === false || cfg.dayparting_enabled === false) return Response.json({ ok: true, skipped: true, reason: 'Autopilot/dayparting desabilitado' });
    if (controller.global_kill_switch === true) return Response.json({ ok: true, skipped: true, reason: 'Kill Switch global ativo' });
    const holidayDates = new Set<string>();
    for (const rule of scheduledRules) for (const date of Array.isArray(rule.holiday_dates) ? rule.holiday_dates : []) holidayDates.add(String(date));
    const weekendHolidayActive = isWeekendOrHoliday(clock, holidayDates);
    const absoluteMinBid = Math.max(0.02, Number(body.daypart_absolute_min_bid ?? cfg.daypart_absolute_min_bid ?? 0.02));
    const absoluteMaxBid = Number(perf.max_bid || cfg.max_bid || 5);
    const targetAcos = Number(perf.target_acos || cfg.target_acos || 15);
    const minManualOrders = Number(cfg.min_orders_for_scale || 2);
    const configuredUp = Number(cfg.daypart_max_increase_pct ?? 50); const configuredDown = Number(cfg.daypart_max_decrease_pct ?? 50); const callerOverride = overridePct(body.bid_multiplier_override); const maxIncreasePct = Math.max(0, Math.min(50, callerOverride === null ? configuredUp : Math.min(configuredUp, callerOverride))); const maxDecreasePct = Math.max(0, Math.min(50, configuredDown));
    const eligibleAsins = Array.isArray(body.eligible_asins) && body.eligible_asins.length > 0 ? new Set(body.eligible_asins.map((asin: any) => String(asin))) : null;
    const dailyCap = resolveDailyCap(perf, cfg, account, controller).cap;
    const todaySpend = readConfirmedTodaySpend({ snapshots: intradaySnapshots, dailyMetrics: todayMetrics, spendDate: clock.date }); const confirmedSpend = todaySpend.confirmedSpend;
    if (!todaySpend.available) return Response.json({ ok: true, skipped: true, reason: 'pacing_data_stale', data_source: todaySpend.source, freshness_seconds: todaySpend.freshnessSeconds, confidence: todaySpend.confidence, amazon_writes_blocked: true });
    const plannedSpendByNow = dailyCap > 0 ? dailyCap * plannedBudgetShare(clock.hour) : 0;
    const morningReserve = clock.hour >= 7 && clock.hour < 12 && dailyCap > 0 && confirmedSpend > plannedSpendByNow * 1.10;
    const pacing = morningReserve ? 'morning_reserve' : String(controller.spend_pacing || (dailyCap > 0 && confirmedSpend > plannedSpendByNow * 1.10 ? 'overpacing' : 'on_track'));
    const productByAsin = new Map(products.map((product: any) => [String(product.asin || ''), product])); const economicsByAsin = new Map(economics.map((economic: any) => [String(economic.asin || ''), economic])); const slot = resolveSlot(decisions, patterns, controller, clock.dayOfWeek, clock.hour);
    const results: any[] = []; let executed = 0, restored = 0, skipped = 0, failed = 0, nativeRulesPaused = 0, nativeRulesReactivated = 0;
    for (const campaign of campaigns) {
      const cid = amazonCampaignId(campaign); const type = campaignType(campaign); const asin = String(campaign.asin || ''); const product = productByAsin.get(asin);
      if (!cid || !active(campaign.state || campaign.status) || campaign.archived === true || stock(product) <= 0 || String(campaign.campaign_type || 'SP').toUpperCase() !== 'SP') continue;
      if (eligibleAsins && !eligibleAsins.has(asin)) { skipped++; results.push({ campaign_id: cid, asin, skipped: true, reason: 'outside_eligible_asins_scope' }); continue; }
      const cm = campaignMetrics(campaign);
      const strategicManual = type === 'MANUAL' && cm.orders >= minManualOrders && cm.sales > 0 && cm.acos !== null && cm.acos <= targetAcos;
      if (type === 'MANUAL' && !strategicManual) { skipped++; results.push({ campaign_id: cid, targeting_type: type, skipped: true, reason: 'manual_not_strategic' }); continue; }
      const economic = economicsByAsin.get(asin) || {}; const safeMaxCpc = Number(economic.safe_max_cpc || economic.maximum_safe_cpc || perf.max_cpc || 0); const breakEvenAcos = Number(economic.break_even_acos || campaign.break_even_acos || 0) || null; const winner = cm.orders > 0 && cm.acos !== null && cm.acos <= targetAcos; const economicRisk = String(economic.profit_protection_mode || '').toLowerCase() === 'paused' || Number(economic.profit_after_ads_3d || 0) < 0 || (breakEvenAcos !== null && cm.acos !== null && cm.acos >= breakEvenAcos * 0.95); const sampleMature = cm.impressions >= MIN_REDUCTION_IMPRESSIONS && cm.clicks >= MIN_REDUCTION_CLICKS && cm.spend >= MIN_REDUCTION_SPEND; const explorationEligible = safeMaxCpc > 0 && !economicRisk && (winner || (cm.clicks >= 2 && (cm.acos === null || cm.acos <= targetAcos * 1.1)));
      const applicableNative = nativeRules.filter((rule: any) => ruleApplies(rule, cid, slot.classification, clock, ['enabled'])); const nativeCovered = applicableNative.length > 0; const nativeCompensationMultiplier = null;
      const choice = chooseMultiplier({ slot, nativeCovered, nativeCompensationMultiplier, pacing, winner, sampleMature, orders: cm.orders, acos: cm.acos, targetAcos, economicRisk, hour: clock.hour, explorationEligible, maxIncreasePct, maxDecreasePct, weekendHolidayActive });
      const entities = type === 'MANUAL' ? keywords.filter((keyword: any) => String(keyword.campaign_id || '') === cid && active(keyword.state || keyword.status)) : productTargets.filter((target: any) => String(target.campaign_id || '') === cid && active(target.state || target.status));
      for (const entity of entities) {
        const baseBid = Number(entity.base_bid || entity.baseline_bid || entity.original_bid || entity.bid || 0); const currentBid = Number(entity.bid || baseBid || 0); if (!(baseBid > 0)) continue;
        const cappedBySafeCpc = safeMaxCpc > 0 ? Math.min(baseBid * choice.multiplier, safeMaxCpc) : baseBid * choice.multiplier; const desiredBid = r2(Math.max(absoluteMinBid, Math.min(absoluteMaxBid, cappedBySafeCpc))); if (Math.abs(desiredBid - currentBid) < 0.01) continue;
        if (dryRun) { results.push({ campaign_id: cid, entity_id: entity.id, bid_before: currentBid, bid_after: desiredBid, reason: choice.reason, dry_run: true }); continue; }
        const fn = type === 'MANUAL' ? 'amazonAdsUpdateKeywordBid' : 'amazonAdsUpdateTargetBid';
        const response = await base44.asServiceRole.functions.invoke(fn, { amazon_account_id: aid, campaign_id: cid, ad_group_id: entity.ad_group_id || entity.adGroupId, keyword_id: type === 'MANUAL' ? entity.keyword_id || entity.keywordId || entity.id : undefined, target_id: type === 'AUTO' ? entity.target_id || entity.targetId || entity.id : undefined, bid: desiredBid, _service_role: true, trigger_type: 'canonical_dayparting' }).catch((error: any) => ({ data: { ok: false, error: error?.message || String(error) } }));
        const ok = commandOk(response, type === 'MANUAL' ? 'keywords' : 'targets');
        if (!ok) { failed++; results.push({ campaign_id: cid, entity_id: entity.id, failed: true, reason: response?.data?.error || 'amazon_write_failed' }); continue; }
        await base44.asServiceRole.entities[type === 'MANUAL' ? 'Keyword' : 'ProductTarget'].update(entity.id, { bid: desiredBid, baseline_bid: baseBid, base_bid: baseBid, updated_at: clock.iso }).catch(() => {});
        await logBid(base44, { amazon_account_id: aid, campaign_id: cid, ad_group_id: entity.ad_group_id || entity.adGroupId, entity_type: type === 'MANUAL' ? 'keyword' : 'target', entity_id: entity.id, keyword_id: type === 'MANUAL' ? entity.keyword_id || entity.keywordId || entity.id : null, keyword_text: type === 'MANUAL' ? entity.keyword_text || entity.text || null : null, target_id: type === 'AUTO' ? entity.target_id || entity.targetId || entity.id : null, asin, bid_before: currentBid, bid_after: desiredBid, base_bid: baseBid, reason: choice.reason, classification: weekendHolidayActive ? `WEEKEND_HOLIDAY_${slot.classification}` : slot.classification, now: clock.iso });
        executed++; if (Math.abs(desiredBid - baseBid) < 0.01) restored++;
      }
    }
    await base44.asServiceRole.entities.SyncExecutionLog.create({ amazon_account_id: aid, operation: 'canonical_dayparting_engine', trigger_type: body.trigger_type || 'scheduler', status: failed ? 'warning' : 'success', started_at: new Date(startedAt).toISOString(), completed_at: new Date().toISOString(), duration_ms: Date.now() - startedAt, records_processed: results.length, result_summary: `executed=${executed}; restored=${restored}; skipped=${skipped}; failed=${failed}; weekend_holiday=${weekendHolidayActive}; engine=${ENGINE_VERSION}` }).catch(() => {});
    return Response.json({ ok: true, engine_version: ENGINE_VERSION, clock, slot, weekend_holiday_active: weekendHolidayActive, holiday_dates_loaded: holidayDates.size, pacing, executed, restored, skipped, failed, native_rules_paused: nativeRulesPaused, native_rules_reactivated: nativeRulesReactivated, native_preflight: nativePreflight, queue_preflight: queuePreflight, results });
  } catch (error: any) { return Response.json({ ok: false, error: error?.message || String(error) }, { status: 500 }); }
});
