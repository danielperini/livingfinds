/**
 * getLWAAccessToken — rota de compatibilidade sem exposição de token.
 *
 * Mantém /functions/getLWAAccessToken existente, mas retorna somente estado,
 * expiração e erros. Nenhum access/refresh token entra no Response JSON.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import {
  ADS_TOKEN_REVOKED_REAUTH_REQUIRED,
  resolveAmazonAdsCredentials,
  resolveAmazonSpCredentials,
} from '../../shared/amazonCredentials.ts';

const validationCache: Map<string, { expires_at: number }> = new Map();

async function validateTokenFromCredentials(service: 'ads' | 'sp') {
  const cacheKey = `legacy_${service}`;
  const cached = validationCache.get(cacheKey);
  if (cached && cached.expires_at > Date.now()) {
    return { ok: true, token_available: true, expires_at: cached.expires_at, from_cache: true };
  }

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

  // O access token existe apenas nesta stack frame e é descartado sem log/retorno.
  const expiresAt = Date.now() + (Math.max(120, Number(data.expires_in || 3600) - 60) * 1000);
  validationCache.set(cacheKey, { expires_at: expiresAt });
  return { ok: true, token_available: true, expires_at: expiresAt, from_cache: false };
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    if (body._service_role !== true) {
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
      const reauthRequired = data.requires_reauthorization === true || data.error_type === ADS_TOKEN_REVOKED_REAUTH_REQUIRED;
      return Response.json({
        ok: data.ok === true,
        service,
        status: data.ok ? 'active' : 'error',
        token_available: data.token_available === true,
        expires_at: data.expires_at,
        from_cache: data.from_cache,
        error_type: reauthRequired ? ADS_TOKEN_REVOKED_REAUTH_REQUIRED : data.error_type,
        amazon_error_code: data.amazon_error_code,
        requires_reauthorization: reauthRequired,
        message: data.message,
      }, { status: reauthRequired ? 401 : 200 });
    }

    const state = await validateTokenFromCredentials(service);
    return Response.json({
      ok: true,
      service,
      status: 'active',
      token_available: state.token_available,
      expires_at: state.expires_at,
      from_cache: state.from_cache,
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
