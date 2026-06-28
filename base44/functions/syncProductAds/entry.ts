/**
 * syncProductAds — Sincroniza Product Ads (anúncios individuais SP) com ASIN/SKU
 * Também sincroniza Targets e Product Targets
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
      operation: 'syncProductAds',
      status: 'running',
      started_at: new Date().toISOString(),
    });
    syncRunId = syncRun.id;

    let totalReceived = 0, totalUpserted = 0;
    const errors = [];

    // ── Product Ads SP ──
    try {
      const adsData = await call('POST', '/sp/productAds/list',
        { stateFilter: { include: ['ENABLED', 'PAUSED', 'ARCHIVED'] }, maxResults: 1000 },
        'application/vnd.spProductAd.v3+json'
      );
      const adsList = adsData?.productAds || (Array.isArray(adsData) ? adsData : []);
      totalReceived += adsList.length;

      // Agrupar por ASIN para upsert em Product
      const asinMap = {};
      for (const ad of adsList) {
        const asin = ad.asin;
        if (asin && !asinMap[asin]) {
          asinMap[asin] = { asin, sku: ad.sku, campaign_id: String(ad.campaignId), ad_group_id: String(ad.adGroupId), state: (ad.state || 'enabled').toLowerCase() };
        }
        // Upsert no entity Product (campos básicos de anúncio)
        const existingProd = await base44.asServiceRole.entities.Product.filter({
          amazon_account_id: amazonAccountId,
          asin: asin,
        });
        const prodRecord = {
          amazon_account_id: amazonAccountId,
          asin: asin,
          sku: ad.sku || existingProd[0]?.sku || null,
          status: (ad.state || 'enabled').toLowerCase(),
          synced_at: new Date().toISOString(),
        };
        if (existingProd.length > 0) {
          await base44.asServiceRole.entities.Product.update(existingProd[0].id, prodRecord);
        } else {
          await base44.asServiceRole.entities.Product.create(prodRecord);
        }
        totalUpserted++;
      }
    } catch (e) { errors.push(`ProductAds: ${e.message}`); }

    // ── SP Targets (product targeting) ──
    try {
      const targetData = await call('POST', '/sp/targets/list',
        { stateFilter: { include: ['ENABLED', 'PAUSED', 'ARCHIVED'] }, maxResults: 1000 },
        'application/vnd.spTargetingClause.v3+json'
      );
      const targetList = targetData?.targetingClauses || (Array.isArray(targetData) ? targetData : []);
      totalReceived += targetList.length;
      // Targets ASIN são guardados como keywords com matchType = 'targeting'
      for (const t of targetList) {
        if (!t.targetId) continue;
        const asin = t.expression?.[0]?.value || t.resolvedExpression?.[0]?.value;
        const existing = await base44.asServiceRole.entities.Keyword.filter({
          amazon_account_id: amazonAccountId,
          keyword_id: `tgt_${t.targetId}`,
        });
        const record = {
          amazon_account_id: amazonAccountId,
          campaign_id: String(t.campaignId),
          ad_group_id: String(t.adGroupId),
          keyword_id: `tgt_${t.targetId}`,
          keyword_text: asin || t.expression?.[0]?.type || 'product_target',
          match_type: 'targeting',
          state: (t.state || 'enabled').toLowerCase(),
          bid: t.bid || 0,
          synced_at: new Date().toISOString(),
        };
        if (existing.length > 0) {
          await base44.asServiceRole.entities.Keyword.update(existing[0].id, record);
        } else {
          await base44.asServiceRole.entities.Keyword.create(record);
        }
        totalUpserted++;
      }
    } catch (e) { errors.push(`Targets: ${e.message}`); }

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