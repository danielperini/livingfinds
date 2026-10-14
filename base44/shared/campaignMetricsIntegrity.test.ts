import { assertEquals } from 'jsr:@std/assert@1';
import { aggregateLatestCampaignMetrics, brazilReportDate, brazilReportDateDaysAgo, campaignSnapshotCoverage, latestCampaignMetricsByDay } from './campaignMetricsIntegrity.ts';

const rows = [
  { campaign_id: 'c1', date: '2026-10-13', synced_at: '2026-10-14T08:00:00Z', impressions: 10, spend: 5, sales: 20, orders: 1 },
  { campaign_id: 'c1', date: '2026-10-13', synced_at: '2026-10-14T10:00:00Z', impressions: 12, spend: 6, sales: 20, orders: 1 },
  { campaign_id: 'c1', date: '2026-10-14', synced_at: '2026-10-14T11:00:00Z', impressions: 4, spend: 2, sales: 0, orders: 0 },
  { campaign_id: 'c2', date: '2026-10-13', synced_at: '2026-10-14T09:00:00Z', impressions: 3, spend: 1, sales: 0, orders: 0 },
  { campaign_id: 'c1', date: '2026-10-12', synced_at: '2026-10-14T12:00:00Z', impressions: 100, spend: 100, sales: 100, orders: 9 },
  { campaign_id: 'c1', date: '2026-10-14', synced_at: '2026-10-14T12:00:00Z', impressions: 5, spend: 3, sales: 0, orders: 0 },
  { date: '2026-10-14', spend: 999 },
];

Deno.test('keeps the freshest revision per campaign and report date', () => {
  const selected = latestCampaignMetricsByDay(rows, { startDate: '2026-10-13', endDate: '2026-10-14' });
  assertEquals(selected.length, 3);
  assertEquals(selected.find((row) => row.campaign_id === 'c1' && row.date === '2026-10-13')?.spend, 6);
});

Deno.test('aggregates campaign metrics without duplicating report revisions or campaign scopes', () => {
  const totals = aggregateLatestCampaignMetrics(rows, { startDate: '2026-10-13', endDate: '2026-10-14' });
  assertEquals(totals.get('c1'), { impressions: 17, clicks: 0, spend: 9, sales: 20, orders: 1 });
  assertEquals(totals.get('c2'), { impressions: 3, clicks: 0, spend: 1, sales: 0, orders: 0 });
  assertEquals(totals.has(''), false);
});

Deno.test('uses the Brazilian marketplace calendar across UTC midnight', () => {
  const now = new Date('2026-10-14T01:00:00.000Z'); // 22:00 on the prior day in São Paulo
  assertEquals(brazilReportDate(now), '2026-10-13');
  assertEquals(brazilReportDateDaysAgo(1, now), '2026-10-12');
});

Deno.test('blocks portfolio conclusions when even one active campaign snapshot is missing', () => {
  const coverage = campaignSnapshotCoverage(['c1', 'c2', 'c2'], new Map([['c1', {}]]));
  assertEquals(coverage, { complete: false, expectedCampaigns: 2, missingCampaignIds: ['c2'] });
});
