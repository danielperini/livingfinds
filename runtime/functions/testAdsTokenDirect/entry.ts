import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    if (!body._service_role) return Response.json({ error: 'Uso interno' }, { status: 403 });

    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1);
    const acc = accounts[0];
    if (!acc) return Response.json({ error: 'Conta não encontrada' }, { status: 404 });

    const entityToken = acc.ads_refresh_token;
    const secretToken = Deno.env.get('ADS_REFRESH_TOKEN') || '';
    const clientId = Deno.env.get('ADS_CLIENT_ID') || '';
    const clientSecret = Deno.env.get('ADS_CLIENT_SECRET') || '';
    const profileId = acc.ads_profile_id || Deno.env.get('ADS_PROFILE_ID') || '';

    // Testar exchange com token da entidade
    const exchangeEntity = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: entityToken,
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
    });
    const entityResult = await exchangeEntity.json();
    const entityAccessToken = entityResult.access_token || null;

    // Testar exchange com token do secret
    const exchangeSecret = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: secretToken,
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
    });
    const secretResult = await exchangeSecret.json();

    // Se o entity token funcionou, testar uma chamada real à API de Ads
    let adsApiTest = null;
    if (entityAccessToken) {
      const adsRes = await fetch('https://advertising-api.amazon.com/v2/profiles', {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${entityAccessToken}`,
          'Amazon-Advertising-API-ClientId': clientId,
        },
      });
      const adsData = await adsRes.json().catch(() => ({}));
      adsApiTest = { status: adsRes.status, ok: adsRes.ok, profiles_count: Array.isArray(adsData) ? adsData.length : null, error: adsRes.ok ? null : (adsData.message || adsData.details || String(adsRes.status)) };
    }

    return Response.json({
      entity_token_exchange: { status: exchangeEntity.status, ok: exchangeEntity.ok, error: entityResult.error, error_description: entityResult.error_description, has_access_token: !!entityAccessToken },
      secret_token_exchange: { status: exchangeSecret.status, ok: exchangeSecret.ok, error: secretResult.error, error_description: secretResult.error_description },
      ads_api_test: adsApiTest,
      token_comparison: {
        entity_token_last12: entityToken?.slice(-12),
        secret_token_last12: secretToken?.slice(-12),
        same_token: entityToken === secretToken,
      },
      profile_id: profileId,
    });
  } catch (error: any) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});