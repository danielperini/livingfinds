import { v6siaSnapshotQuery, v6siaOperationalScope, readFreshOperationalSnapshots } from './v6siaSnapshotScope.ts';

Deno.test('snapshot supervision is scoped to account and real last 24 hours, excluding old and future records', () => {
  const now = Date.parse('2026-10-15T13:00:00Z');
  const query = v6siaSnapshotQuery('account-a', now);
  if (query.amazon_account_id !== 'account-a' || query.captured_at.$gte !== '2026-10-14T13:00:00.000Z' || query.captured_at.$lte !== '2026-10-15T13:00:00.000Z') {
    throw new Error('Invalid operational snapshot scope');
  }
  const inScope = (date: string) => date >= query.captured_at.$gte && date <= query.captured_at.$lte;
  if (inScope('2026-08-04T13:00:00.000Z') || inScope('2026-10-16T00:00:00.000Z') || !inScope('2026-10-15T12:59:00.000Z')) throw new Error('Old or future evidence accepted');
});

Deno.test('operational metrics use today and previous report in account timezone, not unbounded history', () => {
  const now = Date.parse('2026-10-16T01:00:00Z'); // still Oct 15 in São Paulo
  for (const table of ['CampaignMetricsDaily','SearchTerm','PlacementMetricsDaily','HourlyMetric','SalesDaily','DailyProductAdsAssessment']) {
    const scope = v6siaOperationalScope(table, 'account-a', now);
    const query: any = scope.query;
    const range = query[table === 'DailyProductAdsAssessment' ? 'assessment_date' : 'date'];
    if (query.amazon_account_id !== 'account-a' || range.$gte !== '2026-10-14' || range.$lte !== '2026-10-15') throw new Error(`Unbounded or wrong report dates for ${table}`);
  }
});

Deno.test('old unresolved actions remain visible while event history is scoped and product state is current', () => {
  const decisions: any = v6siaOperationalScope('OptimizationDecision','a').query;
  if (!decisions.$or[1].status.$in.includes('remote_unknown') || !decisions.$or[0].updated_date.$gte) throw new Error('Lost uncertain remote action or recent decisions');
  if (!(v6siaOperationalScope('CampaignBidHistory','a').query as any).updated_date.$gte) throw new Error('Unbounded event scan');
  if (JSON.stringify(v6siaOperationalScope('Product','a').query) !== '{"amazon_account_id":"a"}') throw new Error('Dropped unchanged current product state');
});

Deno.test('fresh snapshot consumer paginates only the account and requested run without accepting partial evidence', async () => {
  const now = Date.parse('2026-10-15T13:00:00Z');
  const offsets: number[] = [];
  const entity = { filter: async (query: any, sort: string, limit: number, offset: number) => {
    if (query.amazon_account_id !== 'a' || query.run_id !== 'run-a' || query.captured_at.$gte !== '2026-10-14T13:00:00.000Z' || sort !== '-captured_at' || limit !== 1000) throw new Error('Unscoped snapshot read');
    offsets.push(offset);
    return offset ? [{ id: 'last' }] : Array.from({ length: 1000 }, (_, i) => ({ id: String(i) }));
  } };
  const rows = await readFreshOperationalSnapshots(entity, 'a', 'run-a', now);
  if (rows.length !== 1001 || offsets.join(',') !== '0,1000') throw new Error('Fresh snapshot pages were truncated');
  let rejected = false;
  try { await readFreshOperationalSnapshots({ filter: async () => { throw new Error('timeout'); } }, 'a', undefined, now); }
  catch (error) { rejected = String(error).includes('collection incomplete'); }
  if (!rejected) throw new Error('Incomplete snapshot evidence accepted for a financial decision');
});
