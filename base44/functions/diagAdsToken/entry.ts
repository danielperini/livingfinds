import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    if (!body._service_role) return Response.json({ ok: false, error: 'Uso interno' }, { status: 403 });

    const accountId = body.amazon_account_id;
    if (!accountId) return Response.json({ ok: false, error: 'amazon_account_id obrigatório' }, { status: 400 });

    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ id: accountId }, null, 1);
    const account = accounts[0];
    if (!account) return Response.json({ ok: false, error: 'Conta não encontrada' }, { status: 404 });

    const clientId = Deno.env.get('ADS_CLIENT_ID') || '';
    const clientSecret = Deno.env.get('ADS_CLIENT_SECRET') || '';
    const refreshToken = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN') || '';

    if (!clientId || !clientSecret) return Response.json({ ok: false, error: 'Credenciais ADS_CLIENT_ID/ADS_CLIENT_SECRET ausentes nos secrets' });
    if (!refreshToken) return Response.json({ ok: false, error: 'ads_refresh_token ausente na conta' });

    // 1. Obter access token
    const tokenRes = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
    });
    const tokenData = await tokenRes.json().catch(() => ({}));
    if (!tokenData.access_token) {
      return Response.json({ ok: false, step: 'token', error: tokenData.error_description || tokenData.error, details: tokenData });
    }

    // 2. Listar profiles (sem scope obrigatório)
    const profilesRes = await fetch('https://advertising-api.amazon.com/v2/profiles', {
      headers: {
        'Authorization': `Bearer ${tokenData.access_token}`,
        'Amazon-Advertising-API-ClientId': clientId,
        'Content-Type': 'application/json',
      },
    });
    const profilesText = await profilesRes.text();
    let profilesData;
    try { profilesData = JSON.parse(profilesText); } catch { profilesData = { raw: profilesText.slice(0, 500) }; }

    if (profilesRes.status !== 200) {
      return Response.json({
        ok: false,
        step: 'list_profiles',
        status: profilesRes.status,
        error: `HTTP ${profilesRes.status} ao listar profiles`,
        response: profilesData,
        profile_id_in_db: account.ads_profile_id,
        refresh_token_prefix: refreshToken.slice(0, 20),
        www_authenticate: profilesRes.headers.get('www-authenticate'),
      });
    }

    const profiles = Array.isArray(profilesData) ? profilesData : [];
    const currentProfile = profiles.find((p: any) => String(p.profileId) === String(account.ads_profile_id));

    // 3. Testar a campanha list com o profile atual
    const campRes = await fetch('https://advertising-api.amazon.com/sp/campaigns/list', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${tokenData.access_token}`,
        'Amazon-Advertising-API-ClientId': clientId,
        'Amazon-Advertising-API-Scope': String(account.ads_profile_id),
        'Content-Type': 'application/vnd.spCampaign.v3+json',
        'Accept': 'application/vnd.spCampaign.v3+json',
      },
      body: JSON.stringify({ stateFilter: { include: ['ENABLED'] }, maxResults: 5 }),
    });
    const campText = await campRes.text();
    let campData;
    try { campData = JSON.parse(campText); } catch { campData = { raw: campText.slice(0, 500) }; }

    return Response.json({
      ok: campRes.status === 200,
      token_ok: true,
      profiles_count: profiles.length,
      profiles_list: profiles.map((p: any) => ({ profileId: p.profileId, accountInfo: p.accountInfo, type: p.type, timezone: p.timezone })),
      profile_in_db: account.ads_profile_id,
      profile_match: !!currentProfile,
      campaigns_list_status: campRes.status,
      campaigns_response: campData,
    });
  } catch (error: any) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});