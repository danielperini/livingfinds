import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const REDIRECT_URI = 'https://living-finds-flow.base44.app/amazon-ads-callback';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { code, amazon_account_id } = body;
    if (!code) return Response.json({ error: 'code é obrigatório' }, { status: 400 });

    const clientId = Deno.env.get('ADS_CLIENT_ID');
    const clientSecret = Deno.env.get('ADS_CLIENT_SECRET');
    if (!clientId || !clientSecret) {
      return Response.json({ error: 'ADS_CLIENT_ID ou ADS_CLIENT_SECRET não configurados' }, { status: 500 });
    }

    // Trocar code por tokens
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      client_secret: clientSecret,
    });

    const tokenRes = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    const tokenData = await tokenRes.json();

    if (!tokenRes.ok) {
      return Response.json({
        error: tokenData.error_description || tokenData.error || 'Falha ao trocar código por token',
      }, { status: 400 });
    }

    const refreshToken = tokenData.refresh_token;
    const accessToken = tokenData.access_token;

    if (!refreshToken) {
      return Response.json({ error: 'refresh_token não retornado pela Amazon' }, { status: 400 });
    }

    // Buscar profiles para confirmar autenticação
    let profiles = [];
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
      }
    } catch (_) { /* profiles opcionais */ }

    // Salvar refresh_token na AmazonAccount
    let accountUpdated = false;
    try {
      let accounts = [];
      if (amazon_account_id) {
        const acc = await base44.asServiceRole.entities.AmazonAccount.get(amazon_account_id);
        if (acc) accounts = [acc];
      }
      if (!accounts.length) {
        accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ user_id: user.id });
      }
      if (!accounts.length) {
        accounts = await base44.asServiceRole.entities.AmazonAccount.list();
      }

      if (accounts.length > 0) {
        const acc = accounts[0];
        await base44.asServiceRole.entities.AmazonAccount.update(acc.id, {
          ads_refresh_token: refreshToken,
          status: 'connected',
          error_message: null,
          last_sync_at: new Date().toISOString(),
        });
        accountUpdated = true;
      }
    } catch (e) {
      console.error('Erro ao salvar token na conta:', e.message);
    }

    // Mascarar tokens para resposta
    const mask = (t) => t ? `${t.slice(0, 8)}...${t.slice(-4)}` : null;

    return Response.json({
      ok: true,
      message: 'Amazon Ads conectada com sucesso.',
      refresh_token_preview: mask(refreshToken),
      profiles_count: profiles.length,
      profiles: profiles.map(p => ({ profileId: p.profileId, name: p.accountInfo?.name, marketplace: p.countryCode, type: p.accountInfo?.type })),
      account_updated: accountUpdated,
    });

  } catch (error) {
    return Response.json({ error: error.message || 'Erro interno' }, { status: 500 });
  }
});