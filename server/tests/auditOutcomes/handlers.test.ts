import { assertEquals } from 'jsr:@std/assert@1';
import { setClient } from '../canonicalIncident/sdkMock.ts';

type Handler = (request: Request) => Promise<Response>;
const handlers: Handler[] = [];
const originalServe = Deno.serve;
try {
  Deno.serve = ((handler: Handler) => { handlers.push(handler); }) as typeof Deno.serve;
  await import('../../../base44/functions/auditAdsAutomationE2E/entry.ts');
  await import('../../../base44/functions/runCanonicalWeeklyDecisionReview/entry.ts');
} finally {
  Deno.serve = originalServe;
}
const [audit, weekly] = handlers;
let testQueue = Promise.resolve();
function serialTest(name: string, run: () => Promise<void>) {
  Deno.test(name, async () => {
    let release!: () => void;
    const previous = testQueue;
    testQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { await run(); } finally { release(); }
  });
}

function mockClient(options: { rows?: Record<string, any[]>; throwOn?: string; invoke?: (name: string, payload: any) => unknown }) {
  const calls: string[] = [];
  const client = {
    auth: { isAuthenticated: async () => true },
    asServiceRole: {
      entities: new Proxy({}, { get: (_target, entity: string) => ({
        filter: async () => {
          calls.push(`${entity}.filter`);
          if (options.throwOn === entity) throw new Error('mock_read_failure');
          return options.rows?.[entity] || [];
        },
        create: async () => { calls.push(`${entity}.create`); return { id: 'mock-log' }; },
      }) }),
      functions: { invoke: async (name: string, payload: any) => {
        calls.push(name);
        return { data: await options.invoke?.(name, payload) };
      } },
    },
  };
  setClient(client);
  return calls;
}

const request = (body: Record<string, unknown>) => new Request('http://test.invalid', {
  method: 'POST', body: JSON.stringify({ _service_role: true, correlation_id: 'audit-correlation', ...body }),
});

serialTest('audit handler returns HTTP 200 and explicit critical alert contract without Amazon calls', async () => {
  const calls = mockClient({ rows: { AmazonAccount: [{ id: 'a', status: 'connected' }] } });
  const response = await audit(request({ persist: false }));
  const result = await response.json();
  assertEquals(response.status, 200);
  assertEquals(result.audit_status, 'completed_with_alerts');
  assertEquals(result.technical_failure, false);
  assertEquals(result.correlation_id, 'audit-correlation');
  assertEquals(result.critical_alerts.length > 0, true);
  assertEquals(calls.some((name) => name.includes('functions.invoke')), false);
});

serialTest('audit source read failure is technical and never reported as a healthy empty audit', async () => {
  mockClient({ rows: { AmazonAccount: [{ id: 'a', status: 'connected' }] }, throwOn: 'Campaign' });
  const response = await audit(request({ persist: false }));
  const result = await response.json();
  assertEquals(response.status, 500);
  assertEquals(result.technical_failure, true);
  assertEquals(result.audit_status, 'technical_failure');
  assertEquals(result.source_errors[0].source, 'Campaign');
});

serialTest('audit marks query-limit coverage partial without declaring a technical failure', async () => {
  mockClient({ rows: {
    AmazonAccount: [{ id: 'a', status: 'connected' }],
    Campaign: Array.from({ length: 2000 }, (_, index) => ({ id: `c-${index}`, status: 'paused' })),
  } });
  const response = await audit(request({ persist: false }));
  const result = await response.json();
  assertEquals(response.status, 200);
  assertEquals(result.audit_status, 'partial');
  assertEquals(result.partial, true);
  assertEquals(result.technical_failure, false);
});

serialTest('weekly AI diagnostic failure leaves deterministic core successful and returns HTTP 200 partial', async () => {
  const calls = mockClient({ invoke: async (name) => name === 'runEconomicEvidenceDecisionPolicy'
    ? { ok: true, execution_mode: 'shadow_only' }
    : { ok: false, error: 'openai_unavailable' } });
  const response = await weekly(request({}));
  const result = await response.json();
  assertEquals(response.status, 200);
  assertEquals(result.technical_failure, false);
  assertEquals(result.partial, true);
  assertEquals(result.audit_status, 'partial');
  assertEquals(result.economic_evidence.ok, true);
  assertEquals(result.ai_diagnostic_status, 'failed_diagnostic_only');
  assertEquals(calls, ['runEconomicEvidenceDecisionPolicy', 'runWeeklyGptRuleReview']);
});

serialTest('weekly deterministic core exception is technical while AI is never invoked afterward', async () => {
  const calls = mockClient({ invoke: async () => { throw new Error('deterministic_db_timeout'); } });
  const response = await weekly(request({}));
  const result = await response.json();
  assertEquals(response.status, 500);
  assertEquals(result.technical_failure, true);
  assertEquals(result.audit_status, 'technical_failure');
  assertEquals(calls, ['runEconomicEvidenceDecisionPolicy']);
});
