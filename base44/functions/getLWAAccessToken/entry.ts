/**
 * getLWAAccessToken — ponte compatível com funções legadas.
 * Ads com amazon_account_id delega ao amazonAdsTokenManager.
 * Fallback legado usa apenas o resolvedor canônico de credenciais.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import {
  ADS_TOKEN_REVOKED_REAUTH_REQUIRED,
  resolveAmazonAdsCredentials,
  resolveAmazonSpCredentials,
} from '../../shared/amazonCredentials.ts';

const legacyCache: Map<string, { access_token: string; expires_at: number }> = new Map();

async function fetchTokenFromCredentials(service: 'ads' | 'sp'): Promise<string> {
  const cacheKey = `legacy_${service}`;
  const cached = legacyCache.get(cacheKey);
  if (cached && cached.expires_at > Date.now()) return cached.access_token;

  const credentials = service === 'ads' ? resolveAmazonAdsCredentials() : resolveAmazonSpCredentials();
  const clientId = credentials.clientId.value;
  const clientSecret = credentials.clientSecret.value;
  const refreshToken = credentials.refreshToken.value;

  if (!clientId || !clientSecret || !refreshToken) {
    throw { code: 'missing_credentials', message: `Credenciais ${service} ausentes na fonte canônica`, status: 400 };
  }

  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.access_token) {
    const needsReauth = ['invalid_grant', 'unauthorized_client', 'access_denied'].includes(String(data?.error || ''));
    throw {
      code: needsReauth && service === 'ads' ? ADS_TOKEN_REVOKED_REAUTH_REQUIRED : (data?.error || 'token_error'),
      amazon_error_code: data?.error || null,
      message: data?.error_description || `Amazon LWA HTTP ${res.status}`,
      status: res.status,
      needs_reauth: needsReauth,
    };
  }

  const expiresAt = Date.now() + (Math.max(120, Number(data.expires_in || 3600) - 60) * 1000);
  legacyCache.set(cacheKey, { access_token: String(data.access_token), expires_at: expiresAt });
  return String(data.access_token);
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
    if (!['ads', 'sp'].includes(service)) return Response.json({ error: 'service deve ser ads ou sp' }, { status: 400 });

    if (service === 'ads' && accountId) {
      const response = await base44.asServiceRole.functions.invoke('amazonAdsTokenManager', {
        amazon_account_id: accountId,
        force_refresh: body.force_refresh === true,
        _service_role: true,
      });
      const data = response?.data || response || {};
      const reauthRequired = data.requires_reauthorization === true;
      return Response.json({
        ok: data.ok === true,
        service,
        status: data.ok ? 'active' : 'error',
        // Access token só transita entre funções internas de service-role; nunca para frontend.
        ...(isServiceRole && data.ok ? { access_token: data.access_token } : {}),
        expires_at: data.expires_at,
        from_cache: data.from_cache,
        error_type: reauthRequired ? ADS_TOKEN_REVOKED_REAUTH_REQUIRED : data.error_type,
        amazon_error_code: data.amazon_error_code,
        requires_reauthorization: reauthRequired,
        message: data.message,
      }, { status: reauthRequired ? 401 : 200 });
    }

    const token = await fetchTokenFromCredentials(service);
    const cached = legacyCache.get(`legacy_${service}`);
    return Response.json({
      ok: true,
      service,
      status: 'active',
      ...(isServiceRole ? { access_token: token } : {}),
      expires_in: cached ? Math.floor((cached.expires_at - Date.now()) / 1000) : null,
      source: 'canonical_credentials',
    });
  } catch (error: any) {
    return Response.json({
      ok: false,
      error_code: error?.code || 'unknown',
      amazon_error_code: error?.amazon_error_code || null,
      error: error?.message || 'Internal error',
      needs_reauth: error?.needs_reauth === true,
    }, { status: error?.status || 500 });
  }
});
