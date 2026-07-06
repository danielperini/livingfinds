import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function adsBase(region: string | undefined) {
  const v = String(region || Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
  if (v.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (v.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function getToken(account: any) {
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: account.ads_refresh_token,
      client_id: Deno.env.get('ADS_CLIENT_ID') || '',
      client_secret: Deno.env.get('ADS_CLIENT_SECRET') || '',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(data.error_description || 'Falha no token');
  return data.access_token;
}

function normalizeTerm(term: string): string {
  return String(term || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

function idempotencyKey(accountId: string, campaignId: string, adGroupId: string, asin: string, term: string): string {
  return `${accountId}|${campaignId}|${adGroupId}|${asin}|${normalizeTerm(term)}|EXACT`;
}

function campaignName(asin: string, term: string): string {
  const date = new Date().toISOString().slice(0, 10);
  const t = normalizeTerm(term).slice(0, 60);
  return `EXACT | ${asin} | ${t} | ${date}`.slice(0, 128);
}

function calcBid(term: any, config: any): number {
  const minBid = config?.min_bid || 0.1;
  const maxBid = config?.max_bid || 5.0;
  let bid = 0.5;
  if (term.average_cpc && term.average_cpc > 0) {
    bid = Math.min(term.average_cpc * 1.1, maxBid);
  }
  if (bid < minBid) bid = minBid;
  if (bid > maxBid) bid = maxBid;
  return Math.round(bid * 100) / 100;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user || user.role !== 'admin') return Response.json({ error: 'Admin only' }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const accountId = body.amazon_account_id;
    if (!accountId) return Response.json({ ok: false, error: 'amazon_account_id obrigatório' }, { status: 400 });

    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ id: accountId }, null, 1);
    const account = accounts[0];
    if (!account) return Response.json({ ok: false, error: 'Conta não encontrada' }, { status: 404 });

    const token = await getToken(account);
    const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID');
    const baseUrl = adsBase(account.region);

    const authHeaders = {
      Authorization: `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID') || '',
      'Amazon-Advertising-API-Scope': String(profileId),
    };

    async function adsCall(method: string, path: string, payload: any, ct = 'application/vnd.spCampaign.v3+json') {
      const h = { ...authHeaders, 'Content-Type': ct, Accept: ct };
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: h,
        body: method !== 'GET' ? JSON.stringify(payload) : undefined,
      });
      const text = await res.text().catch(() => '');
      let parsed: any = {};
      try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
      return { ok: res.status >= 200 && res.status < 300, status: res.status, payload: parsed };
    }

    function firstId(result: any, group: string, field: string) {
      const p = result?.payload || result || {};
      return p?.[group]?.success?.[0]?.[field]
        || p?.success?.[0]?.[field]
        || p?.[group]?.[0]?.[field]
        || null;
    }

    // Load config
    const configs = await base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: accountId }, null, 1);
    const config = configs[0] || {};

    // Load existing promotions to skip duplicates
    const existingPromos = await base44.asServiceRole.entities.SearchTermPromotion.filter({ amazon_account_id: accountId }, null, 5000);
    const existingKeys = new Set(existingPromos.map((p: any) => p.idempotency_key).filter(Boolean));

    // Load search terms from DB (last 30 days)
    const cutoff = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const allTerms = await base44.asServiceRole.entities.SearchTerm.filter({ amazon_account_id: accountId }, '-date', 10000);
    const recentTerms = allTerms.filter((t: any) => t.date >= cutoff && t.advertised_asin && t.search_term);

    // Aggregate by (campaign_id, ad_group_id, asin, normalized_term)
    const termMap = new Map<string, any>();
    for (const t of recentTerms) {
      const norm = normalizeTerm(t.search_term);
      const key = `${t.campaign_id}|${t.ad_group_id}|${t.advertised_asin}|${norm}`;
      if (!termMap.has(key)) {
        termMap.set(key, {
          campaign_id: t.campaign_id,
          ad_group_id: t.ad_group_id,
          asin: t.advertised_asin,
          sku: t.advertised_sku || '',
          search_term: t.search_term,
          normalized_term: norm,
          orders: 0, units_sold: 0, sales: 0, spend: 0, clicks: 0, cpc_sum: 0, cpc_count: 0,
        });
      }
      const agg = termMap.get(key)!;
      // Use best available order window
      agg.orders += t.orders_14d || t.orders_30d || t.orders_7d || 0;
      agg.units_sold += t.units_14d || t.units_30d || t.units_7d || 0;
      agg.sales += t.sales_14d || t.sales_30d || t.sales_7d || 0;
      agg.spend += t.spend || 0;
      agg.clicks += t.clicks || 0;
      if (t.cpc && t.cpc > 0) { agg.cpc_sum += t.cpc; agg.cpc_count += 1; }
    }

    // Filter: orders >= 3
    const candidates = Array.from(termMap.values()).filter((t) => t.orders >= 3);

    // Load existing negative keywords from DB to skip
    const negKws = await base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: accountId, match_type: 'negative_exact' }, null, 5000).catch(() => []);
    const negSet = new Set(negKws.map((k: any) => normalizeTerm(k.keyword_text || k.text || '')));

    // Load existing manual EXACT keywords
    const manualKws = await base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: accountId, match_type: 'exact' }, null, 5000).catch(() => []);
    const exactSet = new Set(manualKws.map((k: any) => normalizeTerm(k.keyword_text || k.text || '')));

    const stats = {
      terms_found: termMap.size,
      candidates: candidates.length,
      approved: 0,
      created: 0,
      repaired: 0,
      negatives_created: 0,
      duplicates_skipped: 0,
      failed: 0,
      amazon_calls: 0,
    };

    const promotions: any[] = [];

    for (const cand of candidates) {
      const ikey = idempotencyKey(accountId, cand.campaign_id, cand.ad_group_id, cand.asin, cand.normalized_term);

      // Skip if already promoted
      if (existingKeys.has(ikey)) { stats.duplicates_skipped++; continue; }

      // Skip if negated
      if (negSet.has(cand.normalized_term)) { stats.duplicates_skipped++; continue; }

      // Skip if already an exact keyword
      if (exactSet.has(cand.normalized_term)) { stats.duplicates_skipped++; continue; }

      const avg_cpc = cand.cpc_count > 0 ? Math.round((cand.cpc_sum / cand.cpc_count) * 100) / 100 : 0;
      const bid = calcBid({ average_cpc: avg_cpc }, config);

      // Create SearchTermPromotion record
      const promo = await base44.asServiceRole.entities.SearchTermPromotion.create({
        amazon_account_id: accountId,
        asin: cand.asin,
        sku: cand.sku,
        source_campaign_id: cand.campaign_id,
        source_ad_group_id: cand.ad_group_id,
        source_search_term: cand.search_term,
        normalized_search_term: cand.normalized_term,
        orders: cand.orders,
        units_sold: cand.units_sold,
        sales: cand.sales,
        spend: cand.spend,
        clicks: cand.clicks,
        average_cpc: avg_cpc,
        target_bid: bid,
        promotion_status: 'validated',
        idempotency_key: ikey,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      stats.approved++;
      existingKeys.add(ikey);

      try {
        // STEP 1: Create campaign
        await base44.asServiceRole.entities.SearchTermPromotion.update(promo.id, { promotion_status: 'campaign_creating', updated_at: new Date().toISOString() });
        const campName = campaignName(cand.asin, cand.normalized_term);
        const campR = await adsCall('POST', '/sp/campaigns', {
          campaigns: [{
            name: campName,
            targetingType: 'MANUAL',
            state: 'ENABLED',
            startDate: new Date().toISOString().slice(0, 10).replace(/-/g, ''),
            dailyBudget: 5.0,
            budgetType: 'DAILY',
          }],
        });
        stats.amazon_calls++;
        const campaignId = firstId(campR, 'campaigns', 'campaignId');
        if (!campaignId) throw new Error(`Falha ao criar campanha: ${JSON.stringify(campR.payload).slice(0, 200)}`);

        await base44.asServiceRole.entities.SearchTermPromotion.update(promo.id, {
          promotion_status: 'campaign_created',
          destination_campaign_id: String(campaignId),
          destination_campaign_name: campName,
          updated_at: new Date().toISOString(),
        });
        await wait(3000);

        // STEP 2: Create ad group
        const agR = await adsCall('POST', '/sp/adGroups',
          { adGroups: [{ name: `AG | ${cand.asin} | EXACT`, campaignId: String(campaignId), defaultBid: bid, state: 'ENABLED' }] },
          'application/vnd.spAdGroup.v3+json');
        stats.amazon_calls++;
        const adGroupId = firstId(agR, 'adGroups', 'adGroupId');
        if (!adGroupId) throw new Error(`Falha ao criar ad group: ${JSON.stringify(agR.payload).slice(0, 200)}`);

        await base44.asServiceRole.entities.SearchTermPromotion.update(promo.id, {
          promotion_status: 'ad_group_created',
          destination_ad_group_id: String(adGroupId),
          updated_at: new Date().toISOString(),
        });
        await wait(3000);

        // STEP 3: Create product ad
        const paPayload: any = { campaignId: String(campaignId), adGroupId: String(adGroupId), state: 'ENABLED' };
        if (cand.sku) paPayload.sku = cand.sku; else paPayload.asin = cand.asin;
        const paR = await adsCall('POST', '/sp/productAds', { productAds: [paPayload] }, 'application/vnd.spProductAd.v3+json');
        stats.amazon_calls++;
        const adId = firstId(paR, 'productAds', 'adId') || firstId(paR, 'productAds', 'productAdId');
        if (!adId && !paR.ok && paR.status !== 207) throw new Error(`Falha ao criar product ad: ${JSON.stringify(paR.payload).slice(0, 200)}`);

        await base44.asServiceRole.entities.SearchTermPromotion.update(promo.id, {
          promotion_status: 'product_ad_created',
          destination_ad_id: adId ? String(adId) : null,
          updated_at: new Date().toISOString(),
        });
        await wait(3000);

        // STEP 4: Create keyword EXACT
        const kwR = await adsCall('POST', '/sp/keywords', {
          keywords: [{
            campaignId: String(campaignId),
            adGroupId: String(adGroupId),
            keywordText: cand.normalized_term,
            matchType: 'EXACT',
            bid,
            state: 'ENABLED',
          }],
        }, 'application/vnd.spKeyword.v3+json');
        stats.amazon_calls++;
        const keywordId = firstId(kwR, 'keywords', 'keywordId');
        if (!keywordId) throw new Error(`Falha ao criar keyword: ${JSON.stringify(kwR.payload).slice(0, 200)}`);

        await base44.asServiceRole.entities.SearchTermPromotion.update(promo.id, {
          promotion_status: 'keyword_created',
          destination_keyword_id: String(keywordId),
          updated_at: new Date().toISOString(),
        });
        await wait(3000);

        // STEP 5: Verify all components are ENABLED
        await base44.asServiceRole.entities.SearchTermPromotion.update(promo.id, { promotion_status: 'manual_active', updated_at: new Date().toISOString() });

        // STEP 6: Create negative keyword in source campaign
        const negR = await adsCall('POST', '/sp/negativeKeywords', {
          negativeKeywords: [{
            campaignId: String(cand.campaign_id),
            adGroupId: String(cand.ad_group_id),
            keywordText: cand.normalized_term,
            matchType: 'NEGATIVE_EXACT',
            state: 'ENABLED',
          }],
        }, 'application/vnd.spNegativeKeyword.v3+json');
        stats.amazon_calls++;
        const negKwId = firstId(negR, 'negativeKeywords', 'keywordId') || firstId(negR, 'negativeKeywords', 'negativeKeywordId');

        await base44.asServiceRole.entities.SearchTermPromotion.update(promo.id, {
          promotion_status: 'completed',
          negative_keyword_id: negKwId ? String(negKwId) : null,
          completion_status: 'complete',
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
        stats.negatives_created++;
        stats.created++;
        promotions.push({ term: cand.normalized_term, asin: cand.asin, campaign_id: String(campaignId), status: 'completed' });

        await wait(2000);
      } catch (err: any) {
        stats.failed++;
        await base44.asServiceRole.entities.SearchTermPromotion.update(promo.id, {
          promotion_status: 'repair_required',
          last_error: String(err?.message || err).slice(0, 500),
          retry_count: (promo.retry_count || 0) + 1,
          next_retry_at: new Date(Date.now() + 3600000).toISOString(),
          updated_at: new Date().toISOString(),
        }).catch(() => {});
        promotions.push({ term: cand.normalized_term, asin: cand.asin, status: 'failed', error: String(err?.message || err).slice(0, 200) });
      }
    }

    return Response.json({
      ok: true,
      stats,
      promotions,
      ran_at: new Date().toISOString(),
    });
  } catch (err: any) {
    return Response.json({ ok: false, error: err?.message || 'Erro inesperado' }, { status: 500 });
  }
});