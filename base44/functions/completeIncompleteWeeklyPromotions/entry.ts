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

function firstId(result: any, group: string, field: string) {
  const p = result?.payload || result || {};
  return p?.[group]?.success?.[0]?.[field]
    || p?.success?.[0]?.[field]
    || p?.[group]?.[0]?.[field]
    || null;
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

    // Load incomplete promotions
    const incomplete = await base44.asServiceRole.entities.SearchTermPromotion.filter({
      amazon_account_id: accountId,
    }, '-created_at', 500);

    const toRepair = incomplete.filter((p: any) =>
      ['repair_required', 'failed_retryable', 'campaign_creating', 'campaign_created',
       'ad_group_created', 'product_ad_created', 'keyword_created', 'enabling',
       'manual_active', 'negative_creating'].includes(p.promotion_status)
      && (p.retry_count || 0) < 5
    );

    const stats = { repaired: 0, negatives_created: 0, failed: 0, skipped: 0 };

    for (const promo of toRepair) {
      try {
        const bid = promo.target_bid || 0.5;
        const asin = promo.asin;
        const norm = promo.normalized_search_term || promo.source_search_term;

        // Resume from last confirmed state
        let campaignId = promo.destination_campaign_id;
        let adGroupId = promo.destination_ad_group_id;
        let adId = promo.destination_ad_id;
        let keywordId = promo.destination_keyword_id;

        // Step: create campaign if missing
        if (!campaignId) {
          const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
          const campName = `EXACT | ${asin} | ${norm.slice(0, 60)} | ${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6,8)}`.slice(0, 128);
          const campR = await adsCall('POST', '/sp/campaigns', {
            campaigns: [{ name: campName, targetingType: 'MANUAL', state: 'ENABLED', startDate: date, dailyBudget: 5.0, budgetType: 'DAILY' }],
          });
          campaignId = firstId(campR, 'campaigns', 'campaignId');
          if (!campaignId) throw new Error('Falha ao recriar campanha');
          await base44.asServiceRole.entities.SearchTermPromotion.update(promo.id, {
            promotion_status: 'campaign_created',
            destination_campaign_id: String(campaignId),
            destination_campaign_name: campName,
            updated_at: new Date().toISOString(),
          });
          await wait(3000);
        }

        // Step: create ad group if missing
        if (!adGroupId) {
          const agR = await adsCall('POST', '/sp/adGroups',
            { adGroups: [{ name: `AG | ${asin} | EXACT`, campaignId: String(campaignId), defaultBid: bid, state: 'ENABLED' }] },
            'application/vnd.spAdGroup.v3+json');
          adGroupId = firstId(agR, 'adGroups', 'adGroupId');
          if (!adGroupId) throw new Error('Falha ao recriar ad group');
          await base44.asServiceRole.entities.SearchTermPromotion.update(promo.id, {
            promotion_status: 'ad_group_created',
            destination_ad_group_id: String(adGroupId),
            updated_at: new Date().toISOString(),
          });
          await wait(3000);
        }

        // Step: create product ad if missing
        if (!adId) {
          const paPayload: any = { campaignId: String(campaignId), adGroupId: String(adGroupId), state: 'ENABLED' };
          if (promo.sku) paPayload.sku = promo.sku; else paPayload.asin = asin;
          const paR = await adsCall('POST', '/sp/productAds', { productAds: [paPayload] }, 'application/vnd.spProductAd.v3+json');
          adId = firstId(paR, 'productAds', 'adId') || firstId(paR, 'productAds', 'productAdId');
          await base44.asServiceRole.entities.SearchTermPromotion.update(promo.id, {
            promotion_status: 'product_ad_created',
            destination_ad_id: adId ? String(adId) : null,
            updated_at: new Date().toISOString(),
          });
          await wait(3000);
        }

        // Step: create keyword if missing
        if (!keywordId) {
          const kwR = await adsCall('POST', '/sp/keywords', {
            keywords: [{ campaignId: String(campaignId), adGroupId: String(adGroupId), keywordText: norm, matchType: 'EXACT', bid, state: 'ENABLED' }],
          }, 'application/vnd.spKeyword.v3+json');
          keywordId = firstId(kwR, 'keywords', 'keywordId');
          if (!keywordId) throw new Error('Falha ao recriar keyword');
          await base44.asServiceRole.entities.SearchTermPromotion.update(promo.id, {
            promotion_status: 'keyword_created',
            destination_keyword_id: String(keywordId),
            updated_at: new Date().toISOString(),
          });
          await wait(3000);
        }

        // Step: create negative if missing and campaign is complete
        if (!promo.negative_keyword_id && promo.source_campaign_id) {
          const negR = await adsCall('POST', '/sp/negativeKeywords', {
            negativeKeywords: [{
              campaignId: String(promo.source_campaign_id),
              adGroupId: String(promo.source_ad_group_id),
              keywordText: norm,
              matchType: 'NEGATIVE_EXACT',
              state: 'ENABLED',
            }],
          }, 'application/vnd.spNegativeKeyword.v3+json');
          const negKwId = firstId(negR, 'negativeKeywords', 'keywordId') || firstId(negR, 'negativeKeywords', 'negativeKeywordId');
          await base44.asServiceRole.entities.SearchTermPromotion.update(promo.id, {
            promotion_status: 'completed',
            negative_keyword_id: negKwId ? String(negKwId) : null,
            completion_status: 'complete',
            completed_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });
          stats.negatives_created++;
        } else if (promo.negative_keyword_id) {
          await base44.asServiceRole.entities.SearchTermPromotion.update(promo.id, {
            promotion_status: 'completed',
            completion_status: 'complete',
            completed_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });
        }

        stats.repaired++;
        await wait(2000);
      } catch (err: any) {
        stats.failed++;
        await base44.asServiceRole.entities.SearchTermPromotion.update(promo.id, {
          last_error: String(err?.message || err).slice(0, 500),
          retry_count: (promo.retry_count || 0) + 1,
          next_retry_at: new Date(Date.now() + 3600000).toISOString(),
          updated_at: new Date().toISOString(),
          promotion_status: (promo.retry_count || 0) >= 4 ? 'failed_permanent' : 'repair_required',
        }).catch(() => {});
      }
    }

    return Response.json({ ok: true, stats, ran_at: new Date().toISOString() });
  } catch (err: any) {
    return Response.json({ ok: false, error: err?.message || 'Erro inesperado' }, { status: 500 });
  }
});