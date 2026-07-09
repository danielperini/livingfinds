import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

// In-memory token cache (per-service)
const tokenCache: Record<string, { access_token: string; expires_at: number }> = {};

// Resolve credentials com fallback para variáveis legadas
function resolveCredentials(service: string) {
  const isAds = service === 'ads';

  if (isAds) {
    const clientId     = Deno.env.get('ADS_CLIENT_ID')     || Deno.env.get('AMAZON_LWA_CLIENT_ID')     || '';
    const clientSecret = Deno.env.get('ADS_CLIENT_SECRET') || Deno.env.get('AMAZON_LWA_CLIENT_SECRET') || '';
    const refreshToken = Deno.env.get('ADS_REFRESH_TOKEN') || '';
    return { clientId, clientSecret, refreshToken };
  } else {
    // SP-API
    const clientId     = Deno.env.get('SP_CLIENT_ID')     || Deno.env.get('AMAZON_LWA_CLIENT_ID')     || '';
    const clientSecret = Deno.env.get('SP_CLIENT_SECRET') || Deno.env.get('AMAZON_LWA_CLIENT_SECRET') || '';
    const refreshToken = Deno.env.get('SP_REFRESH_TOKEN') || Deno.env.get('AMAZON_SP_REFRESH_TOKEN')  || '';
    return { clientId, clientSecret, refreshToken };
  }
}

async function fetchNewToken(clientId: string, clientSecret: string, refreshToken: string, service: string): Promise<string> {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });

  let attempt = 0;
  const maxAttempts = 3;

  while (attempt < maxAttempts) {
    attempt++;
    const res = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (res.status === 429 || res.status >= 500) {
      const delay = Math.pow(2, attempt) * 500;
      await new Promise(r => setTimeout(r, delay));
      continue;
    }

    const data = await res.json();
    if (!res.ok) {
      throw { code: data.error || 'token_error', message: data.error_description || 'Token fetch failed', status: res.status };
    }

    // Cache: expires_in - 60s buffer
    const expiresAt = Date.now() + (data.expires_in - 60) * 1000;
    tokenCache[service] = { access_token: data.access_token, expires_at: expiresAt };
    return data.access_token;
  }

  throw { code: 'max_retries', message: 'Max retry attempts reached', status: 503 };
}

async function getToken(service: string, base44Client: any = null, accountId: string | null = null): Promise<string> {
  const cached = tokenCache[service];
  if (cached && cached.expires_at > Date.now()) {
    return cached.access_token;
  }

  const { clientId, clientSecret } = resolveCredentials(service);

  // Para Ads: preferir token da entidade (fonte de verdade do OAuth) sobre o secret
  let { refreshToken } = resolveCredentials(service);
  if (service === 'ads' && base44Client && accountId) {
    try {
      const accounts = await base44Client.asServiceRole.entities.AmazonAccount.filter({ id: accountId }, null, 1);
      const entityToken = accounts[0]?.ads_refresh_token;
      if (entityToken && entityToken.startsWith('Atzr|') && entityToken.length > 100) {
        refreshToken = entityToken;
      }
    } catch (_) {}
  }

  if (!clientId || !clientSecret || !refreshToken) {
    const missing = [
      !clientId     && `CLIENT_ID (${service === 'ads' ? 'ADS_CLIENT_ID' : 'SP_CLIENT_ID'})`,
      !clientSecret && `CLIENT_SECRET (${service === 'ads' ? 'ADS_CLIENT_SECRET' : 'SP_CLIENT_SECRET'})`,
      !refreshToken && `REFRESH_TOKEN (${service === 'ads' ? 'ADS_REFRESH_TOKEN' : 'SP_REFRESH_TOKEN'})`,
    ].filter(Boolean).join(', ');
    throw { code: 'missing_credentials', message: `Missing credentials for ${service}: ${missing}`, status: 400 };
  }

  return fetchNewToken(clientId, clientSecret, refreshToken, service);
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    const isServiceRole = body._service_role === true;
    if (!isServiceRole) {
      const user = await base44.auth.me();
      if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const service = String(body.token_type || body.service || 'ads').toLowerCase();
    const accountId = body.amazon_account_id || null;

    if (!['ads', 'sp'].includes(service)) {
      return Response.json({ error: 'Invalid service. Use ads or sp.' }, { status: 400 });
    }

    const token = await getToken(service, base44, accountId);
    const cached = tokenCache[service];

    return Response.json({
      ok: true,
      service,
      status: 'active',
      ...(isServiceRole ? { access_token: token } : {}),
      expires_in: cached ? Math.floor((cached.expires_at - Date.now()) / 1000) : null,
    });
  } catch (error: any) {
    const err = error || {};
    return Response.json({
      ok: false,
      error_code: err.code || 'unknown',
      error: err.message || 'Internal error',
      message: err.message || 'Internal error',
    }, { status: err.status || 500 });
  }
});