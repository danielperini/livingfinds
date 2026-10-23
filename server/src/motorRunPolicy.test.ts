import { assertEquals } from 'jsr:@std/assert';
import { canClaimRun, classifyStageOutcome, motorFailureRemoteOutcome, motorRemoteOutcome, recoverExpiredRun, safeMotorError, summarizeMotorResult, terminalMotorStatus } from './motorRunPolicy.ts';

Deno.test('hung stage returns a queryable unknown remote outcome instead of success', () => {
  const timedOut = { ok: false, timed_out: true, remote_outcome: 'unknown', error: 'Amazon request timeout' };
  assertEquals(terminalMotorStatus(timedOut), 'remote_unknown');
  assertEquals(classifyStageOutcome(timedOut), 'remote_unknown');
  assertEquals(summarizeMotorResult(timedOut).remote_outcome, 'unknown');
});

Deno.test('asynchronous report processing is separate from a stuck motor run', () => {
  assertEquals(classifyStageOutcome({ ok: true, report_status: 'processing' }), 'report_pending');
  assertEquals(terminalMotorStatus({ ok: true, report_status: 'processing' }), 'completed');
});

Deno.test('atomic-claim policy rejects concurrent work in the same account scope', () => {
  assertEquals(canClaimRun('queued', false), true);
  assertEquals(canClaimRun('queued', true), false);
  assertEquals(canClaimRun('running', false), false);
  assertEquals(canClaimRun('remote_unknown', false), false);
});

Deno.test('restart does not replay a stage whose remote side effect may have been accepted', () => {
  assertEquals(recoverExpiredRun(null), { status: 'remote_unknown', remote_outcome: 'unknown' });
  assertEquals(recoverExpiredRun('executeApprovedDecisionQueue'), { status: 'remote_unknown', remote_outcome: 'unknown' });
});

Deno.test('a thrown queue write remains remotely unknown even when it was not a timeout', () => {
  assertEquals(motorFailureRemoteOutcome('executeApprovedDecisionQueue', false), 'unknown');
  assertEquals(motorRemoteOutcome('executeApprovedDecisionQueue', { ok: true, executed: 0 }), 'not_attempted');
  assertEquals(motorRemoteOutcome('executeApprovedDecisionQueue', { ok: true, executed: 2 }), 'sent_unconfirmed');
  assertEquals(motorRemoteOutcome('confirmExecutedDecisions', { ok: true, confirmed: 2 }), 'confirmed');
});

Deno.test('failed decision-only runs do not claim an unknown Amazon write outcome', () => {
  assertEquals(motorRemoteOutcome('runUnifiedDecisionEngine', {
    ok: false,
    failed_stages: [{ stage: 'inventory_preflight', error: 'stock guard unavailable' }],
  }), 'not_attempted');
  assertEquals(motorRemoteOutcome('runCanonicalDecisionCycle', {
    ok: false,
    error: 'decision stage failed',
  }), 'not_attempted');
  assertEquals(motorRemoteOutcome('runUnifiedDecisionEngine', {
    ok: false,
    remote_outcome: 'unknown',
  }), 'unknown');
  assertEquals(motorRemoteOutcome('executeApprovedDecisionQueue', {
    ok: false,
    error: 'executor failed before confirmation',
  }), 'unknown');
});

Deno.test('partial batches remain partial and retain per-item failures in the result summary', () => {
  const result = { ok: false, executed: 3, failed_stages: [{ stage: 'campaigns', error: 'HTTP 429' }] };
  assertEquals(terminalMotorStatus(result), 'partial');
  assertEquals((summarizeMotorResult(result).failed_stages as unknown[]).length, 1);
});

Deno.test('errors are bounded and credentials are removed before persistence', () => {
  assertEquals(safeMotorError(new Error('HTTP 500 Bearer abc.def token=secret')), 'HTTP 500 Bearer [REDACTED] token=[REDACTED]');
});
