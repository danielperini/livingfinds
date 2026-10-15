import { readAllEntityPages } from './v6siaEvidencePaging.ts';

// Operational consumers use the current snapshot window. Historical
// reports and decision evidence remain stored separately and are never relabelled fresh.
export function v6siaSnapshotQuery(accountId: string, nowMs = Date.now()) {
  return {
    amazon_account_id: accountId,
    captured_at: {
      $gte: new Date(nowMs - 24 * 60 * 60 * 1000).toISOString(),
      $lte: new Date(nowMs).toISOString(),
    },
  };
}

export async function readFreshOperationalSnapshots(
  entity: { filter: (...args: any[]) => Promise<any> }, accountId: string,
  runId?: string, nowMs = Date.now(),
): Promise<Record<string, any>[]> {
  const query = { ...v6siaSnapshotQuery(accountId, nowMs), ...(runId ? { run_id: runId } : {}) };
  const result = await readAllEntityPages(entity, query, '-captured_at');
  if (!result.complete || !result.rows) throw new Error(`Current snapshot collection incomplete: ${result.error || 'unknown'}`);
  return result.rows;
}

const dailyFields: Record<string, string> = {
  UnifiedAdsMetricsDaily: 'date', CampaignMetricsDaily: 'date', AdGroupMetricsDaily: 'date',
  TargetingMetricsDaily: 'date', PlacementMetricsDaily: 'date', UnifiedAdsMetricsHourly: 'date',
  HourlyMetric: 'date', SearchTerm: 'date', SalesDaily: 'date', DailyProductAdsAssessment: 'assessment_date',
};
const currentState = new Set(['Product', 'ProductEconomics', 'HourlySalesPattern']);
const dayBrt = (ms: number) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(ms));

export function v6siaOperationalScope(table: string, accountId: string, nowMs = Date.now()) {
  const account = { amazon_account_id: accountId };
  const recent = { $gte: new Date(nowMs - 86400000).toISOString(), $lte: new Date(nowMs).toISOString() };
  if (table === 'RepricingSnapshot') return { rule: 'snapshots_last_24_hours', query: v6siaSnapshotQuery(accountId, nowMs) };
  const field = dailyFields[table];
  if (field) return {
    rule: 'today_and_previous_daily_report',
    query: { ...account, [field]: { $gte: dayBrt(nowMs - 86400000), $lte: dayBrt(nowMs) } },
  };
  if (currentState.has(table)) return { rule: 'current_product_or_model_state', query: account };
  if (table === 'OptimizationDecision') return {
    rule: 'last_24_hours_and_unresolved_actions',
    query: { ...account, $or: [
      { updated_date: recent },
      { status: { $in: ['proposed', 'approved', 'executing', 'confirming', 'sent', 'remote_unknown'] } },
    ] },
  };
  return { rule: 'events_last_24_hours', query: { ...account, updated_date: recent } };
}
