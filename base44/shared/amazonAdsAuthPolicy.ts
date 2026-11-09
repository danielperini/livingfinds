export const ADS_TOKEN_REVOKED_REAUTH_REQUIRED = 'ADS_TOKEN_REVOKED_REAUTH_REQUIRED';
export const ADS_TOKEN_PRECHECK_FAILED = 'ADS_TOKEN_PRECHECK_FAILED';

export type AmazonExecutionStatus = 'success' | 'partial' | 'failed';

export type AmazonAdsAuthFailure = {
  code: string;
  statusCode: number | null;
  message: string;
};

const AUTH_ERROR_CODES = new Set([
  'invalid_grant',
  'unauthorized_client',
  'invalid_token',
  'token_invalid_after_refresh',
  'access_denied',
  'authorization_code_used',
  'ads_token_revoked_reauth_required',
]);

const STATUS_KEYS = new Set(['status', 'status_code', 'http_status', 'httpstatuscode']);
const CODE_KEYS = new Set(['code', 'error', 'error_code', 'error_type', 'amazon_error_code']);
const MESSAGE_KEYS = new Set(['message', 'error_message', 'error_description', 'error_safe']);
const AUTH_MESSAGE =
  /(unauthorized_client|invalid_grant|token_invalid_after_refresh|invalid token|token revoked|reautori[sz]|not authorized|n[aã]o autorizado|\b401\b|\b403\b)/i;

function normalized(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

function scalarMessage(payload: unknown): string {
  if (!payload || typeof payload !== 'object') {
    return String(payload || 'Falha de autenticação Amazon Ads');
  }
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (MESSAGE_KEYS.has(key.toLowerCase()) && typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return 'Falha de autenticação Amazon Ads';
}

/**
 * Localiza sinais de revogação mesmo quando vierem encapsulados por invoke/axios
 * ou por um executor intermediário. O limite evita percorrer objetos arbitrários.
 */
export function getAmazonAdsAuthFailure(payload: unknown): AmazonAdsAuthFailure | null {
  const stack: Array<{ value: unknown; depth: number }> = [{ value: payload, depth: 0 }];
  const visited = new WeakSet<object>();
  let inspected = 0;
  let messageFallback: AmazonAdsAuthFailure | null = null;

  while (stack.length > 0 && inspected < 300) {
    const current = stack.pop()!;
    inspected += 1;

    if (typeof current.value === 'string') {
      if (!messageFallback && AUTH_MESSAGE.test(current.value)) {
        const code = normalized(current.value).includes('invalid_grant')
          ? 'invalid_grant'
          : normalized(current.value).includes('unauthorized_client')
          ? 'unauthorized_client'
          : 'amazon_ads_authentication_failed';
        messageFallback = { code, statusCode: null, message: current.value.slice(0, 500) };
      }
      continue;
    }
    if (!current.value || typeof current.value !== 'object' || current.depth > 8) continue;
    if (visited.has(current.value)) continue;
    visited.add(current.value);

    const objectValue = current.value as Record<string, unknown>;
    const message = scalarMessage(objectValue);
    for (const [rawKey, value] of Object.entries(objectValue)) {
      const key = rawKey.toLowerCase();
      if (STATUS_KEYS.has(key)) {
        const statusCode = Number(value);
        if (statusCode === 401 || statusCode === 403) {
          return { code: `http_${statusCode}`, statusCode, message };
        }
      }
      if (CODE_KEYS.has(key) && AUTH_ERROR_CODES.has(normalized(value))) {
        return { code: normalized(value), statusCode: null, message };
      }
      if (key === 'requires_reauthorization' && value === true) {
        return { code: 'requires_reauthorization', statusCode: null, message };
      }
      if ((Array.isArray(value) || (value && typeof value === 'object')) && current.depth < 8) {
        stack.push({ value, depth: current.depth + 1 });
      } else if (typeof value === 'string' && AUTH_MESSAGE.test(value) && !messageFallback) {
        messageFallback = {
          code: 'amazon_ads_authentication_failed',
          statusCode: null,
          message: value.slice(0, 500),
        };
      }
    }
  }

  return messageFallback;
}

export function isAmazonAdsAuthFailure(payload: unknown): boolean {
  return getAmazonAdsAuthFailure(payload) !== null;
}

export function buildAuthFailureReprocessableDecisionPatch(
  decision: Record<string, any>,
  updatedAt = new Date().toISOString(),
): Record<string, unknown> {
  const originalStatus = decision.status === 'waiting_retry' ? 'waiting_retry' : 'approved';
  return {
    status: originalStatus,
    queue_status: originalStatus === 'waiting_retry' ? 'scheduled' : 'pending',
    attempt_count: Number(decision.attempt_count || 0),
    last_attempt_at: decision.last_attempt_at || null,
    queue_processed_at: decision.queue_processed_at || null,
    executed_at: null,
    next_retry_at: decision.next_retry_at || null,
    execution_error: ADS_TOKEN_REVOKED_REAUTH_REQUIRED,
    error_message: ADS_TOKEN_REVOKED_REAUTH_REQUIRED,
    updated_at: updatedAt,
  };
}

/** `partial` exige ao menos um aceite Amazon HTTP 2xx e ao menos uma falha. */
export function classifyAmazonExecutionStatus(input: {
  confirmedActions: number;
  failedActions: number;
  authenticationFailed?: boolean;
}): AmazonExecutionStatus {
  if (input.authenticationFailed === true) return 'failed';
  if (Number(input.failedActions || 0) <= 0) return 'success';
  return Number(input.confirmedActions || 0) > 0 ? 'partial' : 'failed';
}

