import { deepStrictEqual as eq, ok } from 'node:assert/strict';
import { setClient } from '../canonicalIncident/sdkMock.ts';
import { sourceFreshness } from '../../src/motorDashboard.ts';

type Handler = (request: Request) => Promise<Response>;
const handlers: Handler[] = [];
const originalServe = Deno.serve;
try {
  Deno.serve = ((handler: Handler) => { handlers.push(handler); }) as typeof Deno.serve;
  await import('../../../base44/functions/autoStockCampaignGuard/entry.ts');
  await import('../../../base44/functions/checkInventoryChangesAndKickoff/entry.ts');
} finally { Deno.serve = originalServe; }

function installClient(failPage = false) {
  const offsets: Record<string, number[]> = {};
  let writes = 0, invocations = 0;
  const account = { id: 'a', status: 'connected' };
  const rows: Record<string, any[]> = {
    AmazonAccount: [account],
    Campaign: Array.from({ length: 3208 }, (_, index) => ({ id: String(index).padStart(5, '0'),
      amazon_account_id: 'a', campaign_id: String(10000 + index), state: 'enabled', status: 'enabled',
      sku: index === 3207 ? 'SKU-ZERO' : 'OTHER', asin: index === 3207 ? 'B0F45JG27L' : 'B000000001' })),
    Product: [{ id: 'p', amazon_account_id: 'a', sku: 'SKU-ZERO', asin: 'B0F45JG27L', fba_inventory: 0,
      status: 'active', inventory_status: 'out_of_stock', previous_fba_inventory: 0,
      last_catalog_sync_at: new Date().toISOString(), catalog_sync_status: 'success' }],
  };
  const unexpectedWrite = async () => { writes++; throw new Error('unexpected_mutation_in_read_only_test'); };
  setClient({ auth: { me: async () => ({ id: 'user' }) }, asServiceRole: {
    entities: new Proxy({}, { get: (_target, entity: string) => ({
      filter: async (_query: any, _sort: any, limit = 250, offset = 0) => {
        (offsets[entity] ||= []).push(offset);
        if (failPage && entity === 'Campaign' && offset >= 250) throw new Error('campaign_page_failed');
        return (rows[entity] || []).slice(offset, offset + limit);
      },
      create: unexpectedWrite, update: unexpectedWrite, bulkUpdate: unexpectedWrite,
    }) }), functions: { invoke: async () => { invocations++; throw new Error('Amazon/kickoff forbidden in this test'); } },
  } });
  return { offsets, checks: () => ({ writes, invocations }) };
}

for (const [index, name] of ['stock guard', 'inventory kickoff'].entries()) {
  Deno.test(`${name}: dry run reads all 3208 campaigns without Amazon calls`, async () => {
    const fixture = installClient();
    const response = await handlers[index](new Request('http://local.invalid', { method: 'POST',
      body: JSON.stringify({ _service_role: true, amazon_account_id: 'a', dry_run: true }) }));
    eq(response.status, 200);
    const result = await response.json();
    eq(result.ok, true);
    const evidence = index === 0 ? result.accounts[0] : result;
    eq(evidence.source_pagination_complete, true); eq(evidence.source_counts.campaigns, 3208);
    if (index === 0) eq(evidence.stock_guard_confirmed, false);
    else eq(result.stats.oos_with_active_campaign, 1);
    ok(fixture.offsets.Campaign.includes(3000));
    eq(fixture.checks(), { writes: 0, invocations: 0 });
  });

  Deno.test(`${name}: a failed campaign page blocks the result rather than returning empty success`, async () => {
    const fixture = installClient(true);
    const response = await handlers[index](new Request('http://local.invalid', { method: 'POST',
      body: JSON.stringify({ _service_role: true, amazon_account_id: 'a', dry_run: true }) }));
    eq(response.status, 500);
    const result = await response.json();
    eq(result.ok, false); eq(result.stock_guard_confirmed, false); eq(result.source_pagination_complete, false);
    eq(result.error, 'campaign_page_failed');
    eq(fixture.checks(), { writes: 0, invocations: 0 });
  });
}

Deno.test('freshness separates a recent update from old rows without relaxing the source safety flag', () => {
  const now = Date.parse('2026-10-23T22:10:45Z');
  const data = sourceFreshness([{ synced_at: '2026-10-23T22:04:11Z' }, { synced_at: '2026-10-21T00:00:00Z' }, {}], ['synced_at'], now);
  eq(data.latest_at, '2026-10-23T22:04:11.000Z'); eq(data.latest_status, 'fresh');
  eq(data.stale_records, 2); eq(data.total_records, 3); eq(data.status, 'data_stale');
  eq(sourceFreshness([], ['synced_at'], now).latest_status, 'data_stale');
});
