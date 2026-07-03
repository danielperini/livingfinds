/**
 * pauseCampaign — Pausa todas as campanhas Sponsored Products relacionadas ao produto
 * e devolve o produto ao estado operacional de Kick-off.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

async function getAdsToken(refreshToken) {
  const clientId = Deno.env.get('ADS_CLIENT_ID');
  const clientSecret = Deno.env.get('ADS_CLIENT_SECRET');
  if (!refreshToken || !clientId || !clientSecret) {
    throw new Error('Credenciais Amazon Ads incompletas.');
  }

  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const response = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || 'Falha ao gerar token Amazon Ads.');
  }
  return data.access_token;
}

function getAdsBaseUrl(region) {
  const value = String(region || Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
  if (value.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (value.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

function uniqueIds(values) {
  return [...new Set(values.filter(Boolean).map((value) => String(value)))];
}

function chunk(values, size = 100) {
  const groups = [];
  for (let index = 0; index < values.length; index += size) {
    groups.push(values.slice(index, index + size));
  }
  return groups;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { amazon_account_id, campaign_id, asin, sku } = body;
    if (!amazon_account_id || (!campaign_id && !asin && !sku)) {
      return Response.json({
        ok: false,
        error: 'amazon_account_id e campaign_id, asin ou sku são necessários',
      }, { status: 400 });
    }

    const account = await base44.asServiceRole.entities.AmazonAccount.get(amazon_account_id);
    if (!account) {
      return Response.json({ ok: false, error: 'Conta Amazon não encontrada' }, { status: 404 });
    }

    const refreshToken = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN');
    const profileId = account.ads_profile_id || account.profile_id || Deno.env.get('ADS_PROFILE_ID');
    if (!refreshToken || !profileId) {
      return Response.json({ ok: false, error: 'Credenciais Amazon Ads não configuradas' }, { status: 400 });
    }

    const allCampaigns = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id });
    const seedCampaign = campaign_id
      ? allCampaigns.find((item) => String(item.campaign_id) === String(campaign_id))
      : null;

    const targetAsin = asin || seedCampaign?.asin || null;
    const targetSku = sku || seedCampaign?.sku || null;

    const relatedCampaigns = allCampaigns.filter((item) => {
      if (item.archived === true) return false;
      const sameId = campaign_id && String(item.campaign_id) === String(campaign_id);
      const sameAsin = targetAsin && String(item.asin || '') === String(targetAsin);
      const sameSku = targetSku && String(item.sku || '') === String(targetSku);
      return sameId || sameAsin || sameSku;
    });

    const campaignIds = uniqueIds(relatedCampaigns.map((item) => item.campaign_id));
    if (!campaignIds.length) {
      return Response.json({ ok: false, error: 'Nenhuma campanha relacionada encontrada' }, { status: 404 });
    }

    const token = await getAdsToken(refreshToken);
    const baseUrl = getAdsBaseUrl(account.region);
    const amazonResponses = [];
    const failedCampaigns = [];
    const pausedCampaignIds = [];

    for (const ids of chunk(campaignIds, 100)) {
      const response = await fetch(`${baseUrl}/sp/campaigns`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID'),
          'Amazon-Advertising-API-Scope': String(profileId),
          'Content-Type': 'application/vnd.spCampaign.v3+json',
          Accept: 'application/vnd.spCampaign.v3+json',
        },
        body: JSON.stringify({
          campaigns: ids.map((id) => ({ campaignId: id, state: 'PAUSED' })),
        }),
      });

      const responseData = await response.json().catch(() => ({}));
      amazonResponses.push({ status: response.status, data: responseData });

      const successes = responseData?.campaigns?.success || responseData?.success || [];
      const errors = responseData?.campaigns?.error || responseData?.campaigns?.errors || responseData?.errors || [];

      for (const success of successes) {
        const id = success?.campaignId || success?.campaign?.campaignId;
        if (id) pausedCampaignIds.push(String(id));
      }
      for (const error of errors) {
        failedCampaigns.push(error);
      }

      if (!response.ok && !successes.length) {
        return Response.json({
          ok: false,
          error: 'Falha ao pausar campanhas na Amazon',
          http_status: response.status,
          amazon_response: responseData,
        }, { status: 500 });
      }
    }

    const now = new Date().toISOString();
    const confirmedIds = pausedCampaignIds.length ? uniqueIds(pausedCampaignIds) : campaignIds;

    for (const campaign of relatedCampaigns) {
      if (!confirmedIds.includes(String(campaign.campaign_id))) continue;
      await base44.asServiceRole.entities.Campaign.update(campaign.id, {
        state: 'paused',
        status: 'paused',
        original_state: campaign.state,
        last_activity_at: now,
        synced_at: now,
        last_sync_at: now,
      });
    }

    let relatedProducts = [];
    if (targetAsin) {
      relatedProducts = await base44.asServiceRole.entities.Product.filter({ amazon_account_id, asin: targetAsin });
    } else if (targetSku) {
      relatedProducts = await base44.asServiceRole.entities.Product.filter({ amazon_account_id, sku: targetSku });
    } else {
      relatedProducts = await base44.asServiceRole.entities.Product.filter({
        amazon_account_id,
        linked_campaign_id: String(campaign_id),
      });
    }

    for (const product of relatedProducts) {
      await base44.asServiceRole.entities.Product.update(product.id, {
        has_campaign: false,
        campaign_status: 'none',
        linked_campaign_id: null,
        campaign_id: null,
        amazon_campaign_id: null,
        ads_paused_at: now,
      });
    }

    await base44.asServiceRole.entities.LearningEvent.create({
      amazon_account_id,
      event_type: 'product_campaigns_paused',
      entity_type: 'product',
      entity_id: String(targetAsin || targetSku || campaign_id),
      observation: `${confirmedIds.length} campanhas relacionadas pausadas. Produto retornou ao estado de Kick-off.`,
      recorded_at: now,
    }).catch(() => {});

    return Response.json({
      ok: true,
      asin: targetAsin,
      sku: targetSku,
      requested_campaigns: campaignIds.length,
      paused_campaigns: confirmedIds.length,
      paused_campaign_ids: confirmedIds,
      failed_campaigns: failedCampaigns,
      product_reset_to_kickoff: true,
      new_state: 'paused',
      message: `${confirmedIds.length} campanhas pausadas. O botão voltou para Realizar Kick-off.`,
      amazon_response: amazonResponses,
    });
  } catch (error) {
    console.error('[pauseCampaign] Erro:', error?.message || error);
    return Response.json({ ok: false, error: error?.message || 'Erro ao pausar campanhas' }, { status: 500 });
  }
});