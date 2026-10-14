/**
 * Daily campaign reports are revised by Amazon and can be re-imported. Keep
 * only the newest revision for each campaign/date before summing windows.
 */
const campaignIdOf = (row: any) => String(row?.campaign_id || row?.amazon_campaign_id || '');
const dateOf = (row: any) => String(row?.date || row?.spend_date || row?.metric_date || '').slice(0, 10);
const timestampOf = (row: any) => {
  const raw = row?.synced_at || row?.observed_at || row?.source_report_created_at || row?.report_generated_at ||
    row?.updated_at || row?.updated_date || row?.created_at || row?.created_date || row?.imported_at || '';
  const timestamp = new Date(String(raw)).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
};

export function brazilReportDate(date: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(date);
}

export function brazilReportDateDaysAgo(days: number, now: Date = new Date()): string {
  const safeDays = Math.max(0, Math.floor(Number(days) || 0));
  const localNoon = new Date(`${brazilReportDate(now)}T12:00:00-03:00`);
  localNoon.setDate(localNoon.getDate() - safeDays);
  return brazilReportDate(localNoon);
}

export function latestCampaignMetricsByDay(rows: any[], options: { startDate?: string; endDate?: string } = {}) {
  const latest = new Map<string, any>();
  for (const row of rows) {
    const campaignId = campaignIdOf(row);
    const date = dateOf(row);
    if (!campaignId || !date) continue;
    if (options.startDate && date < options.startDate) continue;
    if (options.endDate && date > options.endDate) continue;
    const key = `${campaignId}|${date}`;
    const current = latest.get(key);
    if (!current || timestampOf(row) > timestampOf(current)) latest.set(key, row);
  }
  return [...latest.values()];
}

export function aggregateLatestCampaignMetrics(rows: any[], options: { startDate?: string; endDate?: string } = {}) {
  const totals = new Map<string, { impressions: number; clicks: number; spend: number; sales: number; orders: number }>();
  for (const row of latestCampaignMetricsByDay(rows, options)) {
    const id = campaignIdOf(row);
    const total = totals.get(id) || { impressions: 0, clicks: 0, spend: 0, sales: 0, orders: 0 };
    total.impressions += Math.max(0, Number(row?.impressions) || 0);
    total.clicks += Math.max(0, Number(row?.clicks) || 0);
    total.spend += Math.max(0, Number(row?.spend ?? row?.cost) || 0);
    total.sales += Math.max(0, Number(row?.sales ?? row?.attributed_sales) || 0);
    total.orders += Math.max(0, Number(row?.orders ?? row?.purchases) || 0);
    totals.set(id, total);
  }
  return totals;
}

export function campaignSnapshotCoverage(campaignIds: string[], snapshotsByCampaign: Map<string, unknown>) {
  const expectedCampaignIds = [...new Set(campaignIds.map((id) => String(id || '').trim()).filter(Boolean))];
  const missingCampaignIds = expectedCampaignIds.filter((id) => !snapshotsByCampaign.has(id));
  return {
    complete: expectedCampaignIds.length > 0 && missingCampaignIds.length === 0,
    expectedCampaigns: expectedCampaignIds.length,
    missingCampaignIds,
  };
}
