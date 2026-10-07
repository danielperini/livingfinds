// Closed seven-day windows only. Advertising impressions are not store page views.
export function paidTrafficTrend(rows: any[], today: string) {
  const end = Date.parse(`${today}T00:00:00Z`);
  const daily = new Map<string, number>();
  const seen = new Map<string, any>();
  for (const row of rows) {
    const date = String(row.date || '').slice(0, 10);
    const time = Date.parse(`${date}T00:00:00Z`);
    if (!Number.isFinite(time) || time >= end || time < end - 35 * 86400000) continue;
    if (row.impressions == null || row.impressions === '' || !Number.isFinite(Number(row.impressions)) || Number(row.impressions) < 0) continue;
    const id = row.campaign_id || row.amazon_campaign_id;
    if (!id) continue;
    const key = `${id}|${date}`;
    const previous = seen.get(key);
    if (!previous || String(row.updated_at || row.updated_date || '') > String(previous.updated_at || previous.updated_date || '')) seen.set(key, row);
  }
  for (const row of seen.values()) {
    const date = String(row.date).slice(0, 10);
    daily.set(date, (daily.get(date) || 0) + Number(row.impressions));
  }
  const weeks = Array.from({ length: 5 }, (_, index) => {
    const dates = Array.from({ length: 7 }, (_, day) => new Date(end - (index * 7 + day + 1) * 86400000).toISOString().slice(0, 10));
    return { start: dates[6], end: dates[0], observed_days: dates.filter(date => daily.has(date)).length,
      impressions: dates.reduce((sum, date) => sum + (daily.get(date) || 0), 0) };
  });
  const baseline = weeks.slice(1).filter(week => week.observed_days === 7).map(week => week.impressions).sort((a, b) => a - b);
  const middle = Math.floor(baseline.length / 2);
  const median = baseline.length ? (baseline.length % 2 ? baseline[middle] : (baseline[middle - 1] + baseline[middle]) / 2) : null;
  const complete = weeks[0].observed_days === 7 && baseline.length >= 3 && median !== null && median > 0;
  const change = complete ? (weeks[0].impressions / median! - 1) * 100 : null;
  return { metric: 'advertising_impressions', store_page_views_status: 'not_imported',
    status: !complete ? 'insufficient_data' : change! <= -30 ? 'declining' : 'stable_or_growing',
    change_pct: change, baseline_median: median, weeks,
    anomalous_weeks: median && median > 0 ? weeks.filter(week => week.observed_days === 7 && week.impressions > median * 2.5) : [],
    automatic_spend_increase_allowed: false,
    next_check: !complete ? 'refresh_complete_daily_reports' : change! <= -30 ? 'check_fba_offer_and_profitable_campaign_delivery' : 'monitor',
  };
}
