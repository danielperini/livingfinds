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

function retryDelay(attempt: number, retryAfter: number | null): number {
  if (retryAfter && retryAfter > 0) return Math.min(retryAfter * 1000, 60000);
  const base = Math.min(1000 * Math.pow(2, attempt), 30000);
  return Math.min(base + Math.floor(Math.random() * Math.max(500, base)), 60000);
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

    let parsed: any = null;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      attemptsUsed = attempt + 1;
      const response = await fetch(url.toString(), {
        method,
        headers,
        body: payload == null || method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(payload),
      });
      parsed = await parseAmazonApiResponse(response);
      if (parsed.ok || !parsed.retryable || attempt === maxAttempts - 1) break;
      await wait(retryDelay(attempt, parsed.retry_after));
    }

    const completedAt = new Date().toISOString();
    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: body.amazon_account_id || null,
      operation: `amazon_api:${body.operation || url.pathname}`,
      status: parsed?.ok ? 'success' : 'error',
      trigger_type: body.queue_type || 'gateway',
      started_at: startedAt,
      completed_at: completedAt,
      records_processed: parsed?.ok ? 1 : 0,
      result_summary: JSON.stringify({ status: parsed?.status, request_id: parsed?.request_id, rate_limit: parsed?.rate_limit, attempts: attemptsUsed, duration_ms: Date.now() - startedMs }),
      error_message: parsed?.ok ? null : String(parsed?.errors?.[0]?.message || 'Falha Amazon').slice(0, 1000),
    }).catch(() => {});

    return Response.json({ ...parsed, attempts: attemptsUsed, started_at: startedAt, completed_at: completedAt }, { status: parsed?.ok ? 200 : parsed?.status || 500 });
  } catch (error) {
    return Response.json({ ok: false, error: error?.message || 'Erro no gateway Amazon', attempts: attemptsUsed, started_at: startedAt, completed_at: new Date().toISOString() }, { status: 500 });
  }
});
