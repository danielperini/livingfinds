import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function ads(base44: any, accountId: string, operation: string, method: string, path: string, payload: any, contentType: string) {
  const response = await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
    amazon_account_id: accountId,
    operation,
    method,
    path,
    payload,
    content_type: contentType,
    accept: contentType,
    _service_role: true,
  });
  return response?.data || response || {};
}

function payloadOf(result: any) {
  return result?.payload || result || {};
}

function listOf(result: any, key: string) {
  const payload = payloadOf(result);
  if (Array.isArray(payload?.[key])) return payload[key];
  if (Array.isArray(payload)) return payload;
  return [];
}

function createdId(result: any, group: string, field: string) {
  const payload = payloadOf(result);
  return payload?.[group]?.success?.[0]?.[field]
    || payload?.success?.[0]?.[field]
    || payload?.[group]?.[0]?.[field]
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

    const localRows = await base44.asServiceRole.entities.Campaign.filter({
      amazon_account_id: accountId,
      campaign_id: campaignId,
    }, '-updated_at', 1).catch(() => []);
    const localCampaign = localRows[0] || null;

    const campaignResult = await ads(base44, accountId, 'getAutoCampaignByIdForRepair', 'POST', '/sp/campaigns/list', {
      campaignIdFilter: [campaignId],
      stateFilter: { include: ['ENABLED', 'PAUSED', 'ARCHIVED'] },
      maxResults: 10,
    }, 'application/vnd.spCampaign.v3+json');

    const campaign = listOf(campaignResult, 'campaigns').find((item: any) => String(item.campaignId) === campaignId);
    if (!campaign) {
      throw new Error('Campanha não encontrada na Amazon pelo campaign_id.');
    }

    const repaired: string[] = [];
    const alreadyComplete: string[] = [];

    if (String(campaign.state || '').toUpperCase() !== 'ENABLED') {
      const enabled = await ads(base44, accountId, 'enableAutoCampaignById', 'PUT', '/sp/campaigns', {
        campaigns: [{ campaignId, state: 'ENABLED' }],
      }, 'application/vnd.spCampaign.v3+json');
      if (!enabled?.ok && enabled?.status !== 207) throw new Error(enabled?.errors?.[0]?.message || 'Falha ao ativar campanha');
      repaired.push('campaign_enabled');
      await wait(14000);
    } else {
      alreadyComplete.push('campaign_enabled');
    }

    const adGroupsResult = await ads(base44, accountId, 'listAdGroupsByCampaignIdForRepair', 'POST', '/sp/adGroups/list', {
      campaignIdFilter: [campaignId],
      stateFilter: { include: ['ENABLED', 'PAUSED', 'ARCHIVED'] },
      maxResults: 100,
    }, 'application/vnd.spAdGroup.v3+json');
    if (!adGroupsResult?.ok) throw new Error(adGroupsResult?.errors?.[0]?.message || 'Falha ao listar grupos de anúncios');

    let adGroup = listOf(adGroupsResult, 'adGroups').find((group: any) => String(group.state || '').toUpperCase() === 'ENABLED')
      || listOf(adGroupsResult, 'adGroups').find((group: any) => String(group.state || '').toUpperCase() !== 'ARCHIVED');

    if (!adGroup) {
      const created = await ads(base44, accountId, 'createMissingAutoAdGroupByCampaignId', 'POST', '/sp/adGroups', {
        adGroups: [{ name: `AG | AUTO | ${asin || sku}`, campaignId, defaultBid: 0.5, state: 'ENABLED' }],
      }, 'application/vnd.spAdGroup.v3+json');
      const adGroupId = createdId(created, 'adGroups', 'adGroupId');
      if (!adGroupId) throw new Error(created?.errors?.[0]?.message || 'Amazon não retornou adGroupId');
      adGroup = { adGroupId: String(adGroupId), state: 'ENABLED' };
      repaired.push('ad_group_created');
      await wait(14000);
    } else if (String(adGroup.state || '').toUpperCase() !== 'ENABLED') {
      const adGroupId = String(adGroup.adGroupId);
      const enabled = await ads(base44, accountId, 'enableAutoAdGroupById', 'PUT', '/sp/adGroups', {
        adGroups: [{ adGroupId, state: 'ENABLED' }],
      }, 'application/vnd.spAdGroup.v3+json');
      if (!enabled?.ok && enabled?.status !== 207) throw new Error(enabled?.errors?.[0]?.message || 'Falha ao ativar grupo de anúncios');
      repaired.push('ad_group_enabled');
      await wait(14000);
    } else {
      alreadyComplete.push('ad_group');
    }

    const adGroupId = String(adGroup.adGroupId);
    const productAdsResult = await ads(base44, accountId, 'listProductAdsByCampaignIdForRepair', 'POST', '/sp/productAds/list', {
      campaignIdFilter: [campaignId],
      adGroupIdFilter: [adGroupId],
      stateFilter: { include: ['ENABLED', 'PAUSED', 'ARCHIVED'] },
      maxResults: 100,
    }, 'application/vnd.spProductAd.v3+json');
    if (!productAdsResult?.ok) throw new Error(productAdsResult?.errors?.[0]?.message || 'Falha ao listar anúncios de produto');

    let productAd = listOf(productAdsResult, 'productAds').find((ad: any) =>
      String(ad.state || '').toUpperCase() === 'ENABLED' &&
      ((asin && String(ad.asin || '').toUpperCase() === asin) || (sku && String(ad.sku || '').toLowerCase() === sku.toLowerCase()))
    ) || listOf(productAdsResult, 'productAds').find((ad: any) => String(ad.state || '').toUpperCase() !== 'ARCHIVED');

    if (!productAd) {
      const created = await ads(base44, accountId, 'createMissingAutoProductAdByCampaignId', 'POST', '/sp/productAds', {
        productAds: [{ campaignId, adGroupId, ...(sku ? { sku } : { asin }), state: 'ENABLED' }],
      }, 'application/vnd.spProductAd.v3+json');
      const productAdId = createdId(created, 'productAds', 'adId') || createdId(created, 'productAds', 'productAdId');
      if (!productAdId && !created?.ok && created?.status !== 207) {
        throw new Error(created?.errors?.[0]?.message || 'Falha ao criar anúncio de produto');
      }
      productAd = { adId: productAdId || null, state: 'ENABLED' };
      repaired.push('product_ad_created');
      await wait(14000);
    } else if (String(productAd.state || '').toUpperCase() !== 'ENABLED') {
      const adId = String(productAd.adId || productAd.productAdId);
      const enabled = await ads(base44, accountId, 'enableAutoProductAdById', 'PUT', '/sp/productAds', {
        productAds: [{ adId, state: 'ENABLED' }],
      }, 'application/vnd.spProductAd.v3+json');
      if (!enabled?.ok && enabled?.status !== 207) throw new Error(enabled?.errors?.[0]?.message || 'Falha ao ativar anúncio de produto');
      repaired.push('product_ad_enabled');
      await wait(14000);
    } else {
      alreadyComplete.push('product_ad');
    }

    if (localCampaign) {
      await base44.asServiceRole.entities.Campaign.update(localCampaign.id, {
        asin: asin || localCampaign.asin || null,
        sku: sku || localCampaign.sku || null,
        completion_status: 'complete',
        is_incomplete: false,
        ad_group_id: adGroupId,
        product_ad_id: String(productAd?.adId || productAd?.productAdId || '') || null,
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
  } catch (error) {
    return Response.json({ ok: false, complete: false, error: error?.message || 'Erro ao reparar campanha AUTO por ID' }, { status: 500 });
  }
});