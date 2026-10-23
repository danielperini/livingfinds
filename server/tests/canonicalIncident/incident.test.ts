import { deepStrictEqual as equal, ok } from 'node:assert/strict';
import { setClient } from './sdkMock.ts';
import { motorRemoteOutcome, terminalMotorStatus } from '../../src/motorRunPolicy.ts';

// Load the actual handlers with a test-only SDK and capture their registration.
// No server is started and the suite runs without network permissions.
type Handler = (request: Request) => Promise<Response>;
const handlers: Handler[] = [];
const originalServe = Deno.serve;
try {
  Deno.serve = ((handler: Handler) => { handlers.push(handler); }) as typeof Deno.serve;
  await import('../../../base44/functions/enforceCanonicalManualCampaigns/entry.ts');
  await import('../../../base44/functions/runUnifiedDecisionEngine/entry.ts');
  await import('../../../base44/functions/runCanonicalDecisionCycle/entry.ts');
} finally {
  Deno.serve = originalServe;
}
const [audit, unified, canonical] = handlers;
const call = async (handler: Handler, body: Record<string, unknown> = {}) =>
  (await handler(new Request('http://test.invalid', {
    method: 'POST', body: JSON.stringify({ _service_role: true, amazon_account_id: 'account-1', ...body }),
  }))).json();

function mockClient(rows: Record<string, any[]> = {}, invoke?: (name: string, payload: any) => any) {
  const calls: Array<{ name: string; payload: any }> = [];
  const entities = new Proxy({}, {
    get: (_target, entity: string) => ({
      filter: async () => rows[entity] || [],
      create: async (payload: any) => {
        calls.push({ name: `${entity}.create`, payload });
        throw new Error(`Unexpected write: ${entity}.create`);
      },
      update: async (_id: string, payload: any) => {
        calls.push({ name: `${entity}.update`, payload });
        throw new Error(`Unexpected write: ${entity}.update`);
      },
    }),
  });
  const client = {
    auth: { isAuthenticated: async () => true },
    asServiceRole: {
      entities,
      functions: { invoke: async (name: string, payload: any) => {
        calls.push({ name, payload });
        return { data: await (invoke ? invoke(name, payload) : { ok: true }) };
      } },
    },
  };
  setClient(client);
  return { client, calls };
}

const auditRows = {
  AmazonAccount: [{ id: 'account-1' }],
  Campaign: [
    { id: 'local-1', campaign_id: 'remote-1', asin: 'ASIN1', targeting_type: 'manual', state: 'enabled' },
    { id: 'local-2', campaign_id: 'remote-2', asin: 'ASIN1', targeting_type: 'manual', state: 'paused', name: 'term +3' },
  ],
  Keyword: [
    { campaign_id: 'remote-1', keyword_text: 'term one', match_type: 'exact' },
    { campaign_id: 'remote-1', keyword_text: 'term two', match_type: 'exact' },
  ],
};

for (const mode of [{ audit_only: true }, { dry_run: true }, { _canonical_orchestrator: 'runUnifiedDecisionEngine' }]) {
  Deno.test(`manual structure audit does not migrate, retry, archive or negate: ${JSON.stringify(mode)}`, async () => {
    const { calls } = mockClient(auditRows, () => { throw new Error('Unexpected external function call'); });
    const result = await call(audit, mode);
    equal(result.ok, true);
    equal(result.audit_only, true);
    equal(result.evidence_scope, 'local_snapshot');
    equal(result.campaigns_multi_keyword_found, 1);
    equal(result.campaigns_requiring_remote_verification, 1);
    equal(result.migration_required, true);
    equal(result.executed, 0);
    equal(result.confirmed, 0);
    equal(result.remote_outcome, 'not_attempted');
    equal(calls, []);
  });
}

Deno.test('failed local evidence is not reported as a successful empty audit', async () => {
  const { client } = mockClient(auditRows);
  client.asServiceRole.entities = {
    AmazonAccount: { filter: async () => auditRows.AmazonAccount },
    Campaign: { filter: async () => { throw new Error('local_read_failed'); } },
    Keyword: { filter: async () => [] }, Product: { filter: async () => [] },
  } as any;
  const result = await call(audit, { audit_only: true });
  equal(result.ok, false);
  equal(result.error, 'local_read_failed');
});

function engineMock(fail?: (name: string) => any) {
  return mockClient({}, (name, payload) => {
    if (name === 'checkInventoryChangesAndKickoff') return {
      ok: true, inventory_sync_confirmed: true, stock_guard_confirmed: true,
    };
    if (name === 'enforceCanonicalManualCampaigns') equal(payload.audit_only, true);
    return fail?.(name) || { ok: true };
  });
}

Deno.test('explicit remote unknown stops subsequent unified stages and survives the durable result', async () => {
  const { calls } = engineMock((name) => name === 'enforceCanonicalManualCampaigns'
    ? { ok: false, remote_outcome: 'unknown', error: 'remote response lost' } : undefined);
  const result = await call(unified);
  equal(calls.at(-1)?.name, 'enforceCanonicalManualCampaigns');
  equal(result.ok, false);
  equal(result.remote_outcome, 'unknown');
  equal(result.blocked_by, 'enforceCanonicalManualCampaigns');
  equal(terminalMotorStatus(result), 'remote_unknown');
  equal(motorRemoteOutcome('runUnifiedDecisionEngine', result), 'unknown');
});

Deno.test('180000ms timeout blocks later stages; a late handler completion is never retried', async () => {
  let completeLate!: (value: any) => void;
  let pending = false;
  const { calls } = engineMock((name) => {
    if (name !== 'enforceCanonicalManualCampaigns') return;
    pending = true;
    return new Promise((resolve) => { completeLate = resolve; });
  });
  const originalTimeout = globalThis.setTimeout;
  try {
    globalThis.setTimeout = ((callback: () => void, delay: number) => {
      if (pending && delay === 180_000) {
        queueMicrotask(callback);
        return 0;
      }
      return originalTimeout(callback, delay);
    }) as typeof setTimeout;
    const result = await call(unified);
    equal(result.remote_outcome, 'unknown');
    equal(calls.at(-1)?.name, 'enforceCanonicalManualCampaigns');
    ok(result.failed_stages.some((stage: any) => stage.stage === 'manualStructureAudit' && stage.error.includes('180000')));
    const count = calls.length;
    completeLate({ ok: true });
    await Promise.resolve();
    equal(calls.length, count);
    equal(terminalMotorStatus(result), 'remote_unknown');
  } finally {
    globalThis.setTimeout = originalTimeout;
  }
});

Deno.test('healthy unified cycle requests read-only audit and continues deterministic stages', async () => {
  const { calls } = engineMock();
  const result = await call(unified);
  equal(result.ok, true);
  ok(calls.some(({ name }) => name === 'runDeterministicDecisionEngine'));
  equal(result.remote_outcome, undefined);
});

for (const unknownStage of ['runUnifiedDecisionEngine', 'runEconomicEvidenceDecisionPolicy']) {
  Deno.test(`canonical cycle preserves uncertainty from ${unknownStage} despite successful diagnostic AI`, async () => {
    const { calls } = mockClient(auditRows, (name) => {
      if (name === unknownStage) return { ok: false, remote_outcome: 'unknown', blocked_by: 'enforceCanonicalManualCampaigns' };
      if (name === 'superviseV6SIA') return { ok: true, ai_recommendation_status: 'diagnostic_only', model: 'gpt-6-luna' };
      return { ok: true };
    });
    const result = await call(canonical);
    equal(result.ok, false);
    equal(result.remote_outcome, 'unknown');
    equal(result.pre_execution_reconciliation.reason, 'remote_reconciliation_required');
    equal(result.pre_execution_arbitration.blocked, true);
    equal(result.v6sia_supervision.ai_recommendation_status, 'diagnostic_only');
    equal(calls.filter(({ name }) => ['reconcileEconomicEvidenceDecisions', 'arbitrateCanonicalDecisionConflicts'].includes(name)), []);
    if (unknownStage === 'runEconomicEvidenceDecisionPolicy') equal(calls.some(({ name }) => name === 'runUnifiedDecisionEngine'), false);
    equal(terminalMotorStatus(result), 'remote_unknown');
    equal(motorRemoteOutcome('runCanonicalDecisionCycle', result), 'unknown');
  });
}

Deno.test('PR #173: AI failure remains account-aware and does not block healthy core stages', async () => {
  const { calls } = mockClient(auditRows, (name) => name === 'runCanonicalAIDecisionReview'
    ? { ok: false, error: 'AI unavailable' } : { ok: true });
  const result = await call(canonical, { amazon_account_id: null });
  equal(result.ok, true);
  equal(result.ai_review.ok, false);
  equal(calls.find(({ name }) => name === 'runCanonicalAIDecisionReview')?.payload.amazon_account_id, 'account-1');
  ok(calls.some(({ name }) => name === 'reconcileEconomicEvidenceDecisions'));
  ok(calls.some(({ name }) => name === 'arbitrateCanonicalDecisionConflicts'));
  equal(result.remote_outcome, undefined);
});
