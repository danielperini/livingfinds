import { assertEquals, assertExists } from 'jsr:@std/assert@1';
import { buildFunctionPayload } from './functionPayload.ts';

Deno.test('read-only dashboard calls preserve an absent evidence correlation filter', () => {
  const body = buildFunctionPayload('getMotorCycleEvidence', { account_id: 'a', date: '2026-10-23' });
  assertEquals('correlation_id' in body, false);
});

Deno.test('read-only calls preserve an explicit historical correlation filter', () => {
  const body = buildFunctionPayload('getMotorCycleEvidence', { correlation_id: 'historical-cycle' }, 'request-trace');
  assertEquals(body.correlation_id, 'historical-cycle');
});

Deno.test('write-capable calls keep correlation propagation and nested inheritance', () => {
  assertExists(buildFunctionPayload('executeApprovedDecisionQueue', {}).correlation_id);
  assertEquals(buildFunctionPayload('executeApprovedDecisionQueue', { correlation_id: 'payload-cycle' }).correlation_id, 'payload-cycle');
  assertEquals(buildFunctionPayload('runCanonicalDecisionCycle', {}, 'parent-cycle').correlation_id, 'parent-cycle');
});
