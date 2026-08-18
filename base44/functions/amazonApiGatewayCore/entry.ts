import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { enforceBidCeilingOnPayload } from '../../shared/amazonBidCeiling.ts';
import { resolveWinnerKeywordCeilings } from '../../shared/winnerBidPolicy.ts';
import { loadConfiguredBidPolicy } from '../../shared/configuredBidPolicy.ts';
import { getSpApiAccessToken, hasManagedSpApiCredentials, invalidateSpApiAccessToken, isSpApiHost } from '../../shared/spApiLwa.ts';

async function parseAmazonApiResponse(response: Response): Promise<any> {
  const status = response.status;
  const requestId = response.headers.get('x-amzn-RequestId') || response.headers.get('x-amz-request-id') || null;
  const traceId = response.headers.get('x-amzn-trace-id') || null;
  const rateLimitHeader = response.headers.get('x-amzn-RateLimit-Limit');
  const rateLimit = rateLimitHeader ? parseFloat(rateLimitHeader) : null;
  const retryAfterHeader = response.headers.get('Retry-After');
  const retryAfter = retryAfterHeader ? parseFloat(retryAfterHeader) : null;

  const text = await response.text().catch(() => '');
  let payload: any = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }

  const ok = status >= 200 && status < 300;
  const retryable = status === 429 || status === 503 || status === 502 || status === 504;
  const partial = status === 207;

  let errors: any[] = [];
  if (!ok) {
    if (Array.isArray(payload?.errors)) errors = payload.errors;
    else if (payload?.error) errors = [{ code: payload.error, message: payload.error_description || payload.error }];
    else if (payload?.message) errors = [{ code: String(status), message: payload.message }];
    else errors = [{ code: String(status), message: text.slice(0, 200) || `HTTP ${status}` }];
  }

  return { ok, status, payload, errors, request_id: requestId, trace_id: traceId, rate_limit: rateLimit, retry_after: retryAfter, retryable, partial, raw: ok ? null : text?.slice(0, 500) };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);
const ALLOWED_HOSTS = new Set([
  'api.amazon.com',
  'advertising-api.amazon.com',
  'advertising-api-eu.amazon.com',
  'advertising-api-fe.amazon.com',
  'sellingpartnerapi-na.amazon.com',
  'sellingpartnerapi-eu.amazon.com',
  'sellingpartnerapi-fe.amazon.com',
]);

function retryDelay(attempt: number, retryAfter: number | null): number {
  if (retryAfter && retryAfter > 0) return Math.min(retryAfter * 1000, 60000);
  const base = Math.min(1000 * Math.pow(2, attempt), 30000);
  return Math.min(base + Math.floor(Math.random() * Math.max(500, base)), 60000);
}

function hasHeader(headers: Record<string, any>, name: string): boolean {
  const wanted = name.toLowerCase();
  return Object.keys(headers || {}).some((key) => key.toLowerCase() === wanted && String(headers[key] || '').trim());
}

function setHeader(headers: Record<string, any>, name: string, value: string): void {
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers || {})) {
    if (key.toLowerCase() === wanted) delete headers[key];
  }
  headers[name] = value;
}

function normalizeExpectedStatuses(value: any): Set<number> {
  const rows = Array.isArray(value) ? value : value == null ? [] : [value];
  return new Set(rows.map((item) => Number(item)).filter((item) => Number.isInteger(item) && item >= 100 && item <= 599));
}

function applyExpectedStatus(parsed: any, expectedStatuses: Set<number>) {
  if (!parsed || !expectedStatuses.has(Number(parsed.status))) return parsed;
  return {
    ...parsed,
    ok: true,
    expected_status: true,
    retryable: false,
    errors: [],
    raw: null,
  };
}

Deno.serve(async (request) => {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  let base44: any = null;
  let body: any = {};
  let attemptsUsed = 0;
  let authRefreshUsed = false;
  let authMode = 'caller_headers';

  try {
    base44 = createClientFromRequest(request);
    body = await request.json().catch(() => ({}));
    if (!body._service_role) return Response.json({ ok: false, error: 'Gateway restrito a chamadas internas' }, { status: 403 });

    const endpoint = String(body.endpoint || '');
    const method = String(body.method || 'GET').toUpperCase();
    const headers: Record<string, any> = { ...(body.headers || {}) };
    const rawPayload = body.payload ?? null;
    const maxAttempts = Math.max(1, Math.min(Number(body.max_attempts || 5), 5));
    const expectedStatuses = normalizeExpectedStatuses(body.expected_statuses);

    if (!endpoint) return Response.json({ ok: false, error: 'endpoint obrigatório' }, { status: 400 });
    if (!ALLOWED_METHODS.has(method)) return Response.json({ ok: false, error: 'Método não permitido' }, { status: 400 });

    let url: URL;
    try { url = new URL(endpoint); }
    catch { return Response.json({ ok: false, error: 'Endpoint inválido' }, { status: 400 }); }

    if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname)) {
      return Response.json({ ok: false, error: 'Host Amazon não permitido' }, { status: 403 });
    }

    const isSpRequest = isSpApiHost(url.hostname);
    const managedSpAuth = isSpRequest && hasManagedSpApiCredentials();
    if (managedSpAuth) {
      try {
        setHeader(headers, 'x-amz-access-token', await getSpApiAccessToken(false));
        authMode = 'managed_lwa';
      } catch (error: any) {
        const message = String(error?.message || error || 'Falha ao preparar autenticação SP-API');
        const completedAt = new Date().toISOString();
        await base44.asServiceRole.entities.SyncExecutionLog.create({
          amazon_account_id: body.amazon_account_id || null,
          operation: `amazon_api:${String(body.operation || url.pathname)}`,
          status: 'error',
          trigger_type: body.queue_type || 'gateway',
          started_at: startedAt,
          completed_at: completedAt,
          records_processed: 0,
          result_summary: JSON.stringify({ status: 401, auth_mode: 'managed_lwa', auth_refresh_used: false, duration_ms: Date.now() - startedMs }),
          error_message: message.slice(0, 1000),
        }).catch(() => {});
        return Response.json({
          ok: false,
          status: 401,
          retryable: false,
          auth_error: true,
          reauthorization_required: message.includes('SP_API_REAUTHORIZATION_REQUIRED'),
          errors: [{ code: message.split(':')[0], message }],
          attempts: 0,
          started_at: startedAt,
          completed_at: completedAt,
        });
      }
    } else if (isSpRequest && !hasHeader(headers, 'x-amz-access-token')) {
      return Response.json({
        ok: false,
        status: 401,
        retryable: false,
        auth_error: true,
        errors: [{ code: 'SP_API_LWA_NOT_CONFIGURED', message: 'SP-API sem x-amz-access-token e sem credenciais LWA configuradas no backend.' }],
        attempts: 0,
        started_at: startedAt,
        completed_at: new Date().toISOString(),
      });
    }

    const isAdsRequest = url.hostname.startsWith('advertising-api');
    const isBidMutation = isAdsRequest && ['POST', 'PUT'].includes(method) &&
      ['/sp/keywords', '/sp/adGroups', 'targets'].some((segment) => url.pathname.includes(segment));
    const [winnerBid, configuredBid] = isBidMutation && body.amazon_account_id
      ? await Promise.all([
          resolveWinnerKeywordCeilings(base44, body.amazon_account_id, url.pathname, method, rawPayload),
          loadConfiguredBidPolicy(base44, body.amazon_account_id),
        ])
      : [{ ceilings: {}, evidence: [] }, { ceiling: undefined, source: null }];
    const payload = isAdsRequest
      ? enforceBidCeilingOnPayload(url.pathname, method, rawPayload, winnerBid.ceilings, configuredBid.ceiling)
      : rawPayload;

    const operationName = String(body.operation || url.pathname);
    if (body.amazon_account_id) {
      const previous = await base44.asServiceRole.entities.SyncExecutionLog.filter({
        amazon_account_id: body.amazon_account_id,
        operation: `amazon_api:${operationName}`,
        status: 'error',
      }, '-completed_at', 10).catch(() => []);
      const cutoff = Date.now() - 10 * 60 * 1000;
      const throttles = previous.filter((log: any) => {
        if (new Date(log.completed_at || log.started_at || 0).getTime() < cutoff) return false;
        try { return Number(JSON.parse(log.result_summary || '{}').status) === 429; }
        catch { return String(log.error_message || '').includes('429'); }
      });
      if (throttles.length >= 3) {
        return Response.json({
          ok: false, status: 429, retryable: true, circuit_open: true,
          consecutive_429: throttles.length,
          cooldown_until: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
          errors: [{ code: 'CIRCUIT_OPEN', message: 'Operação em cooldown após respostas 429 repetidas.' }],
        }, { status: 429 });
      }
    }

    let parsed: any = null;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      attemptsUsed = attempt + 1;
      try {
        const executeRequest = async () => {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), Math.max(5000, Number(body.timeout_ms || 30000)));
          try {
            return await fetch(url.toString(), {
              method,
              headers,
              signal: controller.signal,
              body: payload == null || method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(payload),
            });
          } finally {
            clearTimeout(timeout);
          }
        };

        let response = await executeRequest();
        parsed = applyExpectedStatus(await parseAmazonApiResponse(response), expectedStatuses);

        // Um 401/403 da SP-API pode ser access token expirado entre a obtenção e o uso.
        // Renova uma única vez e repete a mesma chamada, sem expor credenciais em logs.
        if (managedSpAuth && !authRefreshUsed && !parsed.expected_status && (parsed.status === 401 || parsed.status === 403)) {
          authRefreshUsed = true;
          invalidateSpApiAccessToken();
          try {
            setHeader(headers, 'x-amz-access-token', await getSpApiAccessToken(true));
            response = await executeRequest();
            parsed = applyExpectedStatus(await parseAmazonApiResponse(response), expectedStatuses);
          } catch (error: any) {
            const message = String(error?.message || error || 'Falha ao renovar autenticação SP-API');
            parsed = {
              ok: false,
              status: 401,
              payload: null,
              errors: [{ code: message.split(':')[0], message }],
              request_id: null,
              trace_id: null,
              rate_limit: null,
              retry_after: null,
              retryable: false,
              partial: false,
              raw: null,
              auth_error: true,
              reauthorization_required: message.includes('SP_API_REAUTHORIZATION_REQUIRED'),
            };
          }
        }

        if (parsed.ok || !parsed.retryable || attempt === maxAttempts - 1) break;
        await wait(retryDelay(attempt, parsed.retry_after));
      } catch (error: any) {
        parsed = {
          ok: false, status: 0, payload: null,
          errors: [{ code: error?.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR', message: error?.message || String(error) }],
          request_id: null, trace_id: null, error_type: null, rate_limit: null,
          retry_after: null, retryable: true, partial: false, raw: null,
        };
        if (attempt === maxAttempts - 1) break;
        await wait(retryDelay(attempt, null));
      }
    }

    const completedAt = new Date().toISOString();
    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: body.amazon_account_id || null,
      operation: `amazon_api:${operationName}`,
      status: parsed?.ok ? 'success' : 'error',
      trigger_type: body.queue_type || 'gateway',
      started_at: startedAt,
      completed_at: completedAt,
      records_processed: parsed?.ok ? 1 : 0,
      result_summary: JSON.stringify({
        status: parsed?.status,
        expected_status: parsed?.expected_status === true,
        request_id: parsed?.request_id,
        rate_limit: parsed?.rate_limit,
        attempts: attemptsUsed,
        auth_mode: isSpRequest ? authMode : undefined,
        auth_refresh_used: authRefreshUsed,
        winner_bid_exceptions: winnerBid.evidence,
        configured_bid_ceiling: configuredBid.ceiling,
        settings_source: configuredBid.source,
        duration_ms: Date.now() - startedMs,
      }),
      error_message: parsed?.ok ? null : String(parsed?.errors?.[0]?.message || 'Falha Amazon').slice(0, 1000),
    }).catch(() => {});

    return Response.json({
      ...parsed,
      auth_mode: isSpRequest ? authMode : undefined,
      auth_refresh_used: authRefreshUsed,
      winner_bid_exceptions: winnerBid.evidence,
      configured_bid_ceiling: configuredBid.ceiling,
      settings_source: configuredBid.source,
      attempts: attemptsUsed,
      started_at: startedAt,
      completed_at: completedAt,
    });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || 'Erro no gateway Amazon', attempts: attemptsUsed, started_at: startedAt, completed_at: new Date().toISOString() }, { status: 500 });
  }
});
