import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { parseAmazonApiResponse } from '../../shared/parseAmazonApiResponse.ts';

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
const limiter = new Map<string, { nextAt: number; rate: number }>();

function retryDelay(attempt: number, retryAfter: number | null): number {
  if (retryAfter && retryAfter > 0) return Math.min(retryAfter * 1000, 60000);
  const base = Math.min(1000 * Math.pow(2, attempt), 30000);
  return Math.min(base + Math.floor(Math.random() * Math.max(500, base)), 60000);
}

async function acquire(key: string, requestedRate: number) {
  const current = limiter.get(key) || { nextAt: 0, rate: Math.max(0.1, requestedRate || 1) };
  const delay = Math.max(0, current.nextAt - Date.now());
  if (delay > 0) await wait(delay);
  current.nextAt = Date.now() + Math.ceil(1000 / Math.max(0.1, current.rate));
  limiter.set(key, current);
}

Deno.serve(async (request) => {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  let base44: any = null;
  let body: any = {};
  let attemptsUsed = 0;

  try {
    base44 = createClientFromRequest(request);
    body = await request.json().catch(() => ({}));
    if (!body._service_role) return Response.json({ ok: false, error: 'Gateway restrito a chamadas internas' }, { status: 403 });

    const endpoint = String(body.endpoint || '');
    const method = String(body.method || 'GET').toUpperCase();
    const headers = body.headers || {};
    const payload = body.payload ?? null;
    const maxAttempts = Math.max(1, Math.min(Number(body.max_attempts || 5), 5));

    if (!endpoint) return Response.json({ ok: false, error: 'endpoint obrigatório' }, { status: 400 });
    if (!ALLOWED_METHODS.has(method)) return Response.json({ ok: false, error: 'Método não permitido' }, { status: 400 });

    let url: URL;
    try { url = new URL(endpoint); }
    catch { return Response.json({ ok: false, error: 'Endpoint inválido' }, { status: 400 }); }

    if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname)) {
      return Response.json({ ok: false, error: 'Host Amazon não permitido' }, { status: 403 });
    }

    const operationName = String(body.operation || url.pathname);
    const limiterKey = `${body.amazon_account_id || 'global'}:${url.hostname}:${operationName}`;
    if (!limiter.has(limiterKey)) limiter.set(limiterKey, { nextAt: 0, rate: Math.max(0.1, Number(body.configured_rate_limit || 1)) });

    if (body.amazon_account_id) {
      const previous = await base44.asServiceRole.entities.SyncExecutionLog.filter({
        amazon_account_id: body.amazon_account_id,
        operation: `amazon_api:${operationName}`,
        status: 'error',
      }, '-completed_at', 10).catch(() => []);
      const cutoff = Date.now() - 10 * 60 * 1000;
      const throttles = previous.filter((log) => {
        if (new Date(log.completed_at || log.started_at || 0).getTime() < cutoff) return false;
        try { return Number(JSON.parse(log.result_summary || '{}').status) === 429; }
        catch { return String(log.error_message || '').includes('429'); }
      });
      if (throttles.length >= 3) {
        return Response.json({
          ok: false,
          status: 429,
          retryable: true,
          circuit_open: true,
          consecutive_429: throttles.length,
          cooldown_until: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
          errors: [{ code: 'CIRCUIT_OPEN', message: 'Operação em cooldown após respostas 429 repetidas.' }],
        }, { status: 429 });
      }
    }

    let parsed: any = null;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      attemptsUsed = attempt + 1;
      await acquire(limiterKey, Number(body.configured_rate_limit || 1));
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), Math.max(5000, Number(body.timeout_ms || 30000)));
        const response = await fetch(url.toString(), {
          method,
          headers,
          signal: controller.signal,
          body: payload == null || method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(payload),
        }).finally(() => clearTimeout(timeout));
        parsed = await parseAmazonApiResponse(response);
        if (parsed.rate_limit && parsed.rate_limit > 0) {
          const state = limiter.get(limiterKey);
          if (state) state.rate = parsed.rate_limit;
        }
        if (parsed.ok || !parsed.retryable || attempt === maxAttempts - 1) break;
        await wait(retryDelay(attempt, parsed.retry_after));
      } catch (error) {
        parsed = {
          ok: false,
          status: 0,
          payload: null,
          errors: [{ code: error?.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR', message: error?.message || String(error) }],
          request_id: null,
          trace_id: null,
          error_type: null,
          rate_limit: null,
          retry_after: null,
          retryable: true,
          partial: false,
          raw: null,
        };
        if (attempt === maxAttempts - 1) break;
        await wait(retryDelay(attempt, null));
      }
    }

    const completedAt = new Date().toISOString();
    const effectiveRate = limiter.get(limiterKey)?.rate || 1;
    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: body.amazon_account_id || null,
      operation: `amazon_api:${operationName}`,
      status: parsed?.ok ? 'success' : 'error',
      trigger_type: body.queue_type || 'gateway',
      started_at: startedAt,
      completed_at: completedAt,
      records_processed: parsed?.ok ? 1 : 0,
      result_summary: JSON.stringify({ status: parsed?.status, request_id: parsed?.request_id, rate_limit: parsed?.rate_limit || effectiveRate, attempts: attemptsUsed, duration_ms: Date.now() - startedMs }),
      error_message: parsed?.ok ? null : String(parsed?.errors?.[0]?.message || 'Falha Amazon').slice(0, 1000),
    }).catch(() => {});

    return Response.json({ ...parsed, attempts: attemptsUsed, effective_rate_limit: effectiveRate, started_at: startedAt, completed_at: completedAt }, { status: parsed?.ok ? 200 : parsed?.status || 500 });
  } catch (error) {
    return Response.json({ ok: false, error: error?.message || 'Erro no gateway Amazon', attempts: attemptsUsed, started_at: startedAt, completed_at: new Date().toISOString() }, { status: 500 });
  }
});
