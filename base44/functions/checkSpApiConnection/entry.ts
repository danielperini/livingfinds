import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { credentialDiagnostic, resolveAmazonSpCredentials } from '../../shared/amazonCredentials.ts';

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const authenticated = await base44.auth.isAuthenticated();
    if (!authenticated) return Response.json({ ok: false, status: 'unauthorized', error: 'Não autorizado' }, { status: 401 });

    const body = await request.json().catch(() => ({}));
    const credentials = resolveAmazonSpCredentials();
    const missing: string[] = [];
    if (!credentials.refreshToken.configured) missing.push('AMAZON_SP_REFRESH_TOKEN (ou alias legado SP_REFRESH_TOKEN)');
    if (!credentials.clientId.configured) missing.push('AMAZON_LWA_CLIENT_ID (ou alias legado SP_CLIENT_ID)');
    if (!credentials.clientSecret.configured) missing.push('AMAZON_LWA_CLIENT_SECRET (ou alias legado SP_CLIENT_SECRET)');

    if (missing.length) {
      return Response.json({ ok: false, status: 'not_configured', error: `Secrets ausentes: ${missing.join(', ')}`, missing });
    }

    const tokenResponse = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: credentials.refreshToken.value,
        client_id: credentials.clientId.value,
        client_secret: credentials.clientSecret.value,
      }).toString(),
    });
    const tokenData = await tokenResponse.json().catch(() => ({}));
    if (!tokenResponse.ok || !tokenData.access_token) {
      return Response.json({
        ok: false,
        status: 'auth_error',
        error: tokenData.error_description || tokenData.error || `Falha OAuth (${tokenResponse.status})`,
        configured_with: {
          refresh_token: credentialDiagnostic(credentials.refreshToken),
          client_id: credentialDiagnostic(credentials.clientId),
          client_secret: credentialDiagnostic(credentials.clientSecret),
        },
      });
    }

    let account: any = null;
    if (body.amazon_account_id) {
      account = await base44.asServiceRole.entities.AmazonAccount.get(body.amazon_account_id).catch(() => null);
    }

    return Response.json({
      ok: true,
      status: 'connected',
      message: 'SP-API OAuth configurada e token LWA emitido com sucesso.',
      marketplace_id: account?.marketplace_id || credentials.marketplaceId.value || null,
      configured_with: {
        refresh_token: credentialDiagnostic(credentials.refreshToken),
        client_id: credentialDiagnostic(credentials.clientId),
        client_secret: credentialDiagnostic(credentials.clientSecret),
      },
      expires_in: Number(tokenData.expires_in || 0),
    });
  } catch (error: any) {
    return Response.json({ ok: false, status: 'error', error: error?.message || 'Erro ao verificar SP-API' }, { status: 200 });
  }
});
