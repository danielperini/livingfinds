/**
 * getLWAAccessToken — Ponte compatível com funções legadas
 *
 * Para chamadas com amazon_account_id: delega ao amazonAdsTokenManager (renovação automática).
 * Para chamadas sem account_id: usa credenciais dos Secrets (fallback legado).
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

// Cache em memória para fallback legado (secrets)
const legacyCache: Map<string, { access_token: string; expires_at: number }> = new Map();

async function fetchTokenFromSecrets(service: 'ads' | 'sp'): Promise<string> {
  const cacheKey = `legacy_${service}`;
  const cached = legacyCache.get(cacheKey);
  if (cached && cached.expires_at > Date.now()) return cached.access_token;

  const clientId = service === 'ads'
    ? (Deno.env.get('ADS_CLIENT_ID') || Deno.env.get('AMAZON_LWA_CLIENT_ID') || '')
    : (Deno.env.get('SP_CLIENT_ID') || Deno.env.get('AMAZON_LWA_CLIENT_ID') || '');
  const clientSecret = service === 'ads'
    ? (Deno.env.get('ADS_CLIENT_SECRET') || Deno.env.get('AMAZON_LWA_CLIENT_SECRET') || '')
    : (Deno.env.get('SP_CLIENT_SECRET') || Deno.env.get('AMAZON_LWA_CLIENT_SECRET') || '');
  const refreshToken = service === 'ads'
    ? (Deno.env.get('ADS_REFRESH_TOKEN') || '')
    : (Deno.env.get('SP_REFRESH_TOKEN') || Deno.env.get('AMAZON_SP_REFRESH_TOKEN') || '');

  if (!clientId || !clientSecret || !refreshToken) {
    throw { code: 'missing_credentials', message: `Credenciais ${service} ausentes nos Secrets`, status: 400 };
  }

  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    const isInvalidGrant = data.error === 'invalid_grant' || data.error === 'unauthorized_client';
    throw { code: data.error || 'token_error', message: data.error_description || `HTTP ${res.status}`, status: res.status, needs_reauth: isInvalidGrant };
  }

  const expiresAt = Date.now() + ((data.expires_in || 3600) - 60) * 1000;
  legacyCache.set(cacheKey, { access_token: data.access_token, expires_at: expiresAt });
  return data.access_token;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    const isServiceRole = body._service_role === true;
    if (!isServiceRole) {
      const user = await base44.auth.me().catch(() => null);
      if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const service = String(body.token_type || body.service || 'ads').toLowerCase() as 'ads' | 'sp';
    const accountId = body.amazon_account_id || null;

    if (!['ads', 'sp'].includes(service)) {
      return Response.json({ error: 'service deve ser ads ou sp' }, { status: 400 });
    }

    // ── Caminho preferencial: delegar ao manager (com renovação automática) ──
    if (service === 'ads' && accountId) {
      const res = await base44.asServiceRole.functions.invoke('amazonAdsTokenManager', {
        amazon_account_id: accountId,
        force_refresh: body.force_refresh || false,
        _service_role: true,
      });
      const d = res?.data || res || {};
      return Response.json({
        ok: d.ok,
        service,
        status: d.ok ? 'active' : 'error',
        ...(isServiceRole && d.ok ? { access_token: d.access_token } : {}),
        expires_at: d.expires_at,
        from_cache: d.from_cache,
        error_type: d.error_type,
        requires_reauthorization: d.requires_reauthorization,
        message: d.message,
      });
    }

    // ── Fallback legado: usar Secrets ─────────────────────────────────────────
    const token = await fetchTokenFromSecrets(service);
    const cached = legacyCache.get(`legacy_${service}`);
    return Response.json({
      ok: true,
      service,
      status: 'active',
      ...(isServiceRole ? { access_token: token } : {}),
      expires_in: cached ? Math.floor((cached.expires_at - Date.now()) / 1000) : null,
      source: 'legacy_secrets',
    });

  } catch (error: any) {
    return Response.json({
      ok: false,
      error_code: error.code || 'unknown',
      error: error.message || 'Internal error',
      needs_reauth: error.needs_reauth === true,
    }, { status: error.status || 500 });
  }
});