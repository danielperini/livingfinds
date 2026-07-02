/**
 * getOAuthSetupInfo — Retorna info de configuração OAuth para diagnóstico.
 * Gera o URL de autorização Amazon Ads com base no ADS_CLIENT_ID configurado.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const isAuth = await base44.auth.isAuthenticated();
    if (!isAuth) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const clientId = Deno.env.get('ADS_CLIENT_ID') || '';
    const clientSecret = Deno.env.get('ADS_CLIENT_SECRET') || '';
    const refreshToken = Deno.env.get('ADS_REFRESH_TOKEN') || '';
    const profileId = Deno.env.get('ADS_PROFILE_ID') || '';
    const region = Deno.env.get('ADS_REGION') || 'NA';

    const redirectUri = 'https://livingfinds-app.base44.app/amazon-ads-callback';
    const scope = 'advertising::campaign_management';

    const authUrl = clientId
      ? `https://www.amazon.com/ap/oa?client_id=${clientId}&scope=${scope}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}`
      : null;

    // Testar token atual
    let tokenStatus = 'not_configured';
    let tokenError = null;
    let accessToken = null;

    if (refreshToken && clientId && clientSecret) {
      try {
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
        if (res.ok) {
          tokenStatus = 'valid';
          accessToken = data.access_token;
        } else {
          tokenStatus = 'invalid';
          tokenError = data.error_description || data.error || `HTTP ${res.status}`;
        }
      } catch (e) {
        tokenStatus = 'error';
        tokenError = e.message;
      }
    }

    // Testar profiles se token válido
    let profiles = [];
    let profilesError = null;
    if (accessToken) {
      try {
        const baseUrl = region.includes('EU')
          ? 'https://advertising-api-eu.amazon.com'
          : region.includes('FE')
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
      } catch (e) {
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
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});