export const DEFAULT_DAILY_CAP = 115;
export const MAX_METRICS_AGE_MINUTES = 390;

const FALLBACK_HOURLY_WEIGHTS = [
  1.5, 1.5, 1.5, 1.5, 1.5, 1.5,
  2.5, 2.5, 2.5,
  4, 4, 4,
  5, 5, 5, 5, 5,
  7, 7, 7, 7, 7,
  6.5, 5,
];

const TEMP_PAUSE_REASONS = [
  'PACING_OVERSPEND_TEMP_STOP',
  'PACING_HARD_CAP_STOP',
  'OVERPACING_TEMP_STOP',
  'DAYPART_RESERVE_STOP',
  'BUDGET_CAP_SCHEDULED_PAUSE',
  'CHECKPOINT_13H_SLOW_DOWN',
  'CHECKPOINT_19H_TEMP_STOP',
];

export const r2 = (value: number) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
export const norm = (value: any) => String(value || '').trim().toLowerCase();
export const isEnabled = (value: any) => ['enabled', 'active'].includes(norm(value));
export const positive = (...values: any[]) => {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return 0;
};

export function parseArray(value: any): any[] {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function brtClock(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value || '';
  const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const hour = Number(get('hour') || 0) % 24;
  const minute = Number(get('minute') || 0);
  return {
    iso: now.toISOString(),
    date: `${get('year')}-${get('month')}-${get('day')}`,
    dayOfWeek: dayMap[get('weekday')] ?? 0,
    hour,
    minute,
    minuteOfDay: hour * 60 + minute,
  };
}

export function productStock(product: any) {
  return Number(
    product?.fba_inventory ?? product?.available_quantity ??
    product?.fulfillable_quantity ?? product?.stock ?? 0,
  );
}

export function amazonCampaignId(campaign: any) {
  return String(campaign?.amazon_campaign_id || campaign?.campaign_id || '');
}

export function resolveDailyCap(performance: any, autopilot: any, account: any) {
  const lockedTarget = autopilot?.daily_budget_locked === true
    ? positive(autopilot?.daily_budget_target)
    : 0;
  const cap = positive(
    performance?.daily_budget_limit,
    lockedTarget,
    autopilot?.daily_budget_target,
    autopilot?.total_daily_budget,
    autopilot?.daily_budget_limit,
    account?.max_daily_budget_limit,
    DEFAULT_DAILY_CAP,
  );
  const source = positive(performance?.daily_budget_limit)
    ? 'PerformanceSettings.daily_budget_limit'
    : lockedTarget > 0
      ? 'AutopilotConfig.daily_budget_target_locked'
      : positive(autopilot?.daily_budget_target)
        ? 'AutopilotConfig.daily_budget_target'
        : positive(autopilot?.total_daily_budget)
          ? 'AutopilotConfig.total_daily_budget'
          : positive(autopilot?.daily_budget_limit)
            ? 'AutopilotConfig.daily_budget_limit'
            : positive(account?.max_daily_budget_limit)
              ? 'AmazonAccount.max_daily_budget_limit'
              : 'system_default_115';
  return { cap: r2(cap), source };
}

function normalizeWeights(values: number[]) {
  const safe = values.map((value) => Math.max(0.05, Number(value || 0)));
  const total = safe.reduce((sum, value) => sum + value, 0) || 1;
  return safe.map((value) => value / total);
}

export function buildPacingCurve(patterns: any[], dayOfWeek: number) {
  const fallback = normalizeWeights(FALLBACK_HOURLY_WEIGHTS);
  const byHour = new Map<number, number[]>();
  for (const row of patterns) {
    const hour = Number(row?.hour);
    const mature = Number(row?.occurrences || 0) >= 3 || row?.asin_data_maturity === 'sufficient';
    if (Number(row?.day_of_week) !== dayOfWeek || hour < 0 || hour > 23 || !mature) continue;
    const value = Number(row?.orders_share_pct || 0) || Math.max(1, Number(row?.peak_score || 0) / 4);
    byHour.set(hour, [...(byHour.get(hour) || []), value]);
  }

  let weights = fallback;
  let source = 'fallback_weighted_curve';
  if (byHour.size >= 8) {
    const raw = Array.from({ length: 24 }, (_, hour) => {
      const rows = byHour.get(hour) || [];
      return rows.length ? rows.reduce((sum, value) => sum + value, 0) / rows.length : fallback[hour] * 100;
    });
    const learned = normalizeWeights(raw);
    weights = normalizeWeights(learned.map((value, hour) => value * 0.70 + fallback[hour] * 0.30));
    source = 'hourly_sales_pattern_blended';
  }

  let cumulative = 0;
  const curve: Record<string, any> = {};
  weights.forEach((weight, hour) => {
    cumulative += weight;
    curve[String(hour)] = {
      hourly_share_pct: r2(weight * 100),
      cumulative_pct: r2(cumulative * 100),
    };
  });
  curve['23'].cumulative_pct = 100;
  return { weights, curve, source, matureHours: byHour.size };
}

export function expectedFraction(weights: number[], minuteOfDay: number) {
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  let fraction = 0;
  for (let index = 0; index < hour; index++) fraction += weights[index] || 0;
  return clamp(fraction + (weights[hour] || 0) * minute / 60, 0, 1);
}

function observedAt(row: any) {
  const value = new Date(row?.observed_at || row?.updated_at || row?.created_at || 0).getTime();
  return Number.isFinite(value) ? value : 0;
}

export function aggregateIntradaySnapshots(rows: any[], nowMs: number) {
  const groups = new Map<string, any[]>();
  for (const row of rows) {
    const key = String(row?.report_id || row?.snapshot_batch_id || row?.observed_at || '');
    if (key) groups.set(key, [...(groups.get(key) || []), row]);
  }

  const batches = [...groups.entries()].map(([key, batch]) => {
    const observed = Math.max(...batch.map(observedAt));
    const latestByCampaign = new Map<string, any>();
    for (const row of batch) {
      const campaignId = String(row?.campaign_id || '');
      const previous = latestByCampaign.get(campaignId);
      if (campaignId && (!previous || observedAt(row) >= observedAt(previous))) latestByCampaign.set(campaignId, row);
    }
    const campaignRows = [...latestByCampaign.values()];
    const totals = campaignRows.reduce((result, row) => ({
      spend: result.spend + Number(row?.spend || 0),
      sales: result.sales + Number(row?.sales || 0),
      orders: result.orders + Number(row?.orders || 0),
      clicks: result.clicks + Number(row?.clicks || 0),
      impressions: result.impressions + Number(row?.impressions || 0),
    }), { spend: 0, sales: 0, orders: 0, clicks: 0, impressions: 0 });
    return { key, observed, campaignRows, ...totals };
  }).sort((a, b) => b.observed - a.observed);

  const latest = batches[0];
  const previous = batches.find((batch) => latest && batch.observed < latest.observed - 60_000);
  if (!latest) return {
    available: false, status: 'unavailable', source: 'none', observedAt: null,
    ageMinutes: null, campaignRows: [], confirmedSpend: 0, estimatedPendingSpend: 0,
    estimatedCurrentSpend: 0, velocityPerHour: 0, batches: 0,
  };

  const ageMinutes = Math.max(0, (nowMs - latest.observed) / 60_000);
  const status = ageMinutes <= MAX_METRICS_AGE_MINUTES ? 'fresh' : 'stale';
  let velocityPerHour = 0;
  if (previous) {
    const hours = (latest.observed - previous.observed) / 3_600_000;
    if (hours >= 0.20) velocityPerHour = Math.max(0, (latest.spend - previous.spend) / hours);
  }
  if (!velocityPerHour) {
    const atSnapshot = brtClock(new Date(latest.observed));
    velocityPerHour = latest.spend / Math.max(1, atSnapshot.hour + atSnapshot.minute / 60);
  }
  const source = String(latest.campaignRows[0]?.source || 'AMAZON_ADS_SAME_DAY_REPORT');
  const assumedSourceLagHours = source === 'AMAZON_ADS_SAME_DAY_REPORT' ? 3 : 0;
  const pendingHours = Math.min(6, Math.max(assumedSourceLagHours, ageMinutes / 60));
  const pending = Math.max(0, velocityPerHour * pendingHours);
  return {
    available: status === 'fresh', status,
    source,
    observedAt: new Date(latest.observed).toISOString(), ageMinutes: r2(ageMinutes),
    campaignRows: latest.campaignRows, confirmedSpend: r2(latest.spend),
    estimatedPendingSpend: r2(pending), estimatedCurrentSpend: r2(latest.spend + pending),
    velocityPerHour: r2(velocityPerHour), batches: batches.length, assumedSourceLagHours,
  };
}

export function pacingClassification(ratio: number, spend: number, effectiveCap: number, projectedEod: number, cap: number) {
  if (spend >= effectiveCap || projectedEod >= cap * 1.08) return 'hard_cap_risk';
  if (ratio > 1.20 || projectedEod > cap * 1.03) return 'overpacing';
  if (ratio < 0.85 && projectedEod < cap * 0.92) return 'underpacing';
  return 'on_track';
}

function historical(campaign: any, targetAcos: number) {
  const spend = Number(campaign?.spend || 0);
  const sales = Number(campaign?.sales || 0);
  const orders = Number(campaign?.orders || 0);
  const clicks = Number(campaign?.clicks || 0);
  const acos = sales > 0 ? spend / sales * 100 : null;
  const roas = spend > 0 ? sales / spend : 0;
  const winner = orders > 0 && acos !== null && acos <= targetAcos;
  return { spend, sales, orders, clicks, acos, roas, winner, protected: winner || campaign?.protected_high_performance === true };
}

function temporaryPause(campaign: any) {
  const reason = String(campaign?.pacing_pause_reason || campaign?.archive_reason || '');
  return TEMP_PAUSE_REASONS.some((prefix) => reason === prefix || reason.startsWith(`${prefix}:`));
}

export function buildCampaignProfiles(campaigns: any[], products: any[], economics: any[], snapshots: any[], targetAcos: number) {
  const productsByAsin = new Map(products.map((row: any) => [String(row?.asin || ''), row]));
  const economicsByAsin = new Map(economics.map((row: any) => [String(row?.asin || ''), row]));
  const snapshotByCampaign = new Map(snapshots.map((row: any) => [String(row?.campaign_id || ''), row]));
  return campaigns.map((campaign: any) => {
    const campaignId = amazonCampaignId(campaign);
    const asin = String(campaign?.asin || '');
    const product: any = productsByAsin.get(asin);
    const economic: any = economicsByAsin.get(asin) || {};
    const today: any = snapshotByCampaign.get(campaignId) || {};
    const prior = historical(campaign, targetAcos);
    const todaySpend = Number(today?.spend || 0);
    const todaySales = Number(today?.sales || 0);
    const todayOrders = Number(today?.orders || 0);
    const todayClicks = Number(today?.clicks || 0);
    const todayAcos = todaySales > 0 ? todaySpend / todaySales * 100 : null;
    const winner = (todayOrders > 0 && todayAcos !== null && todayAcos <= targetAcos) || prior.winner;
    const economicRisk = String(economic?.profit_protection_mode || '').toLowerCase() === 'paused' ||
      Number(economic?.profit_after_ads_3d || 0) < 0;
    return {
      campaign, campaignId, asin, product, economic, prior, today,
      stock: productStock(product),
      active: isEnabled(campaign?.state || campaign?.status) && campaign?.archived !== true,
      paused: norm(campaign?.state || campaign?.status) === 'paused' && campaign?.archived !== true,
      todaySpend, todaySales, todayOrders, todayClicks, todayAcos,
      winner, protected: winner || prior.protected, economicRisk,
      wasteScore: r2(
        (todaySpend > 0 && todayOrders === 0 ? 50 : 0) + Math.min(35, todaySpend * 2) +
        (todayClicks >= 10 && todayOrders === 0 ? 15 : 0) + (economicRisk ? 20 : 0) - (winner ? 100 : 0),
      ),
      priorityScore: r2(
        (winner ? 100 : prior.orders > 0 ? 75 : 20) + Math.min(20, prior.orders * 3) +
        Math.min(15, prior.roas * 2) + (productStock(product) > 0 ? 10 : -100) - (economicRisk ? 35 : 0),
      ),
      temporaryPause: temporaryPause(campaign),
    };
  });
}
