import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

async function getAdsToken(refreshToken) {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: Deno.env.get('ADS_CLIENT_ID') || '',
    client_secret: Deno.env.get('ADS_CLIENT_SECRET') || '',
  });
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.error || 'Token failed');
  return data.access_token;
}

function getAdsBaseUrl(region) {
  const r = (region || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { amazon_account_id, campaign_id, asin } = body;
    
    if (!amazon_account_id) {
      return Response.json({ error: 'amazon_account_id required' }, { status: 400 });
    }

    const account = await base44.asServiceRole.entities.AmazonAccount.get(amazon_account_id);
    if (!account) {
      return Response.json({ error: 'AmazonAccount not found' }, { status: 404 });
    }

    const refreshToken = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN');
    if (!refreshToken) {
      return Response.json({ error: 'No ADS_REFRESH_TOKEN' }, { status: 400 });
    }

    const profileId = account.ads_profile_id;
    const region = account.region || 'NA';
    
    if (!profileId) {
      return Response.json({ error: 'ads_profile_id not configured' }, { status: 400 });
    }

    const token = await getAdsToken(refreshToken);
    const baseUrl = getAdsBaseUrl(region);

    // Se campaign_id fornecido, verificar essa campanha específica
    if (campaign_id) {
      try {
        const res = await fetch(`${baseUrl}/sp/campaigns/${campaign_id}`, {
          headers: {
            'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID') || '',
            'Amazon-Advertising-API-Scope': profileId,
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.spCampaign.v3+json',
          },
        });
        const data = await res.json();
        
        if (!res.ok) {
          return Response.json({ 
            ok: false, 
            error: 'Campaign not found on Amazon',
            http_status: res.status,
          });
        }

        return Response.json({
          ok: true,
          campaign: {
            campaign_id: data.campaignId || campaign_id,
            name: data.name,
            state: data.state,
            budget: data.budget,
            startDate: data.startDate,
            lastModifiedDateTime: data.lastModifiedDateTime,
          },
        });
      } catch (e) {
        return Response.json({ ok: false, error: e.message });
      }
    }

    // Se asin fornecido, buscar campanhas relacionadas
    if (asin) {
      try {
        const res = await fetch(`${baseUrl}/sp/campaigns/list`, {
          method: 'POST',
          headers: {
            'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID') || '',
            'Amazon-Advertising-API-Scope': profileId,
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/vnd.spCampaign.v3+json',
            'Accept': 'application/vnd.spCampaign.v3+json',
          },
          body: JSON.stringify({
            stateFilter: { include: ['ENABLED', 'PAUSED', 'ARCHIVED'] },
            maxResults: 100,
          }),
        });
        const data = await res.json();
        const campaigns = data?.campaigns || [];
        
        const found = campaigns.find(c => 
          c.name?.includes(asin) || 
          (c.name?.includes('AUTO') && c.name?.includes(asin))
        );

        if (found) {
          return Response.json({
            ok: true,
            campaign: {
              campaign_id: found.campaignId,
              name: found.name,
              state: found.state,
              budget: found.budget,
              startDate: found.startDate,
            },
            found_on_amazon: true,
          });
        }

        return Response.json({ ok: true, campaign: null, found_on_amazon: false });
      } catch (e) {
        return Response.json({ ok: false, error: e.message });
      }
    }

    return Response.json({ error: 'campaign_id or asin required' }, { status: 400 });
  } catch (e) {
    return Response.json({ ok: false, error: e.message });
  }
});