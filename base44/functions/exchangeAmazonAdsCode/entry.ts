/**
 * exchangeAmazonAdsCode — Troca code OAuth por tokens e salva na entidade
 * Salva refresh_token, metadados de expiração e inicializa token manager.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const REDIRECT_URI = 'https://living-finds-flow.base44.app/amazon-ads-callback';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const { code, amazon_account_id } = body;
    if (!code) return Response.json({ error: 'code é obrigatório' }, { status: 400 });

    const clientId = Deno.env.get('ADS_CLIENT_ID');
    const clientSecret = Deno.env.get('ADS_CLIENT_SECRET');
    if (!clientId || !clientSecret) {
      return Response.json({ error: 'ADS_CLIENT_ID ou ADS_CLIENT_SECRET não configurados' }, { status: 500 });
    }

    // Trocar code por tokens
    const tokenRes = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });

    const tokenData = await tokenRes.json();
    if (!tokenRes.ok) {
      return Response.json({
        error: tokenData.error || 'token_error',
        error_description: tokenData.error_description || 'Falha ao trocar código por token',
        amazon_status: tokenRes.status,
      }, { status: 400 });
    }

    const refreshToken = tokenData.refresh_token;
    const accessToken = tokenData.access_token;
    const expiresIn = tokenData.expires_in || 3600;

    if (!refreshToken) {
      return Response.json({ error: 'refresh_token não retornado pela Amazon' }, { status: 400 });
    }

    // Buscar profiles
    let profiles: any[] = [];
    let profilesError: string | null = null;
    try {
      const profileRes = await fetch('https://advertising-api.amazon.com/v2/profiles', {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Amazon-Advertising-API-ClientId': clientId,
          'Content-Type': 'application/json',
        },
      });
      if (profileRes.ok) {
        profiles = await profileRes.json();
      } else {
        profilesError = `HTTP ${profileRes.status}`;
      }
    } catch (e: any) {
      profilesError = e.message;
    }

    // Metadados de token
    const now = new Date();
    const expiresAt = new Date(Date.now() + (expiresIn - 300) * 1000).toISOString();

    // Salvar na AmazonAccount
    let accountUpdated = false;
    let accountId = amazon_account_id;
    try {
      let accounts: any[] = [];
      if (accountId) {
        const acc = await base44.asServiceRole.entities.AmazonAccount.get(accountId).catch(() => null);
        if (acc) accounts = [acc];
      }
      if (!accounts.length) {
        accounts = await base44.asServiceRole.entities.AmazonAccount.list();
      }
      if (accounts.length > 0) {
        const acc = accounts[0];
        accountId = acc.id;
        await base44.asServiceRole.entities.AmazonAccount.update(acc.id, {
          ads_refresh_token: refreshToken,
          ads_refresh_token_created_at: now.toISOString(),
          ads_access_token_expires_at: expiresAt,
          ads_last_token_refresh_at: now.toISOString(),
          ads_token_status: 'active',
          ads_token_last_error: null,
          ads_requires_reauth: false,
          ads_token_refresh_in_progress: false,
          status: 'connected',
          error_message: null,
          last_sync_at: now.toISOString(),
        });
        accountUpdated = true;
      }
    } catch (e: any) {
      console.error('Erro ao salvar token na conta:', e.message);
    }

    const mask = (t: string) => t ? `${t.slice(0, 8)}...${t.slice(-4)}` : null;

    return Response.json({
      ok: true,
      message: 'Amazon Ads conectada com sucesso.',
      refresh_token_preview: mask(refreshToken),
      expires_in: expiresIn,
      token_status: 'active',
      profiles_count: profiles.length,
      profiles: profiles.map((p: any) => ({
        profileId: p.profileId,
        name: p.accountInfo?.name,
        marketplace: p.countryCode,
        type: p.accountInfo?.type,
        timezone: p.timezone,
      })),
      profiles_error: profilesError,
      account_updated: accountUpdated,
      account_id: accountId,
    });

  } catch (error: any) {
    return Response.json({ error: error.message || 'Erro interno' }, { status: 500 });
  }
});