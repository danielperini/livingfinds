import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const DEFAULT_ASINS = [
  'B0GFQ5YT3H','B0FRVMB7BW','B0GNW1Q6V3','B0FCYPPG2M','B0GHP612B8','B0F4ZBBB9G','B0H59FPPKS',
  'B0F45JG27L','B0FVW1TV6Y','B0GR6GXS1B','B0GFQ7SY5W','B0DJ3RGHK6','B0FHX1HPMT'
];

function brazilHour() {
  const parts = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false }).formatToParts(new Date());
  return Number(parts.find((part) => part.type === 'hour')?.value || 0);
}

function inWindow() {
  return [0, 1, 2, 3, 13].includes(brazilHour());
}

function nextSlot() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const p = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const hour = Number(p.hour || 0);
  const day = `${p.year}-${p.month}-${p.day}`;
  if (hour < 3) {
    const h = hour + 1;
    return { hour: h, window: `${String(h).padStart(2,'0')}:00-${String(h + 1).padStart(2,'0')}:00`, at: new Date(`${day}T${String(h).padStart(2,'0')}:00:00-03:00`) };
  }
  if (hour < 13) return { hour: 13, window: '13:00-14:00', at: new Date(`${day}T13:00:00-03:00`) };
  const tomorrow = new Date(`${day}T12:00:00-03:00`);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const nextDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(tomorrow);
  return { hour: 0, window: '00:00-01:00', at: new Date(`${nextDay}T00:00:00-03:00`) };
}

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

function isThrottle(result: any) {
  const text = JSON.stringify(result || '').toLowerCase();
  return result?.status === 429 || result?.circuit_open || text.includes('rate limit') || text.includes('too many requests') || text.includes('throttl');
}

async function queueRepair(base44: any, accountId: string, asin: string, campaign: any = null) {
  const slot = nextSlot();
  const existing = await base44.asServiceRole.entities.AutoCampaignRepairQueue.filter({
    amazon_account_id: accountId,
    asin,
    status: 'scheduled',
  }, '-created_date', 1).catch(() => []);

  if (!existing.length) {
    await base44.asServiceRole.entities.AutoCampaignRepairQueue.create({
      amazon_account_id: accountId,
      asin,
      campaign_id: campaign?.campaignId ? String(campaign.campaignId) : null,
      campaign_name: campaign?.name || null,
      status: 'scheduled',
      queue_hour: slot.hour,
      queue_window: slot.window,
      scheduled_at: slot.at.toISOString(),
      attempt_count: 0,
      max_attempts: 5,
    });
  }
  return slot;
}

async function updateLocalCampaign(base44: any, accountId: string, campaignId: string, fields: any) {
  const rows = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: accountId, campaign_id: String(campaignId) }, '-updated_at', 1).catch(() => []);
  if (rows[0]) await base44.asServiceRole.entities.Campaign.update(rows[0].id, fields).catch(() => {});
}

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    const body = await request.json().catch(() => ({}));
    if (!authenticated && !body._service_role) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });

    const accountId = body.amazon_account_id;
    if (!accountId) return Response.json({ ok: false, error: 'amazon_account_id obrigatório' }, { status: 400 });
    const asins = [...new Set((Array.isArray(body.asins) && body.asins.length ? body.asins : DEFAULT_ASINS).map((value: any) => String(value).trim()).filter(Boolean))];

    if (!body._window_execution && !inWindow()) {
      const queued = [];
      for (const asin of asins) {
        const slot = await queueRepair(base44, accountId, asin);
        queued.push({ asin, queue_window: slot.window, scheduled_at: slot.at.toISOString() });
      }
      return Response.json({ ok: true, scheduled: true, queued: queued.length, results: queued, message: 'Reparo programado para a próxima janela Amazon, com intervalo de 14 segundos.' });
    }

    const campaignResult = await ads(base44, accountId, 'listAutoCampaignsForRepair', 'POST', '/sp/campaigns/list', {
      stateFilter: { include: ['ENABLED', 'PAUSED'] },
      targetingTypeFilter: ['AUTO'],
      maxResults: 500,
    }, 'application/vnd.spCampaign.v3+json');

    if (!campaignResult?.ok) {
      if (isThrottle(campaignResult)) {
        const queued = [];
        for (const asin of asins) {
          const slot = await queueRepair(base44, accountId, asin);
          queued.push({ asin, queue_window: slot.window });
        }
        return Response.json({ ok: true, scheduled: true, queued: queued.length, results: queued, message: 'A Amazon limitou as chamadas. O reparo foi mantido para a próxima janela.' });
      }
      return Response.json({ ok: false, error: campaignResult?.errors?.[0]?.message || 'Falha ao listar campanhas AUTO' });
    }

    const remoteCampaigns = listOf(campaignResult, 'campaigns');
    const products = await base44.asServiceRole.entities.Product.filter({ amazon_account_id: accountId }, '-updated_at', 5000).catch(() => []);
    const productByAsin = new Map(products.map((product: any) => [String(product.asin), product]));
    const results = [];

    for (const asin of asins) {
      const matches = remoteCampaigns.filter((campaign: any) => String(campaign.name || '').includes(asin));
      if (!matches.length) {
        results.push({ asin, ok: false, missing_campaign: true, error: 'Campanha AUTO não encontrada na Amazon' });
        continue;
      }

      for (const campaign of matches) {
        const campaignId = String(campaign.campaignId);
        const product = productByAsin.get(asin) || {};
        const item: any = { asin, campaign_id: campaignId, campaign_name: campaign.name, repaired: [], already_complete: [] };

        try {
          if (String(campaign.state || '').toUpperCase() !== 'ENABLED') {
            const enabled = await ads(base44, accountId, 'enableAutoCampaignDuringRepair', 'PUT', '/sp/campaigns', {
              campaigns: [{ campaignId, state: 'ENABLED' }],
            }, 'application/vnd.spCampaign.v3+json');
            if (!enabled?.ok && enabled?.status !== 207) throw new Error(enabled?.errors?.[0]?.message || 'Falha ao ativar campanha');
            item.repaired.push('campaign_enabled');
            await wait(14000);
          } else {
            item.already_complete.push('campaign_enabled');
          }

          const adGroupsResult = await ads(base44, accountId, 'listAdGroupsForAutoRepair', 'POST', '/sp/adGroups/list', {
            campaignIdFilter: [campaignId],
            stateFilter: { include: ['ENABLED', 'PAUSED'] },
            maxResults: 100,
          }, 'application/vnd.spAdGroup.v3+json');
          if (!adGroupsResult?.ok) throw new Error(adGroupsResult?.errors?.[0]?.message || 'Falha ao listar ad groups');

          let adGroups = listOf(adGroupsResult, 'adGroups');
          let adGroup = adGroups.find((group: any) => String(group.state || '').toUpperCase() === 'ENABLED') || adGroups[0];

          if (!adGroup) {
            const created = await ads(base44, accountId, 'createMissingAutoAdGroup', 'POST', '/sp/adGroups', {
              adGroups: [{ name: `AG | AUTO | ${asin}`, campaignId, defaultBid: 0.5, state: 'ENABLED' }],
            }, 'application/vnd.spAdGroup.v3+json');
            const adGroupId = createdId(created, 'adGroups', 'adGroupId');
            if (!adGroupId) throw new Error(created?.errors?.[0]?.message || 'Amazon não retornou adGroupId');
            adGroup = { adGroupId: String(adGroupId), state: 'ENABLED' };
            item.repaired.push('ad_group_created');
            await wait(14000);
          } else if (String(adGroup.state || '').toUpperCase() !== 'ENABLED') {
            const enabled = await ads(base44, accountId, 'enableAutoAdGroupDuringRepair', 'PUT', '/sp/adGroups', {
              adGroups: [{ adGroupId: String(adGroup.adGroupId), state: 'ENABLED' }],
            }, 'application/vnd.spAdGroup.v3+json');
            if (!enabled?.ok && enabled?.status !== 207) throw new Error(enabled?.errors?.[0]?.message || 'Falha ao ativar ad group');
            item.repaired.push('ad_group_enabled');
            await wait(14000);
          } else {
            item.already_complete.push('ad_group');
          }

          const adGroupId = String(adGroup.adGroupId);
          const productAdsResult = await ads(base44, accountId, 'listProductAdsForAutoRepair', 'POST', '/sp/productAds/list', {
            campaignIdFilter: [campaignId],
            adGroupIdFilter: [adGroupId],
            stateFilter: { include: ['ENABLED', 'PAUSED', 'ARCHIVED'] },
            maxResults: 100,
          }, 'application/vnd.spProductAd.v3+json');
          if (!productAdsResult?.ok) throw new Error(productAdsResult?.errors?.[0]?.message || 'Falha ao listar product ads');

          let productAds = listOf(productAdsResult, 'productAds');
          let productAd = productAds.find((ad: any) => String(ad.state || '').toUpperCase() === 'ENABLED' && (String(ad.asin || '') === asin || String(ad.sku || '') === String(product.sku || '')))
            || productAds.find((ad: any) => String(ad.state || '').toUpperCase() !== 'ARCHIVED');

          if (!productAd) {
            const created = await ads(base44, accountId, 'createMissingAutoProductAd', 'POST', '/sp/productAds', {
              productAds: [{ campaignId, adGroupId, ...(product.sku ? { sku: product.sku } : { asin }), state: 'ENABLED' }],
            }, 'application/vnd.spProductAd.v3+json');
            const productAdId = createdId(created, 'productAds', 'adId') || createdId(created, 'productAds', 'productAdId');
            if (!productAdId && !created?.ok && created?.status !== 207) throw new Error(created?.errors?.[0]?.message || 'Falha ao criar product ad');
            productAd = { adId: productAdId || null, state: 'ENABLED' };
            item.repaired.push('product_ad_created');
            await wait(14000);
          } else if (String(productAd.state || '').toUpperCase() !== 'ENABLED') {
            const enabled = await ads(base44, accountId, 'enableAutoProductAdDuringRepair', 'PUT', '/sp/productAds', {
              productAds: [{ adId: String(productAd.adId || productAd.productAdId), state: 'ENABLED' }],
            }, 'application/vnd.spProductAd.v3+json');
            if (!enabled?.ok && enabled?.status !== 207) throw new Error(enabled?.errors?.[0]?.message || 'Falha ao ativar product ad');
            item.repaired.push('product_ad_enabled');
            await wait(14000);
          } else {
            item.already_complete.push('product_ad');
          }

          item.ok = true;
          item.complete = true;
          item.ad_group_id = adGroupId;
          item.product_ad_id = String(productAd?.adId || productAd?.productAdId || '');
          await updateLocalCampaign(base44, accountId, campaignId, {
            completion_status: 'complete',
            is_incomplete: false,
            ad_group_id: adGroupId,
            product_ad_id: item.product_ad_id || null,
            repair_status: item.repaired.length ? 'repaired' : 'verified',
            repaired_at: new Date().toISOString(),
            last_repair_error: null,
          });
        } catch (error) {
          item.ok = false;
          item.complete = false;
          item.error = error?.message || String(error);
          await updateLocalCampaign(base44, accountId, campaignId, {
            completion_status: 'incomplete',
            is_incomplete: true,
            repair_status: 'failed',
            last_repair_error: item.error.slice(0, 500),
            repaired_at: new Date().toISOString(),
          });

          if (isThrottle(error)) {
            const slot = await queueRepair(base44, accountId, asin, campaign);
            item.retry_scheduled = true;
            item.queue_window = slot.window;
          }
        }

        results.push(item);
        await wait(14000);
      }
    }

    return Response.json({
      ok: results.every((item) => item.ok),
      checked: results.length,
      repaired: results.filter((item) => item.repaired?.length).length,
      complete: results.filter((item) => item.complete).length,
      incomplete: results.filter((item) => !item.complete).length,
      spacing_seconds: 14,
      results,
    });
  } catch (error) {
    return Response.json({ ok: false, error: error?.message || 'Erro ao reparar campanhas AUTO' }, { status: 500 });
  }
});
