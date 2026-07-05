// v3 — fetch direto à Amazon Ads API (sem invoke intermediário para evitar 403 no asServiceRole chain)
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const ALLOWED_PATHS = [
  '/sp/campaigns', '/sp/campaigns/list',
  '/sp/adGroups', '/sp/adGroups/list',
  '/sp/productAds', '/sp/productAds/list',
  '/sp/keywords', '/sp/keywords/list',
  '/v2/sp/campaigns', '/v2/sp/adGroups', '/v2/sp/keywords', '/v2/sp/negativeKeywords',
  '/sp/negativeKeywords', '/sp/negativeKeywords/list',
  '/sp/targets', '/sp/targets/list', '/v2/sp/targets',
  '/v2/profiles',
];
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE']);

function adsBase(region: string | undefined) {
  const value = String(region || Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
  if (value.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (value.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function getAccessToken(account: any) {
  const entityToken = account.ads_refresh_token;
  if (!entityToken || !entityToken.startsWith('Atzr|')) {
    throw new Error('Token Amazon Ads não configurado. Reconecte a conta em Integrações → Amazon.');
  }
  const clientId = Deno.env.get('ADS_CLIENT_ID') || '';
  const secret = Deno.env.get('ADS_CLIENT_SECRET') || '';
  if (!clientId || !secret) throw new Error('Credenciais ADS_CLIENT_ID/ADS_CLIENT_SECRET ausentes');
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: entityToken,
      client_id: clientId,
      client_secret: secret,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || 'Falha no token Amazon Ads');
  }
  return data.access_token;
}

async function callAmazonApi(url: string, method: string, headers: Record<string, string>, payload: any, maxAttempts = 3) {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let lastResult: any = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      const response = await fetch(url, {
        method,
        headers,
        signal: controller.signal,
        body: payload == null || method === 'GET' ? undefined : JSON.stringify(payload),
      }).finally(() => clearTimeout(timeout));

      const text = await response.text().catch(() => '');
      let parsed: any = null;
      try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }

      const ok = response.status >= 200 && response.status < 300;
      const retryable = response.status === 429 || response.status === 503 || response.status === 502;
      lastResult = { ok, status: response.status, payload: parsed, errors: ok ? [] : [{ code: String(response.status), message: text.slice(0, 300) }] };

      if (ok || !retryable || attempt === maxAttempts - 1) break;
      await wait(Math.min(1000 * Math.pow(2, attempt), 15000));
    } catch (err: any) {
      lastResult = { ok: false, status: 0, payload: null, errors: [{ code: 'NETWORK_ERROR', message: err?.message || String(err) }] };
      if (attempt === maxAttempts - 1) break;
      await wait(2000);
    }
  }
  return lastResult;
}

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    if (!body._service_role) return Response.json({ ok: false, error: 'Uso interno' }, { status: 403 });
    if (!body.amazon_account_id || !body.path) return Response.json({ ok: false, error: 'Conta e path obrigatórios' }, { status: 400 });

    const method = String(body.method || 'GET').toUpperCase();
    const path = String(body.path || '');
    if (!ALLOWED_METHODS.has(method)) return Response.json({ ok: false, error: 'Método não permitido' }, { status: 400 });
    if (!ALLOWED_PATHS.some((allowed) => path === allowed || path.startsWith(`${allowed}?`) || path.startsWith(`${allowed}/`))) {
      return Response.json({ ok: false, error: 'Endpoint Ads não permitido' }, { status: 403 });
    }

    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1);
    const account = accounts[0];
    if (!account) return Response.json({ ok: false, error: 'Conta Amazon não encontrada' }, { status: 404 });

    const token = await getAccessToken(account);
    const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID');
    if (!profileId) throw new Error('ADS_PROFILE_ID ausente');

    const url = `${adsBase(account.region)}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID') || '',
      'Amazon-Advertising-API-Scope': String(profileId),
      'Content-Type': body.content_type || 'application/json',
      Accept: body.accept || body.content_type || 'application/json',
    };

    const result = await callAmazonApi(url, method, headers, body.payload ?? null, Number(body.max_attempts || 3));

    // Log no SyncExecutionLog para auditoria
    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: account.id,
      operation: `amazon_api:${body.operation || `${method}:${path}`}`,
      status: result.ok ? 'success' : 'error',
      trigger_type: 'gateway',
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      records_processed: result.ok ? 1 : 0,
      error_message: result.ok ? null : String(result.errors?.[0]?.message || '').slice(0, 500),
    }).catch(() => {});

    return Response.json(result);
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || 'Erro no comando Amazon Ads' }, { status: 500 });
  }
});