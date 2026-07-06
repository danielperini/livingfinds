import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function adsBase(region: string | undefined) {
  const v = String(region || Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
  if (v.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (v.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function getToken(account: any) {
  const refreshToken = account.ads_refresh_token;
  if (!refreshToken || !refreshToken.startsWith('Atzr|')) throw new Error('ads_refresh_token inválido');
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: Deno.env.get('ADS_CLIENT_ID') || '',
      client_secret: Deno.env.get('ADS_CLIENT_SECRET') || '',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(data.error_description || 'Falha no token');
  return data.access_token;
}

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const user = await base44.auth.me();
    if (!user || user.role !== 'admin') return Response.json({ error: 'Admin only' }, { status: 403 });

    const body = await request.json().catch(() => ({}));
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

    async function adsCall(method: string, path: string, payload: any, contentType = 'application/vnd.spCampaign.v3+json') {
      const h = { ...authHeaders, 'Content-Type': contentType, Accept: contentType };
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: h,
        body: method !== 'GET' ? JSON.stringify(payload) : undefined,
      });
      const text = await res.text().catch(() => '');
      let parsed: any = {};
      try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
      return { ok: res.status >= 200 && res.status < 300, status: res.status, payload: parsed, errors: res.status >= 300 ? [{ code: String(res.status), message: text.slice(0, 300) }] : [] };
    }

    function listOf(result: any, key: string) {
      const p = result?.payload || result || {};
      if (Array.isArray(p?.[key])) return p[key];
      if (Array.isArray(p)) return p;
      return [];
    }

    function createdId(result: any, group: string, field: string) {
      const p = result?.payload || result || {};
      return p?.[group]?.success?.[0]?.[field] || p?.success?.[0]?.[field] || p?.[group]?.[0]?.[field] || null;
    }

    async function updateLocalCampaign(campaignId: string, fields: any) {
      const rows = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: accountId, campaign_id: String(campaignId) }, '-updated_at', 1).catch(() => []);
      if (rows[0]) await base44.asServiceRole.entities.Campaign.update(rows[0].id, fields).catch(() => {});
    }

    const asins: string[] = body.asins || [
      'B0GHP68127','B0GHP68126','B0GHP68125','B0GHP68124','B0GHP68123',
      'B0G1MZLYS9','B0FN4RCXY2','B0GHP958MV','B0FHX1HPMT','B0F45JG27L',
      'B0DJ3RGHK6','B0H59FPPKS','B0GR6GXS1B','B0GHP612B8','B0GNW1Q6V3'
    ];

    // Listar TODAS as campanhas SP (AUTO + MANUAL)
    const campResult = await adsCall('POST', '/sp/campaigns/list', {
      stateFilter: { include: ['ENABLED', 'PAUSED'] },
      maxResults: 500,
    });

    if (!campResult.ok) {
      return Response.json({ ok: false, error: campResult.errors?.[0]?.message || 'Falha ao listar campanhas', status: campResult.status, raw: campResult.payload });
    }

    const remoteCampaigns = listOf(campResult, 'campaigns');
    const products = await base44.asServiceRole.entities.Product.filter({ amazon_account_id: accountId }, '-updated_at', 5000).catch(() => []);
    const productByAsin = new Map(products.map((p: any) => [String(p.asin), p]));
    const results = [];

    for (const asin of asins) {
      const matches = remoteCampaigns.filter((c: any) => String(c.name || '').includes(asin));
      if (!matches.length) {
        results.push({ asin, ok: false, error: 'Campanha AUTO não encontrada na Amazon' });
        continue;
      }

      for (const campaign of matches) {
        const campaignId = String(campaign.campaignId);
        const product: any = productByAsin.get(asin) || {};
        const item: any = { asin, campaign_id: campaignId, campaign_name: campaign.name, repaired: [], already_ok: [] };

        try {
          // 1. Campanha ENABLED
          if (String(campaign.state || '').toUpperCase() !== 'ENABLED') {
            const r = await adsCall('PUT', '/sp/campaigns', { campaigns: [{ campaignId, state: 'ENABLED' }] });
            if (!r.ok && r.status !== 207) throw new Error(r.errors?.[0]?.message || 'Falha ao ativar campanha');
            item.repaired.push('campaign_enabled');
            await wait(14000);
          } else {
            item.already_ok.push('campaign');
          }

          // 2. Ad Group
          const agR = await adsCall('POST', '/sp/adGroups/list', {
            campaignIdFilter: { include: [campaignId] },
            stateFilter: { include: ['ENABLED', 'PAUSED'] },
            maxResults: 100,
          }, 'application/vnd.spAdGroup.v3+json');
          if (!agR.ok) throw new Error(agR.errors?.[0]?.message || 'Falha ao listar ad groups');

          const adGroups = listOf(agR, 'adGroups');
          let adGroup = adGroups.find((g: any) => String(g.state || '').toUpperCase() === 'ENABLED') || adGroups[0];

          if (!adGroup) {
            const cr = await adsCall('POST', '/sp/adGroups',
              { adGroups: [{ name: `AG | AUTO | ${asin}`, campaignId, defaultBid: 0.5, state: 'ENABLED' }] },
              'application/vnd.spAdGroup.v3+json');
            const agId = createdId(cr, 'adGroups', 'adGroupId');
            if (!agId) throw new Error(cr.errors?.[0]?.message || 'Amazon não retornou adGroupId');
            adGroup = { adGroupId: String(agId), state: 'ENABLED' };
            item.repaired.push('ad_group_created');
            await wait(14000);
          } else if (String(adGroup.state || '').toUpperCase() !== 'ENABLED') {
            await adsCall('PUT', '/sp/adGroups',
              { adGroups: [{ adGroupId: String(adGroup.adGroupId), state: 'ENABLED' }] },
              'application/vnd.spAdGroup.v3+json');
            item.repaired.push('ad_group_enabled');
            await wait(14000);
          } else {
            item.already_ok.push('ad_group');
          }

          // 3. Product Ad
          const adGroupId = String(adGroup.adGroupId);
          const paR = await adsCall('POST', '/sp/productAds/list', {
            campaignIdFilter: { include: [campaignId] },
            adGroupIdFilter: { include: [adGroupId] },
            stateFilter: { include: ['ENABLED', 'PAUSED', 'ARCHIVED'] },
            maxResults: 100,
          }, 'application/vnd.spProductAd.v3+json');
          if (!paR.ok) throw new Error(paR.errors?.[0]?.message || 'Falha ao listar product ads');

          const productAds = listOf(paR, 'productAds');
          let productAd = productAds.find((a: any) => String(a.state || '').toUpperCase() === 'ENABLED' && String(a.asin || '') === asin)
            || productAds.find((a: any) => String(a.state || '').toUpperCase() !== 'ARCHIVED');

          if (!productAd) {
            const cr = await adsCall('POST', '/sp/productAds',
              { productAds: [{ campaignId, adGroupId, ...(product.sku ? { sku: product.sku } : { asin }), state: 'ENABLED' }] },
              'application/vnd.spProductAd.v3+json');
            const paId = createdId(cr, 'productAds', 'adId') || createdId(cr, 'productAds', 'productAdId');
            if (!paId && !cr.ok && cr.status !== 207) throw new Error(cr.errors?.[0]?.message || 'Falha ao criar product ad');
            productAd = { adId: paId };
            item.repaired.push('product_ad_created');
            await wait(14000);
          } else if (String(productAd.state || '').toUpperCase() !== 'ENABLED') {
            await adsCall('PUT', '/sp/productAds',
              { productAds: [{ adId: String(productAd.adId || productAd.productAdId), state: 'ENABLED' }] },
              'application/vnd.spProductAd.v3+json');
            item.repaired.push('product_ad_enabled');
            await wait(14000);
          } else {
            item.already_ok.push('product_ad');
          }

          item.ok = true;
          item.ad_group_id = adGroupId;
          await updateLocalCampaign(campaignId, {
            completion_status: 'complete',
            is_incomplete: false,
            ad_group_id: adGroupId,
            repair_status: item.repaired.length ? 'repaired' : 'verified',
            repaired_at: new Date().toISOString(),
            last_repair_error: null,
          });
        } catch (err: any) {
          item.ok = false;
          item.error = err?.message || String(err);
          await updateLocalCampaign(campaignId, {
            completion_status: 'incomplete',
            is_incomplete: true,
            repair_status: 'failed',
            last_repair_error: item.error.slice(0, 500),
          });
        }

        results.push(item);
        await wait(3000);
      }
    }

    return Response.json({
      ok: results.every(r => r.ok),
      total: results.length,
      repaired: results.filter(r => r.repaired?.length).length,
      already_ok: results.filter(r => r.ok && !r.repaired?.length).length,
      failed: results.filter(r => !r.ok).length,
      results,
    });
  } catch (err: any) {
    return Response.json({ ok: false, error: err?.message || 'Erro inesperado' }, { status: 500 });
  }
});