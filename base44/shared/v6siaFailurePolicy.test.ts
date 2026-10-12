import { assertEquals } from 'jsr:@std/assert';
import { classifyV6SIAFailure, sanitizeV6SIAError, verifiedNoopRetryPlan } from './v6siaFailurePolicy.ts';

Deno.test('classifies stale entities and permission errors without retrying blindly', () => {
  assertEquals(classifyV6SIAFailure(new Error('ENTITY_NOT_FOUND keyword')), 'stale_entity');
  assertEquals(classifyV6SIAFailure(new Error('HTTP 403 forbidden')), 'permission');
  assertEquals(classifyV6SIAFailure(new Error('HTTP 422 invalid bid')), 'rejected_request');
});

Deno.test('treats timeouts and unknown outcomes as requiring an Amazon probe', () => {
  assertEquals(classifyV6SIAFailure(new Error('request timeout after PUT')), 'ambiguous_remote_state');
  assertEquals(classifyV6SIAFailure(new Error('unexpected response')), 'ambiguous_remote_state');
});

Deno.test('retries only when Amazon confirms the prior value is still present', () => {
  const plan = verifiedNoopRetryPlan({
    action: 'reduce_bid', expectedBefore: 0.8, remoteValue: 0.8,
    attemptCount: 0, now: Date.parse('2026-10-12T12:00:00Z'),
  });
  assertEquals(plan?.attempt_count, 1);
  assertEquals(plan?.backoff_minutes, 5);
  assertEquals(plan?.next_retry_at, '2026-10-12T12:05:00.000Z');
  assertEquals(verifiedNoopRetryPlan({
    action: 'reduce_bid', expectedBefore: 0.8, remoteValue: 0.6,
  }), null);
});

Deno.test('does not retry missing values, unsupported actions or exhausted attempts', () => {
  assertEquals(verifiedNoopRetryPlan({ action: 'create_campaign', expectedBefore: 0, remoteValue: 0 }), null);
  assertEquals(verifiedNoopRetryPlan({ action: 'set_budget', expectedBefore: null, remoteValue: 0 }), null);
  assertEquals(verifiedNoopRetryPlan({
    action: 'set_budget', expectedBefore: 10, remoteValue: 10, attemptCount: 3, maxAttempts: 3,
  }), null);
  assertEquals(verifiedNoopRetryPlan({
    action: 'pause_campaign', expectedBefore: 'ENABLED', remoteValue: 'enabled',
  })?.attempt_count, 1);
  assertEquals(verifiedNoopRetryPlan({
    action: 'pause_campaign', expectedBefore: 'UNKNOWN', remoteValue: 'UNKNOWN',
  }), null);
});

Deno.test('redacts credentials from failure text', () => {
  assertEquals(sanitizeV6SIAError(new Error('Bearer abc.def refresh_token=secret')), 'Bearer [REDACTED] refresh_token=[REDACTED]');
});
