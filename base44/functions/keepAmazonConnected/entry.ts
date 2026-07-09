/**
 * keepAmazonConnected — Verifica validade do token Amazon Ads.
 * Roda 1x/dia. Se o token for inválido (unauthorized_client/invalid_grant),
 * marca a conta com needs_reauth=true e status='error' para o frontend detectar.
 * Não chama API externa quando skip_api_check=true (padrão da automação diária).
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

async function tryGetAccessToken(refreshToken: string): Promise<{ ok: boolean; token?: string; error?: string; error_code?: string; needs_reauth?: boolean }> {
  const clientId     = Deno.env.get('ADS_CLIENT_ID')     || Deno.env.get('AMAZON_LWA_CLIENT_ID')     || '';
  const clientSecret = Deno.env.get('ADS_CLIENT_SECRET') || Deno.env.get('AMAZON_LWA_CLIENT_SECRET') || '';
  if (!refreshToken || !clientId || !clientSecret) {
    return { ok: false, error: 'Credenciais incompletas', error_code: 'missing_credentials' };
  }
  try {
    const response = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.access_token) {
      const code = data.error || `http_${response.status}`;
      const needsReauth = code === 'unauthorized_client' || code === 'invalid_grant';
      return { ok: false, error: data.error_description || data.error || `HTTP ${response.status}`, error_code: code, needs_reauth: needsReauth };
    }
    return { ok: true, token: data.access_token };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'Erro de rede', error_code: 'network_error' };
  }
}

Deno.serve(async (request) => {
  const startedAt = new Date().toISOString();
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    if (!body._service_role) {
      const user = await base44.auth.me().catch(() => null);
      if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    // Por padrão valida via API (para detectar token revogado); skip_api_check=true apenas para sync local
    const skipApiCheck = body.skip_api_check === true;
    const accounts = await base44.asServiceRole.entities.AmazonAccount.list();
    if (!accounts.length) return Response.json({ ok: false, error: 'Nenhuma conta Amazon cadastrada' });

    const results: any[] = [];

    for (const account of accounts) {
      const aid = account.id;
      const secretToken  = (Deno.env.get('ADS_REFRESH_TOKEN') || '').trim();
      const entityToken  = (account.ads_refresh_token || '').trim();
      const refreshToken = secretToken || entityToken;

      if (!refreshToken) {
        await base44.asServiceRole.entities.AmazonAccount.update(aid, {
          status: 'error',
          error_message: 'ADS_REFRESH_TOKEN não configurado.',
        }).catch(() => {});
        results.push({ account_id: aid, status: 'error', error: 'refresh_token ausente' });
        continue;
      }

      // Sincronizar token secret → entidade
      if (secretToken && secretToken !== entityToken) {
        await base44.asServiceRole.entities.AmazonAccount.update(aid, {
          ads_refresh_token: secretToken,
        }).catch(() => {});
      }

      if (!skipApiCheck) {
        const tokenResult = await tryGetAccessToken(refreshToken);
        if (!tokenResult.ok) {
          const msg = tokenResult.needs_reauth
            ? `Token revogado (${tokenResult.error_code}): reautorize em /amazon-oauth-setup`
            : `Token inválido: ${tokenResult.error}`;
          await base44.asServiceRole.entities.AmazonAccount.update(aid, {
            status: 'error',
            error_message: msg,
          }).catch(() => {});
          results.push({ account_id: aid, status: 'error', error: tokenResult.error, error_code: tokenResult.error_code, needs_reauth: tokenResult.needs_reauth });
          continue;
        }
        // Token válido — limpar erro anterior
        await base44.asServiceRole.entities.AmazonAccount.update(aid, {
          status: 'connected',
          error_message: null,
        }).catch(() => {});
      } else if (account.status !== 'connected') {
        await base44.asServiceRole.entities.AmazonAccount.update(aid, {
          status: 'connected',
          error_message: null,
        }).catch(() => {});
      }

      results.push({
        account_id: aid,
        status: 'connected',
        token_synced: secretToken !== entityToken,
        validated_api: !skipApiCheck,
      });
    }

    return Response.json({
      ok: results.every(r => r.status === 'connected'),
      checked_at: startedAt,
      accounts: results,
      needs_reauth: results.some(r => r.needs_reauth === true),
      summary: `${results.filter(r => r.status === 'connected').length}/${results.length} contas sincronizadas`,
    });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || 'Erro no sync local' }, { status: 500 });
  }
});