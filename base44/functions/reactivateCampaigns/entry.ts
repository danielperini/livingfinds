import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const tokenCache = {};

async function getAdsToken() {
  const cached = tokenCache['ads'];
  if (cached && cached.expires_at > Date.now()) return cached.access_token;
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: Deno.env.get('ADS_REFRESH_TOKEN'),
    client_id: Deno.env.get('ADS_CLIENT_ID'),
    client_secret: Deno.env.get('ADS_CLIENT_SECRET'),
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    if (res.status === 429 || res.status >= 500) {
      await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 500));
      continue;
    }
    const data = await res.json();
    if (!res.ok) throw { code: data.error, message: data.error_description, status: res.status };
    tokenCache['ads'] = { access_token: data.access_token, expires_at: Date.now() + (data.expires_in - 60) * 1000 };
    return data.access_token;
  }
  throw { code: 'max_retries', message: 'Token refresh failed', status: 503 };
}

function getAdsBaseUrl() {
  const regionMap = { NA: 'https://advertising-api.amazon.com', EU: 'https://advertising-api-eu.amazon.com', FE: 'https://advertising-api-fe.amazon.com' };
  return regionMap[Deno.env.get('ADS_REGION') || 'NA'] || regionMap['NA'];
}

async function adsRequest(path, method = 'GET', body = null) {
  const token = await getAdsToken();
  const baseUrl = getAdsBaseUrl();
  const headers = {
    Authorization: `Bearer ${token}`,
    'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID'),
    'Amazon-Advertising-API-Scope': Deno.env.get('ADS_PROFILE_ID'),
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429 || res.status >= 500) {
      await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000));
      continue;
    }
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) return { error: true, code: res.status, details: data.details || data.message || 'API error' };
    return { error: false, data };
  }
  return { error: true, code: 503, details: 'Max retries exceeded' };
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { action, campaign_id, index, total } = body;

    if (!action) return Response.json({ error: 'action required' }, { status: 400 });

    switch (action) {
      case 'reactivate_one': {
        if (!campaign_id) return Response.json({ error: 'campaign_id required' });
        
        // Validate campaign exists on Amazon
        const check = await adsRequest(`/sp/campaigns/${campaign_id}`);
        if (check.error) return Response.json({ error: check.details, results: [] });
        const amazonState = (check.data.state || '').toUpperCase();

        // Reactivate
        const res = await adsRequest('/sp/campaigns', 'PUT', [{ campaignId: campaign_id, state: 'enabled' }]);
        
        return Response.json({
          campaign_id,
          amazon_state: amazonState,
          updated: !res.error,
          amazon_name: check.data.name,
        });
      }

      case 'batch_reactivate': {
        const ids = body.campaign_ids || [];
        let last_error = null;
        if (!ids.length) return Response.json({ error: 'campaign_ids required' });

        const results = [];
        for (let i = 0; i < ids.length; i++) {
          const id = ids[i];
          const check = await adsRequest(`/sp/campaigns/${id}`);
          if (check.error) {
            results.push({ id, amazon_state: 'ERROR', amazon_name: null, updated: false });
            last_error = check.details;
            continue;
          }
          const res = await adsRequest('/sp/campaigns', 'PUT', [{ campaignId: id, state: 'enabled' }]);
          if (res.error) last_error = res.details;
          results.push({ id, amazon_state: (check.data.state || '').toUpperCase(), amazon_name: check.data.name, updated: !res.error });
          await new Promise(r => setTimeout(r, 500));
        }

        const failed = results.some(r => !r.updated);
        return Response.json({ ok: !failed, results, last_error });
      }

      case 'status': {
        const ids = body.campaign_ids || [];
        if (!ids.length) return Response.json({ error: 'campaign_ids required' });
        const results = [];
        for (const id of ids) {
          const check = await adsRequest(`/sp/campaigns/${id}`);
          if (check.error) results.push({ status: 'error', campaign_id: id, amazon_state: null });
          else results.push({ status: 'ok', campaign_id: id, amazon_state: (check.data.state || '').toUpperCase(), name: check.data.name });
          await new Promise(r => setTimeout(r, 300));
        }
        return Response.json({ results });
      }

      case 'get_access_token': {
        const token = await getAdsToken();
        return Response.json({ ok: true, token: token.substring(0, 10) + '...' });
      }

      default:
        return Response.json({ error: `Unknown action: ${action}` });
    }
  } catch (e) {
    return Response.json({ error: e.message });
  }
});