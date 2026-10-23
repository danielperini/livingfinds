import { deepStrictEqual as eq, ok } from 'node:assert/strict';
import { setClient } from './sdkMock.ts';
let handler: (request: Request) => Promise<Response>;
const original = Deno.serve;
try {
  Deno.serve = ((value: any) => { handler = value; }) as typeof Deno.serve;
  await import('../../../base44/functions/executeApprovedDecisionQueue/entry.ts');
} finally { Deno.serve = original; }
Deno.test('actual executor blocks stale and remote-unknown proposals without any Amazon invocation', async () => {
  const rows = [
    { id: 'stale', amazon_account_id: 'a', status: 'approved', action: 'update_bid', created_at: '2020-01-01' },
    { id: 'unknown', amazon_account_id: 'a', status: 'approved', action: 'pause_campaign', remote_outcome: 'unknown', created_at: new Date().toISOString() },
  ];
  const patches: any[] = [];
  let external = 0;
  setClient({ auth: { isAuthenticated: async () => true }, asServiceRole: {
    entities: new Proxy({}, { get: (_target, entity: string) => ({
      filter: async (query: any) => entity === 'AmazonAccount' ? [{ id: 'a' }] : entity === 'OptimizationDecision' ? rows.filter(row => row.status === query.status) : [],
      update: async (id: string, patch: any) => { patches.push({ id, ...patch }); Object.assign(rows.find(row => row.id === id)!, patch); },
      create: async () => { throw new Error('Unexpected write'); },
    }) }), functions: { invoke: async () => { external++; throw new Error('Amazon forbidden'); } },
  } });
  const response = await handler!(new Request('http://test.invalid', { method: 'POST', body: JSON.stringify({ _service_role: true, amazon_account_id: 'a' }) }));
  const result = await response.json();
  eq(result.executed, 0); eq(external, 0); eq(patches.length, 2);
  ok(patches.some(row => row.id === 'stale' && row.requires_new_collection));
  ok(patches.some(row => row.id === 'unknown' && row.block_reason === 'reconciliation_required'));
  eq(rows[1].remote_outcome, 'unknown');
});
