import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { parseAmazonApiResponse } from '../../shared/parseAmazonApiResponse.ts';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function retryDelay(attempt: number, retryAfter: number | null): number {
  if (retryAfter && retryAfter > 0) return Math.min(retryAfter * 1000, 60000);
  const base = Math.min(1000 * Math.pow(2, attempt), 30000);
  return Math.min(base + Math.floor(Math.random() * Math.max(500, base)), 60000);
}

Deno.serve(async (request) => {
  const startedAt = new Date().toISOString();
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    if (!authenticated && !body._service_role) {
      return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    const { endpoint, method = 'GET', headers = {}, payload = null, max_attempts = 5 } = body;
    if (!endpoint) return Response.json({ ok: false, error: 'endpoint obrigatório' }, { status: 400 });

    const attempts = Math.max(1, Math.min(Number(max_attempts) || 5, 5));
    let parsed: any = null;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const response = await fetch(endpoint, {
        method,
        headers,
        body: payload == null || method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(payload),
      });

      parsed = await parseAmazonApiResponse(response);
      if (parsed.ok || !parsed.retryable || attempt === attempts - 1) break;
      await wait(retryDelay(attempt, parsed.retry_after));
    }

    return Response.json({
      ...parsed,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
    }, { status: parsed?.ok ? 200 : parsed?.status || 500 });
  } catch (error) {
    return Response.json({
      ok: false,
      error: error?.message || 'Erro no gateway Amazon',
      started_at: startedAt,
      completed_at: new Date().toISOString(),
    }, { status: 500 });
  }
});
