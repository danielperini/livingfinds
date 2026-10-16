import assert from 'node:assert/strict';
import { sql } from '../../server/src/db.ts';

let handler: (request: Request) => Promise<Response>;
const originalServe = Deno.serve;
(Deno as any).serve = (fn: typeof handler) => { handler = fn; };
try {
  await import('../../base44/functions/enforceCanonicalManualCampaigns/entry.ts');
} finally {
  (Deno as any).serve = originalServe;
}

for (const mode of ['audit_only', 'dry_run']) {
  Deno.test(`${mode}: manual structure audit reports migration without API calls or writes`, async () => {
    const originalUnsafe = sql.unsafe;
    const originalFetch = globalThis.fetch;
    let writes = 0;
    const record = (id: string, data: Record<string, unknown>) => ({ id, data });
    (sql as any).unsafe = (query: string) => {
      if (/^\s*CREATE/i.test(query)) return Promise.resolve([]);
      if (!/^\s*SELECT/i.test(query)) { writes++; throw new Error('Unexpected persistence'); }
      if (query.includes('"amazon_account"')) return Promise.resolve([record('account', { status: 'connected' })]);
      if (query.includes('"campaign"')) return Promise.resolve([record('campaign-local', { campaign_id: '100', targeting_type: 'MANUAL', state: 'enabled', asin: 'B012345678', name: 'Manual test' })]);
      if (query.includes('"keyword"')) return Promise.resolve([
        record('one', { campaign_id: '100', keyword_id: '200', keyword_text: 'sofá reclinável', match_type: 'exact', state: 'enabled' }),
        record('two', { campaign_id: '100', keyword_id: '201', keyword_text: 'pilha aaa', match_type: 'exact', state: 'enabled' }),
      ]);
      if (query.includes('"product"')) return Promise.resolve([record('product', { asin: 'B012345678', fba_inventory: 10 })]);
      throw new Error(`Unexpected read: ${query.slice(0, 100)}`);
    };
    globalThis.fetch = () => { throw new Error('Audit cannot contact Amazon'); };
    try {
      const response = await handler(new Request('http://localhost/test', {
        method: 'POST', body: JSON.stringify({ _service_role: true, amazon_account_id: 'account', [mode]: true }),
      }));
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.ok, true);
      assert.equal(result.audit_only, true);
      assert.equal(result.mutations_created, 0);
      assert.equal(result.migration_required, true);
      assert.equal(result.campaigns_multi_keyword_found, 1);
      assert.equal(writes, 0);
    } finally {
      (sql as any).unsafe = originalUnsafe;
      globalThis.fetch = originalFetch;
    }
  });
}
