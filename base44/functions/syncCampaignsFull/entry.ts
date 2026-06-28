/**
 * syncCampaignsFull — Sincroniza TODAS as campanhas SP + SB + SD com todos os campos
 * Payload: { amazon_account_id }
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const tokenCache = {};

async function getToken() {
  const cached = tokenCache['ads'];
  if (cached && cached.expires_at > Date.now()) return cached.access_token;
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: Deno.env.get('ADS_REFRESH_TOKEN'),
    client_id: Deno.env.get('ADS_CLIENT_ID'),
    client_secret: Deno.env.get('ADS_CLIENT_SECRET'),
  });
  let attempt = 0;
  while (attempt < 5) {
    attempt++;
    const res = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    if (res.status === 429 || res.status >= 500) {
      await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 2000));
      continue;
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error_description || `Token refresh failed (${res.status})`);
    tokenCache['ads'] = { access_token: data.access_token, expires_at: Date.now() + (data.expires_in - 60) * 1000 };
    return data.access_token;
  }
  throw new Error('Token refresh failed after 5 attempts — rate limit. Aguarde 1 minuto e tente novamente.');
}

function baseUrl() {
  const r = (Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function call(method, path, body, ct = 'application/json') {
  const token = await getToken();
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID'),
      'Amazon-Advertising-API-Scope': String(Deno.env.get('ADS_PROFILE_ID')),
      'Content-Type': ct,
      'Accept': ct,
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${baseUrl()}${path}`, opts);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`ADS ${res.status} ${path}: ${JSON.stringify(data).slice(0, 200)}`);
  return data;
}

async function upsertCampaign(base44, amazonAccountId, record) {
  const existing = await base44.asServiceRole.entities.Campaign.filter({
    amazon_account_id: amazonAccountId,
    campaign_id: record.campaign_id,
  });
  if (existing.length > 0) {
    await base44.asServiceRole.entities.Campaign.update(existing[0].id, record);
  } else {
    await base44.asServiceRole.entities.Campaign.create(record);
  }
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
      operation: 'syncCampaignsFull',
      status: 'running',
      started_at: new Date().toISOString(),
    });
    syncRunId = syncRun.id;

    let totalReceived = 0;
    let totalUpserted = 0;
    const errors = [];

    // ── SP Campaigns (v3) ──
    try {
      const spData = await call('POST', '/sp/campaigns/list',
        { stateFilter: { include: ['ENABLED', 'PAUSED', 'ARCHIVED'] }, maxResults: 500 },
        'application/vnd.spCampaign.v3+json'
      );
      const spList = spData?.campaigns || [];
      totalReceived += spList.length;
      for (const c of spList) {
        await upsertCampaign(base44, amazonAccountId, {
          amazon_account_id: amazonAccountId,
          campaign_id: String(c.campaignId),
          name: c.name,
          campaign_type: 'SP',
          targeting_type: c.targetingType,
          state: (c.state || 'ENABLED').toLowerCase(),
          daily_budget: c.budget?.budget ?? c.dailyBudget ?? 0,
          start_date: c.startDate,
          end_date: c.endDate || null,
          bidding_strategy: c.dynamicBidding?.strategy || c.bidding?.strategy || null,
          synced_at: new Date().toISOString(),
        });
        totalUpserted++;
      }
    } catch (e) { errors.push(`SP: ${e.message}`); }

    // ── SB Campaigns ──
    try {
      const sbData = await call('GET', '/sb/campaigns?count=100&stateFilter=enabled,paused,archived');
      const sbList = sbData?.campaigns || (Array.isArray(sbData) ? sbData : []);
      totalReceived += sbList.length;
      for (const c of sbList) {
        await upsertCampaign(base44, amazonAccountId, {
          amazon_account_id: amazonAccountId,
          campaign_id: String(c.campaignId),
          name: c.name,
          campaign_type: 'SB',
          targeting_type: c.targetingType || null,
          state: (c.state || 'enabled').toLowerCase(),
          daily_budget: c.budget || c.dailyBudget || 0,
          start_date: c.startDate || null,
          end_date: c.endDate || null,
          bidding_strategy: c.bidding?.strategy || null,
          synced_at: new Date().toISOString(),
        });
        totalUpserted++;
      }
    } catch (e) { errors.push(`SB: ${e.message}`); }

    // ── SD Campaigns ──
    try {
      const sdData = await call('GET', '/sd/campaigns?count=100&stateFilter=enabled,paused,archived');
      const sdList = sdData?.campaigns || (Array.isArray(sdData) ? sdData : []);
      totalReceived += sdList.length;
      for (const c of sdList) {
        await upsertCampaign(base44, amazonAccountId, {
          amazon_account_id: amazonAccountId,
          campaign_id: String(c.campaignId),
          name: c.name,
          campaign_type: 'SD',
          targeting_type: c.tactic || null,
          state: (c.state || 'enabled').toLowerCase(),
          daily_budget: c.budget || c.dailyBudget || 0,
          start_date: c.startDate || null,
          end_date: c.endDate || null,
          bidding_strategy: null,
          synced_at: new Date().toISOString(),
        });
        totalUpserted++;
      }
    } catch (e) { errors.push(`SD: ${e.message}`); }

    await base44.asServiceRole.entities.SyncRun.update(syncRunId, {
      status: errors.length > 0 && totalUpserted === 0 ? 'error' : errors.length > 0 ? 'partial' : 'success',
      records_received: totalReceived,
      records_upserted: totalUpserted,
      error_message: errors.join('; ') || null,
      duration_ms: Date.now() - startTime,
      completed_at: new Date().toISOString(),
    });

    return Response.json({ ok: true, totalReceived, totalUpserted, errors });

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