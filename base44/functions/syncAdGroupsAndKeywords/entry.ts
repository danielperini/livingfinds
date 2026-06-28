/**
 * syncAdGroupsAndKeywords — Sincroniza Ad Groups + Keywords SP com todas as métricas
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
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || 'Token refresh failed');
  tokenCache['ads'] = { access_token: data.access_token, expires_at: Date.now() + (data.expires_in - 60) * 1000 };
  return data.access_token;
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
      operation: 'syncAdGroupsAndKeywords',
      status: 'running',
      started_at: new Date().toISOString(),
    });
    syncRunId = syncRun.id;

    let agReceived = 0, agUpserted = 0, kwReceived = 0, kwUpserted = 0;
    const errors = [];

    // ── Ad Groups SP ──
    try {
      const agData = await call('POST', '/sp/adGroups/list',
        { stateFilter: { include: ['ENABLED', 'PAUSED', 'ARCHIVED'] }, maxResults: 500 },
        'application/vnd.spAdGroup.v3+json'
      );
      const agList = agData?.adGroups || (Array.isArray(agData) ? agData : []);
      agReceived = agList.length;

      for (const ag of agList) {
        const existing = await base44.asServiceRole.entities.AdGroup.filter({
          amazon_account_id: amazonAccountId,
          ad_group_id: String(ag.adGroupId),
        });
        const record = {
          amazon_account_id: amazonAccountId,
          campaign_id: String(ag.campaignId),
          ad_group_id: String(ag.adGroupId),
          name: ag.name,
          state: (ag.state || 'enabled').toLowerCase(),
          default_bid: ag.defaultBid || 0,
          synced_at: new Date().toISOString(),
        };
        if (existing.length > 0) {
          await base44.asServiceRole.entities.AdGroup.update(existing[0].id, record);
        } else {
          await base44.asServiceRole.entities.AdGroup.create(record);
        }
        agUpserted++;
      }
    } catch (e) { errors.push(`AdGroups: ${e.message}`); }

    // ── Keywords SP ──
    try {
      const kwData = await call('POST', '/sp/keywords/list',
        { stateFilter: { include: ['ENABLED', 'PAUSED', 'ARCHIVED'] }, maxResults: 1000 },
        'application/vnd.spKeyword.v3+json'
      );
      const kwList = kwData?.keywords || (Array.isArray(kwData) ? kwData : []);
      kwReceived = kwList.length;

      for (const kw of kwList) {
        const existing = await base44.asServiceRole.entities.Keyword.filter({
          amazon_account_id: amazonAccountId,
          keyword_id: String(kw.keywordId),
        });
        const record = {
          amazon_account_id: amazonAccountId,
          campaign_id: String(kw.campaignId),
          ad_group_id: String(kw.adGroupId),
          keyword_id: String(kw.keywordId),
          keyword_text: kw.keywordText,
          match_type: (kw.matchType || 'broad').toLowerCase(),
          state: (kw.state || 'enabled').toLowerCase(),
          bid: kw.bid || 0,
          synced_at: new Date().toISOString(),
        };
        if (existing.length > 0) {
          await base44.asServiceRole.entities.Keyword.update(existing[0].id, record);
        } else {
          await base44.asServiceRole.entities.Keyword.create(record);
        }
        kwUpserted++;
      }
    } catch (e) { errors.push(`Keywords: ${e.message}`); }

    // ── Negative Keywords SP ──
    // (guardadas com state=archived para diferenciação)
    try {
      const negData = await call('POST', '/sp/negativeKeywords/list',
        { stateFilter: { include: ['ENABLED'] }, maxResults: 500 },
        'application/vnd.spNegativeKeyword.v3+json'
      );
      const negList = negData?.negativeKeywords || (Array.isArray(negData) ? negData : []);
      for (const kw of negList) {
        const existing = await base44.asServiceRole.entities.Keyword.filter({
          amazon_account_id: amazonAccountId,
          keyword_id: String(kw.keywordId),
        });
        const record = {
          amazon_account_id: amazonAccountId,
          campaign_id: String(kw.campaignId),
          ad_group_id: String(kw.adGroupId),
          keyword_id: `neg_${kw.keywordId}`,
          keyword_text: kw.keywordText,
          match_type: `negative_${(kw.matchType || 'exact').toLowerCase()}`,
          state: 'archived',
          bid: 0,
          synced_at: new Date().toISOString(),
        };
        if (existing.length === 0) {
          await base44.asServiceRole.entities.Keyword.create(record);
          kwUpserted++;
        }
      }
    } catch (e) { errors.push(`NegKW: ${e.message}`); }

    await base44.asServiceRole.entities.SyncRun.update(syncRunId, {
      status: errors.length > 0 && agUpserted + kwUpserted === 0 ? 'error' : errors.length > 0 ? 'partial' : 'success',
      records_received: agReceived + kwReceived,
      records_upserted: agUpserted + kwUpserted,
      error_message: errors.join('; ') || null,
      duration_ms: Date.now() - startTime,
      completed_at: new Date().toISOString(),
    });

    return Response.json({ ok: true, adGroups: { received: agReceived, upserted: agUpserted }, keywords: { received: kwReceived, upserted: kwUpserted }, errors });

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