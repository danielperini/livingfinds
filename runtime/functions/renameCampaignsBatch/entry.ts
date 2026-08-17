import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const payload = await req.json();
    const { amazon_account_id, renames } = payload;
    // renames: Array<{ campaignId: string, name: string }>

    if (!amazon_account_id || !renames?.length) {
      return Response.json({ error: 'amazon_account_id and renames required' }, { status: 400 });
    }

    // Get token via tokenManager
    const tokenRes = await base44.asServiceRole.functions.invoke('amazonAdsTokenManager', {
      amazon_account_id,
      _service_role: true,
    });
    const accessToken = tokenRes?.data?.access_token;
    if (!accessToken) {
      return Response.json({ ok: false, error: 'Failed to get access token', tokenRes: tokenRes?.data }, { status: 500 });
    }

    const account = await base44.asServiceRole.entities.AmazonAccount.get(amazon_account_id);
    const profileId = account?.ads_profile_id;
    const clientId = Deno.env.get('ADS_CLIENT_ID');

    if (!profileId || !clientId) {
      return Response.json({ ok: false, error: 'Missing profileId or ADS_CLIENT_ID' }, { status: 500 });
    }

    // Process in batches of 5
    const BATCH_SIZE = 5;
    const results = [];

    for (let i = 0; i < renames.length; i += BATCH_SIZE) {
      const batch = renames.slice(i, i + BATCH_SIZE);

      const res = await fetch('https://advertising-api.amazon.com/sp/campaigns', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/vnd.spCampaign.v3+json',
          'Accept': 'application/vnd.spCampaign.v3+json',
          'Authorization': `Bearer ${accessToken}`,
          'Amazon-Advertising-API-ClientId': clientId,
          'Amazon-Advertising-API-Scope': profileId,
        },
        body: JSON.stringify({ campaigns: batch }),
      });

      const text = await res.text();
      let parsed;
      try { parsed = JSON.parse(text); } catch { parsed = text; }
      results.push({ batch: Math.floor(i / BATCH_SIZE) + 1, status: res.status, response: parsed });

      // Small delay between batches
      await new Promise(r => setTimeout(r, 300));
    }

    const allOk = results.every(r => r.status === 200 || r.status === 207);
    return Response.json({ ok: allOk, results });
  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});