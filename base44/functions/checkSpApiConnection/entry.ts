import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function getSecretStatus() {
  const refreshToken = Deno.env.get('AMAZON_SP_REFRESH_TOKEN') || Deno.env.get('SP_REFRESH_TOKEN');
  const clientId = Deno.env.get('AMAZON_LWA_CLIENT_ID') || Deno.env.get('SP_CLIENT_ID');
  const clientSecret = Deno.env.get('AMAZON_LWA_CLIENT_SECRET') || Deno.env.get('SP_CLIENT_SECRET');
  return {
    refreshToken,
    clientId,
    clientSecret,
    refreshTokenName: Deno.env.get('AMAZON_SP_REFRESH_TOKEN') ? 'AMAZON_SP_REFRESH_TOKEN' : Deno.env.get('SP_REFRESH_TOKEN') ? 'SP_REFRESH_TOKEN' : null,
    clientIdName: Deno.env.get('AMAZON_LWA_CLIENT_ID') ? 'AMAZON_LWA_CLIENT_ID' : Deno.env.get('SP_CLIENT_ID') ? 'SP_CLIENT_ID' : null,
    clientSecretName: Deno.env.get('AMAZON_LWA_CLIENT_SECRET') ? 'AMAZON_LWA_CLIENT_SECRET' : Deno.env.get('SP_CLIENT_SECRET') ? 'SP_CLIENT_SECRET' : null,
  };
}

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const authenticated = await base44.auth.isAuthenticated();
    if (!authenticated) return Response.json({ ok: false, status: 'unauthorized', error: 'Não autorizado' }, { status: 401 });

    const body = await request.json().catch(() => ({}));
    const secrets = getSecretStatus();
    const missing = [];
    if (!secrets.refreshToken) missing.push('SP_REFRESH_TOKEN ou AMAZON_SP_REFRESH_TOKEN');
    if (!secrets.clientId) missing.push('SP_CLIENT_ID ou AMAZON_LWA_CLIENT_ID');
    if (!secrets.clientSecret) missing.push('SP_CLIENT_SECRET ou AMAZON_LWA_CLIENT_SECRET');

    if (missing.length) {
      return Response.json({
        ok: false,
        status: 'not_configured',
        error: `Secrets ausentes: ${missing.join(', ')}`,
        missing,
      });
    }

    const tokenResponse = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: secrets.refreshToken,
        client_id: secrets.clientId,
        client_secret: secrets.clientSecret,
      }).toString(),
    });

    const tokenData = await tokenResponse.json().catch(() => ({}));
    if (!tokenResponse.ok || !tokenData.access_token) {
      return Response.json({
        ok: false,
        status: 'auth_error',
        error: tokenData.error_description || tokenData.error || `Falha OAuth (${tokenResponse.status})`,
        configured_with: {
          refresh_token: secrets.refreshTokenName,
          client_id: secrets.clientIdName,
          client_secret: secrets.clientSecretName,
        },
      });
    }

    let account = null;
    if (body.amazon_account_id) {
      account = await base44.asServiceRole.entities.AmazonAccount.get(body.amazon_account_id).catch(() => null);
    }

    return Response.json({
      ok: true,
      status: 'connected',
      message: 'SP-API OAuth configurada e token LWA emitido com sucesso.',
      marketplace_id: account?.marketplace_id || Deno.env.get('AMAZON_MARKETPLACE_ID') || null,
      configured_with: {
        refresh_token: secrets.refreshTokenName,
        client_id: secrets.clientIdName,
        client_secret: secrets.clientSecretName,
      },
      expires_in: Number(tokenData.expires_in || 0),
    });
  } catch (error) {
    return Response.json({
      ok: false,
      status: 'error',
      error: error?.message || 'Erro ao verificar SP-API',
    }, { status: 200 });
  }
});
