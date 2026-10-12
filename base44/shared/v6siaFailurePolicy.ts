export type V6SIAFailureClass =
  | 'stale_entity'
  | 'permission'
  | 'rejected_request'
  | 'ambiguous_remote_state';

export function sanitizeV6SIAError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? 'Unknown execution error');
  return raw
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/(refresh_token|client_secret|access_token)[=:]\s*[^\s,}]+/gi, '$1=[REDACTED]')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 600);
}

export function classifyV6SIAFailure(error: unknown): V6SIAFailureClass {
  const message = sanitizeV6SIAError(error).toLowerCase();
  if (/entity_not_found|entitynotfound|keyword.{0,20}(not found|does not exist)|http\s*404|status\s*404/.test(message)) {
    return 'stale_entity';
  }
  if (/http\s*401|http\s*403|status\s*401|status\s*403|unauthori[sz]ed|forbidden|permission denied/.test(message)) {
    return 'permission';
  }
  if (/http\s*400|http\s*422|status\s*400|status\s*422|invalid (request|keyword|campaign|bid)|unsupported action|validation/.test(message)) {
    return 'rejected_request';
  }
  // Network failures and unknown outcomes are ambiguous: the remote write may
  // have succeeded before the caller timed out. Always probe Amazon first.
  return 'ambiguous_remote_state';
}

export function verifiedNoopRetryPlan(input: {
  action: string;
  remoteValue: unknown;
  expectedBefore: unknown;
  attemptCount?: number;
  maxAttempts?: number;
  now?: number;
  tolerance?: number;
}): { attempt_count: number; next_retry_at: string; backoff_minutes: number } | null {
  const retryable = new Set([
    'set_bid', 'reduce_bid', 'increase_bid', 'update_bid',
    'set_budget', 'update_budget', 'reduce_budget', 'increase_budget',
    'pause_campaign', 'enable_campaign', 'pause_keyword', 'enable_keyword',
  ]);
  if (!retryable.has(String(input.action || ''))) return null;
  if (input.expectedBefore === undefined || input.expectedBefore === null ||
      input.remoteValue === undefined || input.remoteValue === null) return null;

  const expectedNumber = Number(input.expectedBefore);
  const remoteNumber = Number(input.remoteValue);
  const numeric = Number.isFinite(expectedNumber) && Number.isFinite(remoteNumber);
  const same = numeric
    ? Math.abs(expectedNumber - remoteNumber) <= (input.tolerance ?? 0.01)
    : String(input.expectedBefore).trim().toLowerCase() === String(input.remoteValue).trim().toLowerCase();
  if (!same) return null;

  const attempts = Math.max(0, Number(input.attemptCount || 0));
  const maxAttempts = Math.max(1, Number(input.maxAttempts || 3));
  if (attempts >= maxAttempts) return null;

  const backoffMinutes = Math.min(60, 5 * (2 ** Math.min(attempts, 4)));
  return {
    attempt_count: attempts + 1,
    backoff_minutes: backoffMinutes,
    next_retry_at: new Date((input.now ?? Date.now()) + backoffMinutes * 60_000).toISOString(),
  };
}
