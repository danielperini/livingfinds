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
    if (res.status === 429 || res.status >= 500) { await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 500)); continue; }
    const data = await res.json();
    if (!res.ok) throw { code: data.error, message: data.error_description, status: res.status };
    tokenCache['ads'] = { access_token: data.access_token, expires_at: Date.now() + (data.expires_in - 60) * 1000 };
    return data.access_token;
  }
  throw { code: 'max_retries', message: 'Token refresh failed', status: 503 };
}

function getAdsBaseUrl() {
  const r = (Deno.env.get('ADS_REGION') || 'NA').toUpperCase().trim();
  // Normalizar regiões alternativas
  if (r.includes('NORTE') || r.includes('BRASIL') || r.includes('NA') || r.includes('US') || r.includes('BR')) {
    return 'https://advertising-api.amazon.com';
  }
  if (r.includes('EU') || r.includes('EUROP')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE') || r.includes('JAPAN') || r.includes('ASIA')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function adsCall(method, path, body) {
  const token = await getAdsToken();
  const opts = {
    method: method || 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID'),
      'Amazon-Advertising-API-Scope': String(Deno.env.get('ADS_PROFILE_ID')),
      'Content-Type': 'application/vnd.spCampaign.v3+json',
      'Accept': 'application/vnd.spCampaign.v3+json',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${getAdsBaseUrl()}${path}`, opts);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw { code: `ads_${res.status}`, message: JSON.stringify(data), status: res.status };
  return data;
}

async function adsGet(path) { return adsCall('GET', path); }

Deno.serve(async (req) => {
  const startTime = Date.now();
  let syncRunId = null;

  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const amazonAccountId = body.amazon_account_id;
    if (!amazonAccountId) return Response.json({ error: 'amazon_account_id required' }, { status: 400 });

    const mode = body.mode || 'real';

    // Create sync run record
    const syncRun = await base44.asServiceRole.entities.SyncRun.create({
      amazon_account_id: amazonAccountId,
      operation: 'syncAds',
      status: 'running',
      started_at: new Date().toISOString(),
    });
    syncRunId = syncRun.id;

    if (mode === 'mock') {
      await base44.asServiceRole.entities.SyncRun.update(syncRunId, {
        status: 'success', records_received: 0, records_upserted: 0,
        duration_ms: Date.now() - startTime, completed_at: new Date().toISOString(),
      });
      return Response.json({ ok: true, mode: 'mock', message: 'Mock sync — no real API calls' });
    }

    // Fetch campaigns
    const campaignsData = await adsCall('POST', '/sp/campaigns/list', { maxResults: 100 });
    const campaignList = campaignsData?.campaigns || (Array.isArray(campaignsData) ? campaignsData : []);

    let upserted = 0;
    for (const c of campaignList) {
      const existing = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: amazonAccountId, campaign_id: String(c.campaignId) });
      const record = {
        amazon_account_id: amazonAccountId,
        campaign_id: String(c.campaignId),
        name: c.name,
        campaign_type: 'SP',
        targeting_type: c.targetingType,
        state: (c.state || '').toLowerCase(),
        daily_budget: c.budget?.budget || c.dailyBudget,
        start_date: c.startDate,
        end_date: c.endDate,
        bidding_strategy: c.dynamicBidding?.strategy || c.bidding?.strategy,
        synced_at: new Date().toISOString(),
      };
      if (existing.length > 0) {
        await base44.asServiceRole.entities.Campaign.update(existing[0].id, record);
      } else {
        await base44.asServiceRole.entities.Campaign.create(record);
      }
      upserted++;
    }

    await base44.asServiceRole.entities.SyncRun.update(syncRunId, {
      status: 'success',
      records_received: campaignList.length,
      records_upserted: upserted,
      duration_ms: Date.now() - startTime,
      completed_at: new Date().toISOString(),
    });

    return Response.json({ ok: true, mode, records_received: campaignList.length, records_upserted: upserted });
  } catch (error) {
    const err = error || {};
    if (syncRunId) {
      const base44 = createClientFromRequest(req);
      await base44.asServiceRole.entities.SyncRun.update(syncRunId, {
        status: 'error', error_code: err.code || 'unknown', error_message: err.message || 'Unknown error',
        duration_ms: Date.now() - startTime, completed_at: new Date().toISOString(),
      }).catch(() => {});
    }
    return Response.json({ ok: false, error_code: err.code || 'unknown', message: err.message || 'Sync failed' }, { status: err.status || 500 });
  }
});