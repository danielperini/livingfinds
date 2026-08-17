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
    const body = await req.json().catch(() => ({}));
    if (!body._service_role) {
      const user = await base44.auth.me().catch(() => null);
      if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
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

      const [existingProductAds, existingProducts] = await Promise.all([
        base44.asServiceRole.entities.ProductAd.filter(
          { amazon_account_id: amazonAccountId }, null, 5000
        ).catch(() => []),
        base44.asServiceRole.entities.Product.filter(
          { amazon_account_id: amazonAccountId }, null, 5000
        ).catch(() => []),
      ]);
      const productAdMap = new Map(
        existingProductAds.map((row) => [String(row.product_ad_id), row])
      );
      const productMap = new Map(
        existingProducts.filter((row) => row.asin).map((row) => [String(row.asin), row])
      );
      const productAdsToCreate = [];
      const productAdsToUpdate = [];
      const productsToCreate = [];
      const productsToUpdate = [];
      const seenProductAsins = new Set();
      const now = new Date().toISOString();

      for (const ad of adsList) {
        const productAdId = String(ad.adId || ad.productAdId || '');
        if (!productAdId) continue;
        const state = String(ad.state || 'enabled').toLowerCase();
        const productAdRecord = {
          amazon_account_id: amazonAccountId,
          product_ad_id: productAdId,
          campaign_id: String(ad.campaignId || ''),
          ad_group_id: String(ad.adGroupId || ''),
          asin: ad.asin || null,
          sku: ad.sku || null,
          state,
          status: state,
          synced_at: now,
        };
        const existingProductAd = productAdMap.get(productAdId);
        if (existingProductAd) {
          productAdsToUpdate.push({ id: existingProductAd.id, ...productAdRecord });
        } else {
          productAdsToCreate.push(productAdRecord);
        }

        if (!ad.asin) continue;
        if (seenProductAsins.has(String(ad.asin))) continue;
        seenProductAsins.add(String(ad.asin));
        const existingProd = productMap.get(String(ad.asin));
        const prodRecord = {
          amazon_account_id: amazonAccountId,
          asin: ad.asin,
          sku: ad.sku || existingProd?.sku || null,
          status: state,
          synced_at: now,
        };
        if (existingProd) {
          productsToUpdate.push({ id: existingProd.id, ...prodRecord });
        } else {
          productsToCreate.push(prodRecord);
        }
      }

      const BATCH = 100;
      for (let i = 0; i < productAdsToCreate.length; i += BATCH)
        await base44.asServiceRole.entities.ProductAd.bulkCreate(productAdsToCreate.slice(i, i + BATCH));
      for (let i = 0; i < productAdsToUpdate.length; i += BATCH)
        await base44.asServiceRole.entities.ProductAd.bulkUpdate(productAdsToUpdate.slice(i, i + BATCH));
      for (let i = 0; i < productsToCreate.length; i += BATCH)
        await base44.asServiceRole.entities.Product.bulkCreate(productsToCreate.slice(i, i + BATCH));
      for (let i = 0; i < productsToUpdate.length; i += BATCH)
        await base44.asServiceRole.entities.Product.bulkUpdate(productsToUpdate.slice(i, i + BATCH));
      totalUpserted += productAdsToCreate.length + productAdsToUpdate.length +
        productsToCreate.length + productsToUpdate.length;
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
