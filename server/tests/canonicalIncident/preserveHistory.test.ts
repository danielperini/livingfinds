import { deepStrictEqual as eq } from 'node:assert/strict';
import { setClient } from './sdkMock.ts';
let handler: (request: Request) => Promise<Response>;
const original = Deno.serve;
try {
  Deno.serve = ((value: any) => { handler = value; }) as typeof Deno.serve;
  await import('../../../base44/functions/pruneMotorDecisionHistory/entry.ts');
} finally { Deno.serve = original; }
Deno.test('history cleanup is audit-only even when a legacy caller requests dry_run false', async () => {
  let writes = 0;
  setClient({ auth: { isAuthenticated: async () => true }, asServiceRole: {
    entities: new Proxy({}, { get: (_t, entity: string) => ({
      filter: async () => entity === 'OptimizationDecision' ? [{ id: 'legacy-evidence', status: 'blocked' }] : [],
      delete: async () => { writes++; throw new Error('History deletion forbidden'); },
      create: async () => { writes++; throw new Error('Unexpected mutation'); },
    }) }),
  } });
  const response = await handler!(new Request('http://test.invalid', { method: 'POST', body: JSON.stringify({ amazon_account_id: 'a', dry_run: false }) }));
  const result = await response.json();
  eq(result.ok, true); eq(result.read_only, true); eq(result.dry_run, true);
  eq(result.accounts[0].candidates[0].id, 'legacy-evidence');
  eq(result.totals.removed_decisions, 0); eq(writes, 0);
});
