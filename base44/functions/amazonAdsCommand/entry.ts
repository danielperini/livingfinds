import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

let tokenCache: { value: string; expiresAt: number; key: string } | null = null;

const ALLOWED_PATHS = [
  '/sp/campaigns', '/sp/campaigns/list',
  '/sp/adGroups', '/sp/adGroups/list',
  '/sp/productAds', '/sp/productAds/list',
  '/sp/keywords', '/sp/keywords/list',
  '/v2/sp/campaigns', '/v2/sp/adGroups', '/v2/sp/keywords', '/v2/sp/negativeKeywords',
  '/sp/negativeKeywords', '/sp/negativeKeywords/list',
  '/sp/targets', '/sp/targets/list', '/v2/sp/targets',
];
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE']);

function adsBase(region?: string) {
  const value = String(region || Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
  if (value.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (value.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function accessToken(refreshToken?: string) {
  const refresh = refreshToken || Deno.env.get('ADS_REFRESH_TOKEN') || '';
  const clientId = Deno.env.get('ADS_CLIENT_ID') || '';
  const secret = Deno.env.get('ADS_CLIENT_SECRET') || '';
  const cacheKey = `${refresh.slice(-12)}:${clientId}`;
  if (tokenCache?.key === cacheKey && tokenCache.expiresAt > Date.now()) return tokenCache.value;
  if (!refresh || !clientId || !secret) throw new Error('Credenciais Amazon Ads incompletas');

  const response = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId, client_secret: secret }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) throw new Error(data.error_description || data.error || 'Falha no token Amazon Ads');
  tokenCache = { value: data.access_token, expiresAt: Date.now() + (Number(data.expires_in || 3600) - 60) * 1000, key: cacheKey };
  return tokenCache.value;
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
    if (!ALLOWED_PATHS.some((allowed) => path === allowed || path.startsWith(`${allowed}?`))) {
      return Response.json({ ok: false, error: 'Endpoint Ads não permitido' }, { status: 403 });
    }

    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1);
    const account = accounts[0];
    if (!account) return Response.json({ ok: false, error: 'Conta Amazon não encontrada' }, { status: 404 });

    const token = await accessToken(account.ads_refresh_token);
    const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID');
    if (!profileId) throw new Error('ADS_PROFILE_ID ausente');

    const response = await base44.asServiceRole.functions.invoke('amazonApiGateway', {
      amazon_account_id: account.id,
      api_family: 'ADS',
      operation: body.operation || `${method}:${path}`,
      endpoint: `${adsBase(account.region)}${path}`,
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID') || '',
        'Amazon-Advertising-API-Scope': String(profileId),
        'Content-Type': body.content_type || 'application/json',
        Accept: body.accept || body.content_type || 'application/json',
      },
      payload: body.payload ?? null,
      queue_type: body.queue_type || 'WRITE',
      max_attempts: Math.max(1, Math.min(Number(body.max_attempts || 5), 5)),
      timeout_ms: Math.max(5000, Number(body.timeout_ms || 30000)),
      _service_role: true,
    });

    return Response.json(response?.data || response || {});
  } catch (error) {
    return Response.json({ ok: false, error: error?.message || 'Erro no comando Amazon Ads' }, { status: 500 });
  }
});
