import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    // Obter token LWA
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: Deno.env.get('ADS_REFRESH_TOKEN'),
      client_id: Deno.env.get('ADS_CLIENT_ID'),
      client_secret: Deno.env.get('ADS_CLIENT_SECRET'),
    });

    const tokenRes = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok) {
      return Response.json({ error: 'Token failed', details: tokenData }, { status: 400 });
    }

    const token = tokenData.access_token;
    const region = Deno.env.get('ADS_REGION') || 'NA';
    const baseUrl = { NA: 'https://advertising-api.amazon.com', EU: 'https://advertising-api-eu.amazon.com', FE: 'https://advertising-api-fe.amazon.com' }[region] || 'https://advertising-api.amazon.com';

    // Listar perfis disponíveis (sem Amazon-Advertising-API-Scope)
    const profilesRes = await fetch(`${baseUrl}/v2/profiles`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID'),
        'Accept': 'application/json',
      },
    });
    const profilesText = await profilesRes.text();
    let profiles;
    try { profiles = JSON.parse(profilesText); } catch { profiles = profilesText; }

    // Testar SP, SB e SD campaigns
    const headers = {
      'Authorization': `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID'),
      'Amazon-Advertising-API-Scope': String(Deno.env.get('ADS_PROFILE_ID')),
    };

    const [spRes, sbRes, sdRes] = await Promise.all([
      fetch(`${baseUrl}/sp/campaigns/list`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/vnd.spCampaign.v3+json', 'Accept': 'application/vnd.spCampaign.v3+json' }, body: JSON.stringify({ maxResults: 10 }) }),
      fetch(`${baseUrl}/sb/campaigns?stateFilter=enabled,paused&count=10`, { headers: { ...headers, 'Accept': 'application/json' } }),
      fetch(`${baseUrl}/sd/campaigns?stateFilter=enabled,paused&count=10`, { headers: { ...headers, 'Accept': 'application/json' } }),
    ]);

    const [spData, sbData, sdData] = await Promise.all([spRes.json().catch(e => e.message), sbRes.json().catch(e => e.message), sdRes.json().catch(e => e.message)]);

    return Response.json({
      profiles,
      sp: { status: spRes.status, data: spData },
      sb: { status: sbRes.status, data: sbData },
      sd: { status: sdRes.status, data: sdData },
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});