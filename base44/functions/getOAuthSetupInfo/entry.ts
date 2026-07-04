/**
 * getOAuthSetupInfo — Diagnóstico e validação do token LWA Amazon Ads.
 * Lê o refresh token da entidade AmazonAccount (fonte primária)
 * e faz fallback para o secret ADS_REFRESH_TOKEN.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const isAuth = await base44.auth.isAuthenticated();
    if (!isAuth) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const clientId = (Deno.env.get('ADS_CLIENT_ID') || '').trim();
    const clientSecret = (Deno.env.get('ADS_CLIENT_SECRET') || '').trim();
    const secretRefreshToken = (Deno.env.get('ADS_REFRESH_TOKEN') || '').trim();
    const profileId = (Deno.env.get('ADS_PROFILE_ID') || '').trim();
    const region = (Deno.env.get('ADS_REGION') || 'NA').trim();

    // Lê o refresh token da entidade (fonte primária após OAuth)
    let entityRefreshToken: string | null = null;
    let accountId: string | null = null;
    let accountStatus: string | null = null;
    try {
      const user = await base44.auth.me();
      const accounts = await base44.entities.AmazonAccount.filter({ user_id: user.id });
      const acc = accounts[0];
      if (acc) {
        entityRefreshToken = (acc.ads_refresh_token || '').trim() || null;
        accountId = acc.id;
        accountStatus = acc.status || null;
      }
    } catch (_) { /* ignora */ }

    // Decide qual token usar (entidade tem prioridade)
    const refreshToken = entityRefreshToken || secretRefreshToken;
    const tokenSource = entityRefreshToken ? 'entity' : (secretRefreshToken ? 'secret' : null);

    const redirectUri = 'https://living-finds-flow.base44.app/amazon-ads-callback';
    const scope = 'advertising::campaign_management';
    const authUrl = clientId
      ? `https://www.amazon.com/ap/oa?client_id=${encodeURIComponent(clientId)}&scope=${encodeURIComponent(scope)}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}`
      : null;

    // Testa o token atual
    let tokenStatus = 'not_configured';
    let tokenError: string | null = null;
    let accessToken: string | null = null;

    if (refreshToken && clientId && clientSecret) {
      try {
        const res = await fetch('https://api.amazon.com/auth/o2/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: clientId,
            client_secret: clientSecret,
          }).toString(),
        });
        const data = await res.json();
        if (res.ok) {
          tokenStatus = 'valid';
          accessToken = data.access_token;
        } else {
          tokenStatus = 'invalid';
          tokenError = data.error_description || data.error || `HTTP ${res.status}`;
        }
      } catch (e: any) {
        tokenStatus = 'error';
        tokenError = e.message;
      }
    } else if (!clientId || !clientSecret) {
      tokenStatus = 'not_configured';
      tokenError = !clientId ? 'ADS_CLIENT_ID não configurado' : 'ADS_CLIENT_SECRET não configurado';
    }

    // Busca profiles se token válido
    let profiles: any[] = [];
    let profilesError: string | null = null;
    if (accessToken) {
      try {
        const baseUrl = region.toUpperCase().includes('EU')
          ? 'https://advertising-api-eu.amazon.com'
          : region.toUpperCase().includes('FE')
          ? 'https://advertising-api-fe.amazon.com'
          : 'https://advertising-api.amazon.com';

        const r = await fetch(`${baseUrl}/v2/profiles`, {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Amazon-Advertising-API-ClientId': clientId,
          },
        });
        if (r.ok) {
          profiles = await r.json();
        } else {
          const t = await r.text();
          profilesError = `HTTP ${r.status}: ${t.slice(0, 300)}`;
        }
      } catch (e: any) {
        profilesError = e.message;
      }
    }

    return Response.json({
      ok: true,
      config: {
        client_id_preview: clientId ? `${clientId.slice(0, 12)}...${clientId.slice(-4)}` : null,
        client_secret_set: !!clientSecret,
        refresh_token_preview: refreshToken ? `${refreshToken.slice(0, 8)}...${refreshToken.slice(-4)}` : null,
        profile_id: profileId,
        region,
        redirect_uri: redirectUri,
        token_source: tokenSource,
        account_id: accountId,
        account_status: accountStatus,
        has_entity_token: !!entityRefreshToken,
        has_secret_token: !!secretRefreshToken,
      },
      token_status: tokenStatus,
      token_error: tokenError,
      auth_url: authUrl,
      profiles: profiles.map((p) => ({
        profileId: p.profileId,
        name: p.accountInfo?.name,
        marketplace: p.countryCode,
        type: p.accountInfo?.type,
      })),
      profiles_error: profilesError,
    });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});