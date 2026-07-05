// v2 — lógica de chamada Amazon inlinada (sem invoke intermediário)
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function adsBase(region: string | undefined) {
  const value = String(region || Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
  if (value.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (value.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function getAccessToken(account: any): Promise<string> {
  const entityToken = account.ads_refresh_token;
  if (!entityToken || !entityToken.startsWith('Atzr|')) {
    throw new Error('Token Amazon Ads não configurado. Reconecte a conta em Integrações → Amazon.');
  }
  const clientId = Deno.env.get('ADS_CLIENT_ID') || '';
  const secret = Deno.env.get('ADS_CLIENT_SECRET') || '';
  if (!clientId || !secret) throw new Error('Credenciais ADS_CLIENT_ID/ADS_CLIENT_SECRET ausentes');
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: entityToken,
      client_id: clientId,
      client_secret: secret,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || 'Falha no token Amazon Ads');
  }
  return data.access_token;
}

async function adsCall(baseUrl: string, token: string, clientId: string, profileId: string, method: string, path: string, contentType: string, payload: any): Promise<any> {
  const url = `${baseUrl}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': clientId,
      'Amazon-Advertising-API-Scope': String(profileId),
      'Content-Type': contentType,
      Accept: contentType,
    },
    signal: controller.signal,
    body: payload == null || method === 'GET' ? undefined : JSON.stringify(payload),
  }).finally(() => clearTimeout(timeout));

  const text = await response.text().catch(() => '');
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }

  const ok = response.status >= 200 && response.status < 300;
  return {
    ok,
    status: response.status,
    payload: parsed,
    errors: ok ? [] : [{ code: String(response.status), message: text.slice(0, 300) }],
  };
}

function listOf(result: any, key: string): any[] {
  const p = result?.payload || result || {};
  if (Array.isArray(p?.[key])) return p[key];
  if (Array.isArray(p)) return p;
  return [];
}

function createdId(result: any, group: string, field: string): string | null {
  const p = result?.payload || result || {};
  return p?.[group]?.success?.[0]?.[field]
    || p?.success?.[0]?.[field]
    || p?.[group]?.[0]?.[field]
    || null;
}

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    if (!body._service_role) return Response.json({ ok: false, error: 'Uso interno' }, { status: 403 });

    const accountId = body.amazon_account_id;
    const campaignId = String(body.campaign_id || '').trim();
    const asin = String(body.asin || '').trim().toUpperCase();
    const sku = String(body.sku || '').trim();

    if (!accountId || !campaignId || (!asin && !sku)) {
      return Response.json({ ok: false, error: 'amazon_account_id, campaign_id e asin ou sku são obrigatórios' }, { status: 400 });
    }

    // Buscar conta no banco
    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ id: accountId }, null, 1);
    const account = accounts[0];
    if (!account) return Response.json({ ok: false, error: 'Conta Amazon não encontrada' }, { status: 404 });

    // Buscar campanha local
    const localRows = await base44.asServiceRole.entities.Campaign.filter({
      amazon_account_id: accountId,
      campaign_id: campaignId,
    }, '-updated_date', 1).catch(() => []);
    const localCampaign = localRows[0] || null;

    // Autenticar diretamente
    const token = await getAccessToken(account);
    const profileId = String(account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID') || '');
    const clientId = Deno.env.get('ADS_CLIENT_ID') || '';
    const base = adsBase(account.region);
    const CT_CAMPAIGN = 'application/vnd.spCampaign.v3+json';
    const CT_ADGROUP = 'application/vnd.spAdGroup.v3+json';
    const CT_PRODUCTAD = 'application/vnd.spProductAd.v3+json';

    // 1. Verificar campanha na Amazon
    const campaignResult = await adsCall(base, token, clientId, profileId, 'POST', '/sp/campaigns/list', CT_CAMPAIGN, {
      campaignIdFilter: { include: [campaignId] },
      stateFilter: { include: ['ENABLED', 'PAUSED', 'ARCHIVED'] },
      maxResults: 10,
    });

    const campaign = listOf(campaignResult, 'campaigns').find((item: any) => String(item.campaignId) === campaignId);
    if (!campaign) {
      throw new Error(`Campanha ${campaignId} não encontrada na Amazon (ASIN: ${asin}).`);
    }

    const repaired: string[] = [];
    const alreadyComplete: string[] = [];

    // 2. Ativar campanha se necessário
    if (String(campaign.state || '').toUpperCase() !== 'ENABLED') {
      const enabled = await adsCall(base, token, clientId, profileId, 'PUT', '/sp/campaigns', CT_CAMPAIGN, {
        campaigns: [{ campaignId, state: 'ENABLED' }],
      });
      if (!enabled?.ok && enabled?.status !== 207) throw new Error(enabled?.errors?.[0]?.message || 'Falha ao ativar campanha');
      repaired.push('campaign_enabled');
      await wait(14000);
    } else {
      alreadyComplete.push('campaign_enabled');
    }

    // 3. Verificar/criar ad group
    const adGroupsResult = await adsCall(base, token, clientId, profileId, 'POST', '/sp/adGroups/list', CT_ADGROUP, {
      campaignIdFilter: { include: [campaignId] },
      stateFilter: { include: ['ENABLED', 'PAUSED', 'ARCHIVED'] },
      maxResults: 100,
    });
    if (!adGroupsResult?.ok) throw new Error(adGroupsResult?.errors?.[0]?.message || 'Falha ao listar grupos de anúncios');

    let adGroup = listOf(adGroupsResult, 'adGroups').find((g: any) => String(g.state || '').toUpperCase() === 'ENABLED')
      || listOf(adGroupsResult, 'adGroups').find((g: any) => String(g.state || '').toUpperCase() !== 'ARCHIVED');

    if (!adGroup) {
      const created = await adsCall(base, token, clientId, profileId, 'POST', '/sp/adGroups', CT_ADGROUP, {
        adGroups: [{ name: `AG | AUTO | ${asin || sku}`, campaignId, defaultBid: 0.5, state: 'ENABLED' }],
      });
      const adGroupId = createdId(created, 'adGroups', 'adGroupId');
      if (!adGroupId) throw new Error(created?.errors?.[0]?.message || 'Amazon não retornou adGroupId');
      adGroup = { adGroupId: String(adGroupId), state: 'ENABLED' };
      repaired.push('ad_group_created');
      await wait(14000);
    } else if (String(adGroup.state || '').toUpperCase() !== 'ENABLED') {
      const enabled = await adsCall(base, token, clientId, profileId, 'PUT', '/sp/adGroups', CT_ADGROUP, {
        adGroups: [{ adGroupId: String(adGroup.adGroupId), state: 'ENABLED' }],
      });
      if (!enabled?.ok && enabled?.status !== 207) throw new Error(enabled?.errors?.[0]?.message || 'Falha ao ativar grupo de anúncios');
      repaired.push('ad_group_enabled');
      await wait(14000);
    } else {
      alreadyComplete.push('ad_group');
    }

    const adGroupId = String(adGroup.adGroupId);

    // 4. Verificar/criar product ad
    const productAdsResult = await adsCall(base, token, clientId, profileId, 'POST', '/sp/productAds/list', CT_PRODUCTAD, {
      campaignIdFilter: { include: [campaignId] },
      adGroupIdFilter: { include: [adGroupId] },
      stateFilter: { include: ['ENABLED', 'PAUSED', 'ARCHIVED'] },
      maxResults: 100,
    });
    if (!productAdsResult?.ok) throw new Error(productAdsResult?.errors?.[0]?.message || 'Falha ao listar anúncios de produto');

    let productAd = listOf(productAdsResult, 'productAds').find((ad: any) =>
      String(ad.state || '').toUpperCase() === 'ENABLED' &&
      ((asin && String(ad.asin || '').toUpperCase() === asin) || (sku && String(ad.sku || '').toLowerCase() === sku.toLowerCase()))
    ) || listOf(productAdsResult, 'productAds').find((ad: any) => String(ad.state || '').toUpperCase() !== 'ARCHIVED');

    if (!productAd) {
      const created = await adsCall(base, token, clientId, profileId, 'POST', '/sp/productAds', CT_PRODUCTAD, {
        productAds: [{ campaignId, adGroupId, ...(sku ? { sku } : { asin }), state: 'ENABLED' }],
      });
      const productAdId = createdId(created, 'productAds', 'adId') || createdId(created, 'productAds', 'productAdId');
      if (!productAdId && !created?.ok && created?.status !== 207) {
        throw new Error(created?.errors?.[0]?.message || 'Falha ao criar anúncio de produto');
      }
      productAd = { adId: productAdId || null, state: 'ENABLED' };
      repaired.push('product_ad_created');
      await wait(14000);
    } else if (String(productAd.state || '').toUpperCase() !== 'ENABLED') {
      const enabled = await adsCall(base, token, clientId, profileId, 'PUT', '/sp/productAds', CT_PRODUCTAD, {
        productAds: [{ adId: String(productAd.adId || productAd.productAdId), state: 'ENABLED' }],
      });
      if (!enabled?.ok && enabled?.status !== 207) throw new Error(enabled?.errors?.[0]?.message || 'Falha ao ativar anúncio de produto');
      repaired.push('product_ad_enabled');
      await wait(14000);
    } else {
      alreadyComplete.push('product_ad');
    }

    // 5. Atualizar banco local
    if (localCampaign) {
      await base44.asServiceRole.entities.Campaign.update(localCampaign.id, {
        asin: asin || localCampaign.asin || null,
        state: 'enabled',
        status: 'enabled',
        is_operational: true,
        requires_attention: false,
        repair_status: repaired.length ? 'repaired' : 'verified',
        repaired_at: new Date().toISOString(),
        last_repair_error: null,
      }).catch(() => {});
    }

    return Response.json({
      ok: true,
      complete: true,
      asin: asin || null,
      sku: sku || null,
      campaign_id: campaignId,
      campaign_name: campaign.name || localCampaign?.name || null,
      repaired,
      already_complete: alreadyComplete,
      ad_group_id: adGroupId,
      product_ad_id: String(productAd?.adId || productAd?.productAdId || '') || null,
    });
  } catch (error: any) {
    return Response.json({ ok: false, complete: false, error: error?.message || 'Erro ao reparar campanha AUTO por ID' }, { status: 500 });
  }
});