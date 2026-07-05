import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

// In-memory token cache (per-service)
const tokenCache = {};

async function fetchNewToken(clientId, clientSecret, refreshToken, service) {
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

async function getToken(service, base44Client = null, accountId = null) {
  const cached = tokenCache[service];
  if (cached && cached.expires_at > Date.now()) {
    return cached.access_token;
  }

  const isAds = service === 'ads';
  const clientId = isAds ? Deno.env.get('ADS_CLIENT_ID') : Deno.env.get('SP_CLIENT_ID');
  const clientSecret = isAds ? Deno.env.get('ADS_CLIENT_SECRET') : Deno.env.get('SP_CLIENT_SECRET');

  // Preferir token da entidade (fonte de verdade do OAuth) sobre o secret
  let refreshToken = isAds ? Deno.env.get('ADS_REFRESH_TOKEN') : Deno.env.get('SP_REFRESH_TOKEN');
  if (isAds && base44Client && accountId) {
    try {
      const accounts = await base44Client.asServiceRole.entities.AmazonAccount.filter({ id: accountId }, null, 1);
      const entityToken = accounts[0]?.ads_refresh_token;
      if (entityToken && entityToken.startsWith('Atzr|') && entityToken.length > 100) {
        refreshToken = entityToken;
      }
    } catch (_) {}
  }

  if (!clientId || !clientSecret || !refreshToken) {
    throw { code: 'missing_credentials', message: `Missing credentials for service: ${service}`, status: 400 };
  }

  return fetchNewToken(clientId, clientSecret, refreshToken, service);
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const service = body.token_type || body.service || 'ads'; // 'ads' or 'sp'
    const accountId = body.amazon_account_id || null;

    if (!['ads', 'sp'].includes(service)) {
      return Response.json({ error: 'Invalid service. Use ads or sp.' }, { status: 400 });
    }

    // Test-only: return health status, never the token itself
    const token = await getToken(service, base44, accountId);
    const cached = tokenCache[service];

    return Response.json({
      ok: true,
      service,
      status: 'active',
      expires_in: Math.floor((cached.expires_at - Date.now()) / 1000),
    });
  } catch (error) {
    const err = error || {};
    return Response.json({
      ok: false,
      error_code: err.code || 'unknown',
      message: err.message || 'Internal error',
    }, { status: err.status || 500 });
  }
});