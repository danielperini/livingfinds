export type ParsedAmazonResponse = {
  ok: boolean;
  status: number;
  payload: unknown;
  errors: Array<{ code?: string; message?: string; details?: unknown }>;
  request_id: string | null;
  trace_id: string | null;
  error_type: string | null;
  rate_limit: number | null;
  retry_after: number | null;
  retryable: boolean;
  partial: boolean;
  raw: unknown;
};

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

function headerNumber(headers: Headers, name: string): number | null {
  const value = headers.get(name);
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function parseAmazonApiResponse(response: Response): Promise<ParsedAmazonResponse> {
  const raw = await response.json().catch(async () => {
    const text = await response.text().catch(() => '');
    return text ? { message: text } : {};
  });

  const root = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const rawErrors = Array.isArray(root.errors)
    ? root.errors
    : Array.isArray(root.error)
      ? root.error
      : [];

  const errors = rawErrors.map((item) => {
    const error = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    return {
      code: String(error.code || error.errorType || ''),
      message: String(error.message || error.description || ''),
      details: error.details || error.errorValue || null,
    };
  });

  if (!errors.length && !response.ok) {
    errors.push({
      code: String(root.code || root.error || response.status),
      message: String(root.message || root.error_description || response.statusText || 'Erro Amazon'),
      details: root.details || null,
    });
  }

  const payload = Object.prototype.hasOwnProperty.call(root, 'payload') ? root.payload : raw;
  const partial = response.status === 207 || errors.length > 0 && response.ok;

  return {
    ok: response.ok && !partial,
    status: response.status,
    payload,
    errors,
    request_id: response.headers.get('x-amzn-requestid') || response.headers.get('x-amzn-request-id'),
    trace_id: response.headers.get('x-amzn-trace-id'),
    error_type: response.headers.get('x-amzn-errortype'),
    rate_limit: headerNumber(response.headers, 'x-amzn-ratelimit-limit'),
    retry_after: headerNumber(response.headers, 'retry-after'),
    retryable: RETRYABLE.has(response.status),
    partial,
    raw,
  };
}
