import { secrets } from "base44:runtime";

const ZYTE_ENDPOINT = "https://api.zyte.com/v1/extract";
const RETRYABLE_STATUS = new Set([429, 503, 520]);
const inflight = new Map<string, Promise<ZyteExtractResult>>();

type ZyteOutput = "httpResponseBody" | "product" | "productList";

export type ZyteExtractInput = {
  base44: any;
  amazonAccountId?: string | null;
  operation: string;
  url: string;
  output: ZyteOutput;
  cacheTtlMs?: number;
  extractFrom?: "httpResponseBody" | "browserHtml";
  tags?: Record<string, string>;
};

export type ZyteExtractResult = {
  data: any;
  cacheHit: boolean;
  requestHash: string;
  attempts: number;
};

export class ZyteApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "ZyteApiError";
  }
}

function nowIso() {
  return new Date().toISOString();
}

function numberEnv(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const parsed = Number(secrets.get(name));
  return Number.isFinite(parsed)
    ? Math.max(minimum, Math.min(maximum, parsed))
    : fallback;
}

function canonicalJson(value: Record<string, unknown>) {
  return JSON.stringify(
    Object.keys(value).sort().reduce((result, key) => {
      result[key] = value[key];
      return result;
    }, {} as Record<string, unknown>),
  );
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function assertAllowedZyteUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ZyteApiError(
      "URL inválida para pesquisa externa.",
      400,
      "INVALID_URL",
    );
  }
  if (url.protocol !== "https:") {
    throw new ZyteApiError(
      "A pesquisa externa aceita somente HTTPS.",
      400,
      "HTTPS_REQUIRED",
    );
  }
  const hostname = url.hostname.toLowerCase();
  const allowed = [
    "amazon.com.br",
    "amazon.com",
    "amazon.com.mx",
  ].some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
  if (!allowed) {
    throw new ZyteApiError(
      `Domínio não autorizado para Zyte: ${hostname}`,
      400,
      "DOMAIN_NOT_ALLOWED",
    );
  }
  url.hash = "";
  return url;
}

export function extractAmazonAsin(value: unknown) {
  const match = String(value || "").toUpperCase().match(
    /\/(?:DP|GP\/PRODUCT)\/([A-Z0-9]{10})(?:[/?#]|$)/,
  );
  return match?.[1] || null;
}

export function decodeZyteHttpBody(value: unknown) {
  if (typeof value !== "string" || !value) return "";
  try {
    const binary = atob(value);
    return new TextDecoder().decode(
      Uint8Array.from(binary, (char) => char.charCodeAt(0)),
    );
  } catch {
    return "";
  }
}

function cacheOperation(operation: string, output: ZyteOutput) {
  return `zyte:${operation}:${output}`.slice(0, 180);
}

async function readCache(
  base44: any,
  accountId: string,
  operation: string,
  requestHash: string,
) {
  const rows = await base44.asServiceRole.entities.ApiCallCache.filter(
    {
      amazon_account_id: accountId,
      operation,
      request_hash: requestHash,
      status: "valid",
    },
    "-updated_date",
    3,
  ).catch(() => []);
  const cached = rows.find((row: any) =>
    new Date(row.expires_at || 0).getTime() > Date.now()
  );
  if (!cached?.response_json) return null;
  try {
    const data = JSON.parse(cached.response_json);
    await base44.asServiceRole.entities.ApiCallCache.update(cached.id, {
      last_used_at: nowIso(),
      reuse_count: Number(cached.reuse_count || 0) + 1,
    }).catch(() => {});
    return data;
  } catch {
    await base44.asServiceRole.entities.ApiCallCache.update(cached.id, {
      status: "error",
    }).catch(() => {});
    return null;
  }
}

async function writeCache(
  base44: any,
  accountId: string,
  operation: string,
  requestHash: string,
  data: any,
  ttlMs: number,
) {
  const payload = {
    amazon_account_id: accountId,
    operation,
    endpoint: ZYTE_ENDPOINT,
    request_hash: requestHash,
    response_json: JSON.stringify(data),
    status: "valid",
    expires_at: new Date(Date.now() + ttlMs).toISOString(),
    last_used_at: nowIso(),
    reuse_count: 0,
  };
  const rows = await base44.asServiceRole.entities.ApiCallCache.filter(
    {
      amazon_account_id: accountId,
      operation,
      request_hash: requestHash,
    },
    "-updated_date",
    1,
  ).catch(() => []);
  if (rows[0]?.id) {
    await base44.asServiceRole.entities.ApiCallCache.update(rows[0].id, payload)
      .catch(() => {});
  } else {
    await base44.asServiceRole.entities.ApiCallCache.create(payload).catch(
      () => {},
    );
  }
}

async function logRequest(base44: any, input: Record<string, unknown>) {
  await base44.asServiceRole.entities.ExternalApiRequestLog.create({
    provider: "zyte",
    endpoint: ZYTE_ENDPOINT,
    created_at: nowIso(),
    ...input,
  }).catch((error: any) => {
    console.warn(
      "[zyteApi] falha ao persistir log:",
      error?.message || String(error),
    );
  });
}

async function enforceDailyLimit(base44: any) {
  const maximum = numberEnv("ZYTE_DAILY_REQUEST_LIMIT", 200, 1, 5000);
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const rows = await base44.asServiceRole.entities.ExternalApiRequestLog.filter(
    {
      provider: "zyte",
      cache_hit: false,
      created_at: { $gte: start.toISOString() },
    },
    "-created_at",
    maximum + 1,
  ).catch(() => []);
  if (rows.length >= maximum) {
    throw new ZyteApiError(
      `Limite diário interno da Zyte atingido (${maximum} requisições).`,
      429,
      "ZYTE_DAILY_LIMIT_REACHED",
      false,
    );
  }
}

function retryDelayMs(response: Response, attempt: number) {
  const retryAfter = Number(response.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(30000, retryAfter * 1000);
  }
  return Math.min(
    10000,
    800 * (2 ** Math.max(0, attempt - 1)) + Math.floor(Math.random() * 250),
  );
}

async function delay(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function execute(
  input: ZyteExtractInput,
  requestHash: string,
  payload: Record<string, unknown>,
) {
  const apiKey = secrets.get("ZYTE_API_KEY");
  if (!apiKey) {
    throw new ZyteApiError(
      "ZYTE_API_KEY não configurada no backend.",
      503,
      "ZYTE_API_KEY_MISSING",
    );
  }
  const accountId = String(input.amazonAccountId || "external-research");
  const operation = cacheOperation(input.operation, input.output);
  const cacheTtlMs = Math.max(60000, input.cacheTtlMs ?? 6 * 60 * 60 * 1000);
  const cached = await readCache(
    input.base44,
    accountId,
    operation,
    requestHash,
  );
  if (cached) {
    await logRequest(input.base44, {
      amazon_account_id: accountId,
      operation: input.operation,
      target_url: input.url,
      output_type: input.output,
      request_hash: requestHash,
      http_status: 200,
      success: true,
      cache_hit: true,
      attempt_number: 0,
      duration_ms: 0,
    });
    return { data: cached, cacheHit: true, requestHash, attempts: 0 };
  }

  await enforceDailyLimit(input.base44);
  const maxAttempts = numberEnv("ZYTE_MAX_ATTEMPTS", 3, 1, 5);
  const timeoutMs = numberEnv("ZYTE_REQUEST_TIMEOUT_MS", 45000, 5000, 90000);
  let lastError: ZyteApiError | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const started = Date.now();
    let response: Response | null = null;
    try {
      response = await fetch(ZYTE_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Basic ${btoa(`${apiKey}:`)}`,
          "Content-Type": "application/json",
          "Accept-Encoding": "gzip, deflate",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const responseText = await response.text();
      const parsed = responseText ? JSON.parse(responseText) : {};
      if (response.ok) {
        await writeCache(
          input.base44,
          accountId,
          operation,
          requestHash,
          parsed,
          cacheTtlMs,
        );
        await logRequest(input.base44, {
          amazon_account_id: accountId,
          operation: input.operation,
          target_url: input.url,
          output_type: input.output,
          request_hash: requestHash,
          http_status: response.status,
          request_id: response.headers.get("request-id") ||
            response.headers.get("x-request-id"),
          success: true,
          cache_hit: false,
          attempt_number: attempt,
          duration_ms: Date.now() - started,
        });
        return {
          data: parsed,
          cacheHit: false,
          requestHash,
          attempts: attempt,
        };
      }
      const detail = String(
        parsed?.detail || parsed?.title || parsed?.message || parsed?.error ||
          `HTTP ${response.status}`,
      ).slice(0, 500);
      lastError = new ZyteApiError(
        `Zyte HTTP ${response.status}: ${detail}`,
        response.status,
        `ZYTE_HTTP_${response.status}`,
        RETRYABLE_STATUS.has(response.status),
      );
      await logRequest(input.base44, {
        amazon_account_id: accountId,
        operation: input.operation,
        target_url: input.url,
        output_type: input.output,
        request_hash: requestHash,
        http_status: response.status,
        request_id: response.headers.get("request-id") ||
          response.headers.get("x-request-id"),
        success: false,
        cache_hit: false,
        attempt_number: attempt,
        duration_ms: Date.now() - started,
        error_code: lastError.code,
        error_message: detail,
      });
      if (!lastError.retryable || attempt === maxAttempts) throw lastError;
      await delay(retryDelayMs(response, attempt));
    } catch (error: any) {
      if (error instanceof ZyteApiError) {
        if (!error.retryable || attempt === maxAttempts) throw error;
        continue;
      }
      lastError = new ZyteApiError(
        `Falha de rede na Zyte: ${
          String(error?.message || error).slice(0, 300)
        }`,
        502,
        error?.name === "TimeoutError" ? "ZYTE_TIMEOUT" : "ZYTE_NETWORK_ERROR",
        true,
      );
      await logRequest(input.base44, {
        amazon_account_id: accountId,
        operation: input.operation,
        target_url: input.url,
        output_type: input.output,
        request_hash: requestHash,
        http_status: 0,
        success: false,
        cache_hit: false,
        attempt_number: attempt,
        duration_ms: Date.now() - started,
        error_code: lastError.code,
        error_message: lastError.message,
      });
      if (attempt === maxAttempts) throw lastError;
      await delay(Math.min(10000, 800 * (2 ** (attempt - 1))));
    }
  }
  throw lastError ||
    new ZyteApiError("Zyte indisponível.", 502, "ZYTE_UNAVAILABLE");
}

export async function zyteExtract(
  input: ZyteExtractInput,
): Promise<ZyteExtractResult> {
  const url = assertAllowedZyteUrl(input.url);
  const payload: Record<string, unknown> = {
    url: url.toString(),
    [input.output]: true,
    tags: {
      application: "livingfinds",
      operation: input.operation,
      ...(input.tags || {}),
    },
  };
  if (input.extractFrom && input.output !== "httpResponseBody") {
    payload[`${input.output}Options`] = { extractFrom: input.extractFrom };
  }
  const requestHash = await sha256(canonicalJson(payload));
  const existing = inflight.get(requestHash);
  if (existing) return await existing;
  const promise = execute(
    { ...input, url: url.toString() },
    requestHash,
    payload,
  )
    .finally(() => inflight.delete(requestHash));
  inflight.set(requestHash, promise);
  return await promise;
}
