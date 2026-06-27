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

  let attempt = 0;
  while (attempt < 3) {
    attempt++;
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
  throw { code: 'max_retries', message: 'Token refresh failed after retries', status: 503 };
}

function getAdsBaseUrl() {
  const region = Deno.env.get('ADS_REGION') || 'NA';
  const regionMap = { NA: 'https://advertising-api.amazon.com', EU: 'https://advertising-api-eu.amazon.com', FE: 'https://advertising-api-fe.amazon.com' };
  return regionMap[region] || regionMap['NA'];
}

async function adsRequest(path, method = 'GET', body = null) {
  const token = await getAdsToken();
  const profileId = Deno.env.get('ADS_PROFILE_ID');
  const clientId = Deno.env.get('ADS_CLIENT_ID');
  const baseUrl = getAdsBaseUrl();

  const headers = {
    'Authorization': `Bearer ${token}`,
    'Amazon-Advertising-API-ClientId': clientId,
    'Amazon-Advertising-API-Scope': profileId,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };

  let attempt = 0;
  while (attempt < 3) {
    attempt++;
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
    if (!res.ok) throw { code: `ads_${res.status}`, message: data.details || data.message || 'Ads API error', status: res.status };
    return data;
  }
  throw { code: 'max_retries', message: 'Ads API request failed after retries', status: 503 };
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { action, payload } = body;

    let result;
    switch (action) {
      case 'getProfiles':
        result = await adsRequest('/v2/profiles');
        break;
      case 'getCampaigns':
        result = await adsRequest('/v2/sp/campaigns?stateFilter=enabled,paused&count=100');
        break;
      case 'getAdGroups':
        result = await adsRequest(`/v2/sp/adGroups?campaignIdFilter=${payload?.campaign_id || ''}&count=100`);
        break;
      case 'getKeywords':
        result = await adsRequest(`/v2/sp/keywords?adGroupIdFilter=${payload?.ad_group_id || ''}&count=500`);
        break;
      case 'updateCampaign':
        result = await adsRequest('/v2/sp/campaigns', 'PUT', [payload]);
        break;
      case 'updateKeyword':
        result = await adsRequest('/v2/sp/keywords', 'PUT', [payload]);
        break;
      case 'updateBid':
        result = await adsRequest('/v2/sp/keywords', 'PUT', [{ keywordId: payload.keyword_id, bid: payload.bid }]);
        break;
      default:
        return Response.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }

    return Response.json({ ok: true, data: result });
  } catch (error) {
    const err = error || {};
    return Response.json({ ok: false, error_code: err.code || 'unknown', message: err.message || 'Internal error' }, { status: err.status || 500 });
  }
});