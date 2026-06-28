/**
 * syncAds — Sincroniza campanhas SP via Amazon Ads API diretamente
 * Payload: { amazon_account_id }
 * Nota: usa as credenciais ADS_* (não Xano). Prefira syncAll para delegar ao Xano.
 */
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
    if (!res.ok) throw new Error(data.error_description || `Token refresh failed (${res.status})`);
    tokenCache['ads'] = { access_token: data.access_token, expires_at: Date.now() + (data.expires_in - 60) * 1000 };
    return data.access_token;
  }
  throw new Error('Token refresh failed after 3 attempts');
}

function getAdsBaseUrl() {
  const r = (Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

Deno.serve(async (req) => {
  const startTime = Date.now();
  let syncRunId = null;
  let base44;

  try {
    base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const amazonAccountId = body.amazon_account_id;
    if (!amazonAccountId) return Response.json({ error: 'amazon_account_id required' }, { status: 400 });

    const syncRun = await base44.asServiceRole.entities.SyncRun.create({
      amazon_account_id: amazonAccountId,
      operation: 'syncAds',
      status: 'running',
      started_at: new Date().toISOString(),
    });
    syncRunId = syncRun.id;

    const token = await getAdsToken();
    const adsBase = getAdsBaseUrl();

    const res = await fetch(`${adsBase}/sp/campaigns/list`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID'),
        'Amazon-Advertising-API-Scope': String(Deno.env.get('ADS_PROFILE_ID')),
        'Content-Type': 'application/vnd.spCampaign.v3+json',
        'Accept': 'application/vnd.spCampaign.v3+json',
      },
      body: JSON.stringify({ stateFilter: { include: ['ENABLED', 'PAUSED'] }, maxResults: 500 }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(`ADS ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);

    const campaignList = data?.campaigns || [];
    let upserted = 0;

    for (const c of campaignList) {
      const existing = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: amazonAccountId, campaign_id: String(c.campaignId) });
      const record = {
        amazon_account_id: amazonAccountId,
        campaign_id: String(c.campaignId),
        name: c.name,
        campaign_type: 'SP',
        targeting_type: c.targetingType,
        state: (c.state || 'ENABLED').toLowerCase(),
        daily_budget: c.budget?.budget || c.dailyBudget || 0,
        start_date: c.startDate,
        end_date: c.endDate || null,
        bidding_strategy: c.dynamicBidding?.strategy || c.bidding?.strategy || null,
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

    return Response.json({ ok: true, records_received: campaignList.length, records_upserted: upserted });
  } catch (error) {
    if (syncRunId && base44) {
      await base44.asServiceRole.entities.SyncRun.update(syncRunId, {
        status: 'error', error_message: error.message,
        duration_ms: Date.now() - startTime, completed_at: new Date().toISOString(),
      }).catch(() => {});
    }
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});