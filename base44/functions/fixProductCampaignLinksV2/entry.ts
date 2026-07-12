import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const ADS_CLIENT_ID = Deno.env.get('ADS_CLIENT_ID') || '';
const ADS_CLIENT_SECRET = Deno.env.get('ADS_CLIENT_SECRET') || '';
const ADS_REGION = Deno.env.get('ADS_REGION') || 'na';
const ENDPOINT_MAP = {
  na: 'https://advertising-api.amazon.com',
  eu: 'https://advertising-api-eu.amazon.com',
  fe: 'https://advertising-api-fe.amazon.com',
};

function stateOf(value) {
  const state = String(value || '').toLowerCase();
  if (['enabled', 'active', 'ativa', 'ativada', 'serving'].includes(state)) return 'enabled';
  if (['paused', 'pausada', 'disabled'].includes(state)) return 'paused';
  if (['incomplete', 'pending', 'draft', 'processing', 'pending_insertion', 'em inserção', 'em insercao'].includes(state)) return 'incomplete';
  if (['archived', 'ended', 'encerrada', 'deleted', 'removed'].includes(state)) return 'archived';
  return state;
}

function asinOf(campaign) {
  if (campaign.asin) return String(campaign.asin).toUpperCase();
  const name = String(campaign.name || campaign.campaign_name || '');
  const match = name.match(/B0[A-Z0-9]{8}/i);
  return match ? match[0].toUpperCase() : null;
}

function priorityOf(campaign) {
  const state = stateOf(campaign.amazon_status || campaign.state || campaign.status);
  if (state === 'enabled') return 4;
  if (state === 'incomplete') return 3;
  if (state === 'paused') return 2;
  return 1;
}

async function getAccessToken(refreshToken) {
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: ADS_CLIENT_ID,
      client_secret: ADS_CLIENT_SECRET,
    }).toString(),
  });
  if (!res.ok) return null;
  return (await res.json()).access_token;
}

// Busca o SKU real de uma campanha na Amazon via ProductAds
async function fetchSkuFromAmazon(token, profileId, campaignId) {
  const endpoint = ENDPOINT_MAP[ADS_REGION] || ENDPOINT_MAP.na;
  try {
    const res = await fetch(`${endpoint}/sp/productAds/list`, {
      method: 'POST',
      headers: {
        'Amazon-Advertising-API-ClientId': ADS_CLIENT_ID,
        'Amazon-Advertising-API-Scope': profileId,
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/vnd.spProductAd.v3+json',
        'Accept': 'application/vnd.spProductAd.v3+json',
      },
      body: JSON.stringify({
        campaignIdFilter: { include: [String(campaignId)] },
        maxResults: 1,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const ad = (data?.productAds || [])[0];
    return ad?.sku || null;
  } catch { return null; }
}

// Arquiva campanha localmente e na Amazon
async function archiveCampaignLocal(base44, campaign, now, reason) {
  await base44.asServiceRole.entities.Campaign.update(campaign.id, {
    state: 'archived',
    status: 'archived',
    archived_reason: reason,
    updated_at: now,
  }).catch(() => {});
}

Deno.serve(async (request) => {
  const now = new Date().toISOString();
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    if (!authenticated && !body._service_role) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    if (!body.amazon_account_id) return Response.json({ ok: false, error: 'amazon_account_id obrigatório' }, { status: 400 });

    const aid = body.amazon_account_id;

    // Carregar conta para credenciais
    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ id: aid }, null, 1);
    const account = accounts[0] || null;
    const profileId = account?.ads_profile_id || Deno.env.get('ADS_PROFILE_ID') || '';
    const refreshToken = account?.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN') || '';

    // Obter token Ads (opcional — usado apenas para buscar SKU)
    let adsToken = null;
    if (profileId && refreshToken && ADS_CLIENT_ID) {
      adsToken = await getAccessToken(refreshToken).catch(() => null);
    }

    const campaigns = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid }, '-updated_at', 5000);
    const products = await base44.asServiceRole.entities.Product.filter({ amazon_account_id: aid }, '-updated_at', 5000);

    // Índice de produtos por ASIN e SKU
    const productByAsin = new Map();
    const productBySku = new Map();
    for (const p of products) {
      if (p.asin) productByAsin.set(String(p.asin).toUpperCase(), p);
      if (p.sku) productBySku.set(String(p.sku).toUpperCase(), p);
    }

    const campaignsByAsin = new Map();
    const skuFixed = [];
    const archived = [];

    for (const campaign of campaigns) {
      const asin = asinOf(campaign);
      const state = stateOf(campaign.amazon_status || campaign.state || campaign.status);
      if (state === 'archived' || campaign.api_missing === true) continue;

      // ── SKU ausente na campanha: tentar resolver ──────────────────────
      if (!campaign.sku && asin) {
        const productForAsin = productByAsin.get(asin);
        if (productForAsin?.sku) {
          // Produto tem SKU → forçar vínculo na campanha
          await base44.asServiceRole.entities.Campaign.update(campaign.id, {
            sku: productForAsin.sku,
            asin: asin,
            updated_at: now,
          }).catch(() => {});
          campaign.sku = productForAsin.sku;
          skuFixed.push({ campaign_id: campaign.campaign_id, asin, sku: productForAsin.sku, source: 'product_by_asin' });
        } else if (adsToken && (campaign.campaign_id || campaign.amazon_campaign_id)) {
          // Produto não tem SKU → buscar na Amazon via ProductAds API
          const amazonCampaignId = campaign.campaign_id || campaign.amazon_campaign_id;
          const fetchedSku = await fetchSkuFromAmazon(adsToken, profileId, amazonCampaignId);
          if (fetchedSku) {
            await base44.asServiceRole.entities.Campaign.update(campaign.id, {
              sku: fetchedSku,
              asin: asin,
              updated_at: now,
            }).catch(() => {});
            campaign.sku = fetchedSku;
            skuFixed.push({ campaign_id: campaign.campaign_id, asin, sku: fetchedSku, source: 'amazon_product_ads_api' });
            // Se o produto existir pelo SKU encontrado, vincular o ASIN
            const pBySku = productBySku.get(String(fetchedSku).toUpperCase());
            if (pBySku && !pBySku.asin) {
              await base44.asServiceRole.entities.Product.update(pBySku.id, { asin, updated_at: now }).catch(() => {});
            }
          } else {
            // Sem SKU de nenhuma fonte → arquivar campanha
            await archiveCampaignLocal(base44, campaign, now, 'sku_not_found_after_api_lookup');
            archived.push({ campaign_id: campaign.campaign_id, asin, reason: 'sku_not_found' });
            continue; // não incluir no mapa de campanhas ativas
          }
        } else if (!productForAsin) {
          // Sem produto e sem token para buscar → arquivar
          await archiveCampaignLocal(base44, campaign, now, 'product_not_found_and_no_sku');
          archived.push({ campaign_id: campaign.campaign_id, asin, reason: 'product_not_found' });
          continue;
        }
        // Se chegou aqui sem sku ainda (produto existe mas sem sku), deixa passar — não arquiva
      }

      if (!asin) continue;
      if (!campaignsByAsin.has(asin)) campaignsByAsin.set(asin, []);
      campaignsByAsin.get(asin).push(campaign);
    }

    // Vincular produtos às campanhas
    let updated = 0, active = 0, incomplete = 0, paused = 0, withoutCampaign = 0;

    for (const product of products) {
      const asin = String(product.asin || '').toUpperCase();
      const linked = (campaignsByAsin.get(asin) || []).sort((a, b) => priorityOf(b) - priorityOf(a));
      const campaign = linked[0];

      if (!campaign?.campaign_id) {
        await base44.asServiceRole.entities.Product.update(product.id, {
          linked_campaign_id: null,
          has_campaign: false,
          campaign_status: 'none',
          linked_campaign_name: null,
          campaign_link_updated_at: now,
        });
        withoutCampaign++;
        continue;
      }

      const rawState = stateOf(campaign.amazon_status || campaign.state || campaign.status);
      const status = rawState === 'enabled' ? 'active' : rawState === 'incomplete' ? 'incomplete' : 'paused';

      await base44.asServiceRole.entities.Product.update(product.id, {
        linked_campaign_id: String(campaign.campaign_id),
        has_campaign: true,
        campaign_status: status,
        linked_campaign_name: campaign.name || campaign.campaign_name || null,
        linked_campaign_count: linked.length,
        linked_campaign_ids: linked.map((item) => String(item.campaign_id)),
        campaign_link_updated_at: now,
      });

      updated++;
      if (status === 'active') active++;
      else if (status === 'incomplete') incomplete++;
      else paused++;
    }

    return Response.json({
      ok: true,
      updated,
      active,
      incomplete,
      paused,
      without_campaign: withoutCampaign,
      sku_fixed: skuFixed.length,
      archived_no_sku: archived.length,
      sku_fixed_details: skuFixed,
      archived_details: archived,
      message: `${active} ativo(s), ${incomplete} em inserção, ${paused} pausado(s), ${withoutCampaign} sem campanha. SKUs corrigidos: ${skuFixed.length}. Arquivadas sem SKU: ${archived.length}.`,
    });
  } catch (error) {
    return Response.json({ ok: false, error: error?.message || 'Erro ao restaurar vínculos de campanhas' }, { status: 500 });
  }
});