/**
 * bulkSetAllBids — Define bid de R$0.60 em todas as keywords ativas/pausadas via Amazon Ads API.
 * Também atualiza o campo default_bid dos ad groups.
 * Payload: { amazon_account_id, bid? (default 0.60) }
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

async function adsCall(method, path, body, contentType = 'application/json') {
  const token = await getToken();
  const res = await fetch(`${baseUrl()}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID'),
      'Amazon-Advertising-API-Scope': String(Deno.env.get('ADS_PROFILE_ID')),
      'Content-Type': contentType,
      'Accept': contentType,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { ok: res.ok, status: res.status, data };
}

// chunk array into batches of N
function chunk(arr, size) {
  const result = [];
  for (let i = 0; i < arr.length; i += size) result.push(arr.slice(i, i + size));
  return result;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const amazonAccountId = body.amazon_account_id;
    const targetBid = typeof body.bid === 'number' ? body.bid : 0.60;

    if (!amazonAccountId) return Response.json({ error: 'amazon_account_id required' }, { status: 400 });

    const now = new Date().toISOString();
    let kwTotal = 0, kwOk = 0, kwFailed = 0;
    let agTotal = 0, agOk = 0, agFailed = 0;
    const errors = [];

    // ─────────────────────────────────────────────────────────────
    // 1. Buscar keywords SP ativas/pausadas da Amazon API
    // ─────────────────────────────────────────────────────────────
    const kwRes = await adsCall('POST', '/sp/keywords/list',
      { stateFilter: { include: ['ENABLED', 'PAUSED'] }, maxResults: 1000 },
      'application/vnd.spKeyword.v3+json'
    );

    if (!kwRes.ok) {
      return Response.json({ ok: false, error: `Falha ao listar keywords: ${JSON.stringify(kwRes.data).slice(0, 300)}` }, { status: 500 });
    }

    const kwList = kwRes.data?.keywords || (Array.isArray(kwRes.data) ? kwRes.data : []);
    kwTotal = kwList.length;

    // 2. Atualizar na Amazon API em batches de 100
    const kwBatches = chunk(kwList, 100);
    for (const batch of kwBatches) {
      const payload = batch.map(kw => ({ keywordId: kw.keywordId, bid: targetBid }));
      const r = await adsCall('PUT', '/v2/sp/keywords', payload);
      if (r.ok) {
        kwOk += batch.length;
      } else {
        kwFailed += batch.length;
        errors.push(`KW batch PUT failed: ${JSON.stringify(r.data).slice(0, 200)}`);
      }
      // Rate limit safety
      await new Promise(resolve => setTimeout(resolve, 300));
    }

    // 3. Atualizar banco local (keyword_id list)
    const kwIds = kwList.map(kw => String(kw.keywordId));
    for (const kwId of kwIds) {
      await base44.asServiceRole.entities.Keyword.updateMany(
        { amazon_account_id: amazonAccountId, keyword_id: kwId },
        { $set: { bid: targetBid, current_bid: targetBid, synced_at: now } }
      ).catch(() => {});
    }

    // ─────────────────────────────────────────────────────────────
    // 4. Buscar ad groups e atualizar default_bid
    // ─────────────────────────────────────────────────────────────
    const agRes = await adsCall('POST', '/sp/adGroups/list',
      { stateFilter: { include: ['ENABLED', 'PAUSED'] }, maxResults: 500 },
      'application/vnd.spAdGroup.v3+json'
    );

    if (agRes.ok) {
      const agList = agRes.data?.adGroups || (Array.isArray(agRes.data) ? agRes.data : []);
      agTotal = agList.length;

      const agBatches = chunk(agList, 100);
      for (const batch of agBatches) {
        const payload = batch.map(ag => ({ adGroupId: ag.adGroupId, defaultBid: targetBid }));
        const r = await adsCall('PUT', '/v2/sp/adGroups', payload);
        if (r.ok) {
          agOk += batch.length;
        } else {
          agFailed += batch.length;
          errors.push(`AG batch PUT failed: ${JSON.stringify(r.data).slice(0, 200)}`);
        }
        await new Promise(resolve => setTimeout(resolve, 300));
      }

      // Atualizar banco local ad groups
      for (const ag of agList) {
        await base44.asServiceRole.entities.AdGroup.updateMany(
          { amazon_account_id: amazonAccountId, ad_group_id: String(ag.adGroupId) },
          { $set: { default_bid: targetBid, synced_at: now } }
        ).catch(() => {});
      }
    } else {
      errors.push(`AdGroups list failed: ${JSON.stringify(agRes.data).slice(0, 200)}`);
    }

    // ─────────────────────────────────────────────────────────────
    // 5. Registrar no log de mudanças
    // ─────────────────────────────────────────────────────────────
    await base44.asServiceRole.entities.CampaignChangeHistory.create({
      amazon_account_id: amazonAccountId,
      campaign_id: 'ALL',
      change_type: 'BASE_BID',
      entity_type: 'keyword',
      field_name: 'bid',
      old_value: 'various',
      new_value: String(targetBid),
      source: 'USER',
      source_function: 'bulkSetAllBids',
      reason: `Bulk set: todos os bids para R$${targetBid.toFixed(2)} via interface`,
      status: kwFailed === 0 ? 'executed' : 'failed',
      changed_at: now,
    }).catch(() => {});

    return Response.json({
      ok: kwFailed === 0,
      target_bid: targetBid,
      keywords: { total: kwTotal, ok: kwOk, failed: kwFailed },
      ad_groups: { total: agTotal, ok: agOk, failed: agFailed },
      errors: errors.length > 0 ? errors : undefined,
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});