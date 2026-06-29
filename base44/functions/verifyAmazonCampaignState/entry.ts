import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

async function getAccessToken() {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: Deno.env.get('ADS_REFRESH_TOKEN') || '',
    client_id: Deno.env.get('ADS_CLIENT_ID') || '',
    client_secret: Deno.env.get('ADS_CLIENT_SECRET') || ''
  }).toString();
  const r = await fetch('https://advertising-api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const d = await r.json();
  return d.access_token;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { campaign_ids = [], specific_state = '' } = await req.json();
    if (!campaign_ids.length) return Response.json({ error: 'provide campaign_ids' });
    const rawToken = await getAccessToken();
    if (!rawToken) return Response.json({ error: 'auth' });
    const token = rawToken.trim();
    const profileId = Deno.env.get('ADS_PROFILE_ID') || '1489314938316530';
    const region = (Deno.env.get('ADS_REGION') || 'NA').toUpperCase();

    const results = [];
    for (const id of campaign_ids) {
      try {
        const res = await fetch(`https://advertising-api.amazon.com/sp/campaigns/${id}`, {
          headers: {
            'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID') || '',
            'Amazon-Advertising-API-Scope': profileId,
            'Authorization': `Bearer ${token}`
          }
        });
        const body = await res.json();
        results.push({
          campaign_id: id,
          request_status: res.status,
          amazon_state_upper: (body.state || '').toUpperCase(),
          amazon_name: body.name,
          modified: body.lastModifiedDateTime || null
        });
      } catch (e) {
        results.push({ campaign_id: id, amazon_state_upper: 'ERROR', error: e.message });
      }
    }
    return Response.json({ ok: true, verified: results });
  } catch (e) {
    return Response.json({ ok: false, error: e.message });
  }
});