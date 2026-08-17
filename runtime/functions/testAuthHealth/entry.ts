/**
 * testAuthHealth — verifica se os tokens Amazon estão funcionando
 *
 * IMPORTANTE: Usa o refresh token salvo no banco (AmazonAccount.ads_refresh_token)
 * como fonte primária — NÃO depende exclusivamente das env vars estáticas,
 * que podem estar desatualizadas após renovação OAuth.
 *
 * Fallback: se não houver conta no banco, usa ADS_REFRESH_TOKEN do env.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

async function fetchToken(clientId: string, clientSecret: string, refreshToken: string): Promise<{ ok: boolean; access_token?: string; expires_in?: number; error?: string; error_code?: string }> {
  if (!clientId || !clientSecret || !refreshToken) {
    return { ok: false, error: 'Credenciais incompletas', error_code: 'not_configured' };
  }
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const data = await res.json();
  if (!res.ok) {
    const code = data.error || `http_${res.status}`;
    let hint = data.error_description || 'Token fetch failed';
    if (code === 'unauthorized_client') hint = 'Refresh token revogado — reautorize em /amazon-oauth-setup';
    if (code === 'invalid_client')      hint = 'Client ID ou Client Secret incorretos — verifique as variáveis de ambiente';
    if (code === 'invalid_grant')       hint = 'Refresh token expirado ou inválido — gere um novo token';
    return { ok: false, error: hint, error_code: code };
  }
  return { ok: true, access_token: data.access_token, expires_in: data.expires_in };
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const mode = Deno.env.get('OPERATION_MODE') || 'mock';
    if (mode === 'mock') {
      return Response.json({
        ok: true, mode,
        services: {
          ads: { ok: true, service: 'ads', status: 'mock', expires_in: 3600 },
          sp:  { ok: true, service: 'sp',  status: 'mock', expires_in: 3600 },
        }
      });
    }

    // Buscar conta do banco — token real (pós-OAuth) tem prioridade sobre env var
    const accounts = await base44.asServiceRole.entities.AmazonAccount.list('-updated_date', 1).catch(() => [] as any[]);
    const account = accounts[0];

    // ── Ads: usa token do banco se disponível, fallback para env ──
    const adsRefreshToken = account?.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN') || '';
    const adsClientId     = Deno.env.get('ADS_CLIENT_ID') || Deno.env.get('AMAZON_LWA_CLIENT_ID') || '';
    const adsClientSecret = Deno.env.get('ADS_CLIENT_SECRET') || Deno.env.get('AMAZON_LWA_CLIENT_SECRET') || '';

    // ── SP-API: usa env vars (SP-API não tem token no banco da mesma forma) ──
    const spRefreshToken  = Deno.env.get('SP_REFRESH_TOKEN') || Deno.env.get('AMAZON_SP_REFRESH_TOKEN') || '';
    const spClientId      = Deno.env.get('SP_CLIENT_ID') || Deno.env.get('AMAZON_LWA_CLIENT_ID') || '';
    const spClientSecret  = Deno.env.get('SP_CLIENT_SECRET') || Deno.env.get('AMAZON_LWA_CLIENT_SECRET') || '';

    const [adsResult, spResult] = await Promise.allSettled([
      fetchToken(adsClientId, adsClientSecret, adsRefreshToken),
      fetchToken(spClientId, spClientSecret, spRefreshToken),
    ]);

    const ads = adsResult.status === 'fulfilled' ? adsResult.value : { ok: false, error: (adsResult as PromiseRejectedResult).reason?.message, error_code: 'exception' };
    const sp  = spResult.status  === 'fulfilled' ? spResult.value  : { ok: false, error: (spResult  as PromiseRejectedResult).reason?.message, error_code: 'exception' };

    // Atualizar status da conta no banco baseado no resultado real
    if (account) {
      const tokenStatus = ads.ok ? 'active' : (ads.error_code === 'unauthorized_client' ? 'revoked' : 'error');
      await base44.asServiceRole.entities.AmazonAccount.update(account.id, {
        ads_token_status: tokenStatus,
        ads_last_verified_at: new Date().toISOString(),
        ...(ads.error_code ? { ads_token_last_error: ads.error } : {}),
      }).catch(() => {});
    }

    return Response.json({
      ok: true,
      mode,
      token_source: account?.ads_refresh_token ? 'database' : 'env_var',
      account_id: account?.id || null,
      services: {
        ads: { ok: ads.ok, service: 'ads', status: ads.ok ? 'active' : 'error', error_code: ads.error_code, message: ads.error, expires_in: ads.expires_in },
        sp:  { ok: sp.ok,  service: 'sp',  status: sp.ok  ? 'active' : 'error', error_code: sp.error_code,  message: sp.error,  expires_in: sp.expires_in },
      }
    });

  } catch (error: any) {
    return Response.json({ ok: false, message: error.message || 'Health check failed' }, { status: 500 });
  }
});