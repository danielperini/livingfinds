export type CampaignRow = Record<string, unknown>;
export type DailyMetricRow = Record<string, unknown>;

const text = (value: unknown) => String(value ?? "").trim();
const number = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export function campaignIdentity(row: CampaignRow): { type: "SP" | "SB" | "SD"; id: string } | null {
  const id = text(row.campaign_id || row.amazon_campaign_id);
  const rawType = text(row.campaign_type || "SP").toUpperCase();
  if (!id || !["SP", "SB", "SD"].includes(rawType)) return null;
  return { type: rawType as "SP" | "SB" | "SD", id };
}

export function uniqueCampaigns(rows: CampaignRow[], wantedState: "enabled" | "paused") {
  const latest = new Map<string, CampaignRow>();
  for (const row of rows) {
    const identity = campaignIdentity(row);
    if (!identity) continue;
    const key = identity.type + "|" + identity.id;
    const prior = latest.get(key);
    const timestamp = text(row.synced_at || row.updated_date || row.updated_at);
    const previousTimestamp = text(prior?.synced_at || prior?.updated_date || prior?.updated_at);
    if (!prior || timestamp > previousTimestamp) latest.set(key, row);
  }
  return [...latest.values()]
    .filter((row) => text(row.state || row.status || row.amazon_status).toLowerCase() === wantedState)
    .map((row) => ({ row, identity: campaignIdentity(row)! }))
    .sort((a, b) => (a.identity.type + "|" + a.identity.id).localeCompare(b.identity.type + "|" + b.identity.id));
}

export function aggregateDailyMetrics(rows: DailyMetricRow[]) {
  const byGrain = new Map<string, DailyMetricRow>();
  const conflicts = new Set<string>();
  for (const row of rows) {
    const account = text(row.amazon_account_id);
    const campaign = text(row.campaign_id);
    const date = text(row.date).slice(0, 10);
    if (!account || !campaign || !date) continue;
    const key = account + "|" + campaign + "|" + date;
    const previous = byGrain.get(key);
    const timestamp = text(row.updated_at || row.updated_date || row.created_date);
    const previousTimestamp = text(previous?.updated_at || previous?.updated_date || previous?.created_date);
    if (!previous) byGrain.set(key, row);
    else if (timestamp > previousTimestamp) { byGrain.set(key, row); conflicts.delete(key); }
    else if (timestamp === previousTimestamp) {
      const fields = ["spend", "sales", "clicks", "impressions", "orders"];
      const identical = fields.every((field) => number(row[field]) === number(previous[field]));
      if (!identical) conflicts.add(key);
    }
  }
  for (const key of conflicts) byGrain.delete(key);
  const campaignTotals = new Map<string, { spend: number; sales: number; clicks: number; impressions: number; orders: number }>();
  const totals = { spend: 0, sales: 0, clicks: 0, impressions: 0, orders: 0 };
  for (const row of byGrain.values()) {
    const id = text(row.campaign_id);
    const values = {
      spend: number(row.spend), sales: number(row.sales), clicks: number(row.clicks),
      impressions: number(row.impressions), orders: number(row.orders),
    };
    const current = campaignTotals.get(id) || { spend: 0, sales: 0, clicks: 0, impressions: 0, orders: 0 };
    for (const key of Object.keys(totals) as Array<keyof typeof totals>) {
      totals[key] += values[key];
      current[key] += values[key];
    }
    campaignTotals.set(id, current);
  }
  const topCampaigns = [...campaignTotals.entries()]
    .map(([campaign_id, values]) => ({ campaign_id, ...values,
      acos: values.sales > 0 ? values.spend / values.sales * 100 : null,
      roas: values.spend > 0 ? values.sales / values.spend : null,
    }))
    .sort((a, b) => b.spend - a.spend)
    .slice(0, 100);
  return {
    unique_campaign_days: byGrain.size,
    conflicting_campaign_days: conflicts.size,
    campaigns_with_metrics: campaignTotals.size,
    totals,
    acos: totals.sales > 0 ? totals.spend / totals.sales * 100 : null,
    roas: totals.spend > 0 ? totals.sales / totals.spend : null,
    cpc: totals.clicks > 0 ? totals.spend / totals.clicks : null,
    ctr: totals.impressions > 0 ? totals.clicks / totals.impressions * 100 : null,
    conversion_rate: totals.clicks > 0 ? totals.orders / totals.clicks * 100 : null,
    top_campaigns_by_spend: topCampaigns,
  };
}

export function parseEmergencyRun(value: unknown) {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch { return null; }
}
