/**
 * rollbackLastChange — Reverte última alteração de bid, budget ou placement
 * Busca no histórico e restaura configuração anterior
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const tokenCache = {};

async function getAdsToken(refreshToken) {
  const cached = tokenCache['ads'];
  if (cached && cached.expires_at > Date.now()) return cached.access_token;
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: Deno.env.get('ADS_CLIENT_ID'),
    client_secret: Deno.env.get('ADS_CLIENT_SECRET'),
  });
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || 'Token failed');
  tokenCache['ads'] = { access_token: data.access_token, expires_at: Date.now() + (data.expires_in - 60) * 1000 };
  return data.access_token;
}

function getAdsBaseUrl() {
  const r = (Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function adsRequestV3(method, path, body, refreshToken, profileId, contentType = 'application/json') {
  const token = await getAdsToken(refreshToken);
  const res = await fetch(`${getAdsBaseUrl()}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID'),
      'Amazon-Advertising-API-Scope': String(profileId),
      'Content-Type': contentType,
      'Accept': contentType,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: res.status, data, requestId: res.headers.get('x-amzn-requestid') || '' };
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { amazon_account_id, campaign_id, entity_type, entity_id } = body;

    if (!amazon_account_id || !entity_type) {
      return Response.json({ error: 'amazon_account_id and entity_type required' }, { status: 400 });
    }

    // Buscar conta Amazon
    const account = await base44.asServiceRole.entities.AmazonAccount.get(amazon_account_id).catch(() => null);
    if (!account) return Response.json({ ok: false, error: 'AmazonAccount não encontrada' });

    const refreshToken = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN');
    if (!refreshToken) return Response.json({ ok: false, error: 'Sem refresh_token' });

    const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID');
    if (!profileId) return Response.json({ ok: false, error: 'ads_profile_id não configurado' });

    // Buscar última alteração no histórico
    let lastChange = null;

    if (entity_type === 'keyword') {
      const changes = await base44.asServiceRole.entities.BidHistory.filter(
        { amazon_account_id, entity_type: 'keyword', entity_id },
        '-created_at',
        1
      );
      lastChange = changes[0] || null;
    } else if (entity_type === 'campaign_budget') {
      const changes = await base44.asServiceRole.entities.BidHistory.filter(
        { amazon_account_id, entity_type: 'campaign', entity_id: campaign_id },
        '-created_at',
        1
      );
      lastChange = changes[0] || null;
    } else if (entity_type === 'campaign_placement') {
      const changes = await base44.asServiceRole.entities.CampaignCreationLog.filter(
        { amazon_account_id, campaign_id, operation_type: 'update_bid' },
        '-created_at',
        1
      );
      lastChange = changes[0] || null;
    }

    if (!lastChange) {
      return Response.json({ ok: false, error: 'Nenhuma alteração encontrada para reverter' });
    }

    const now = new Date().toISOString();
    let apiResult = null;

    // Reverter alteração
    if (entity_type === 'keyword' && lastChange.old_bid != null) {
      // Reverter bid na Amazon
      apiResult = await adsRequestV3('PUT', '/sp/keywords', [{
        keywordId: entity_id,
        bid: lastChange.old_bid,
      }], refreshToken, profileId, 'application/vnd.spKeyword.v3+json');

      // Atualizar keyword local
      const kws = await base44.asServiceRole.entities.Keyword.filter({ amazon_account_id, keyword_id: entity_id });
      if (kws.length > 0) {
        await base44.asServiceRole.entities.Keyword.update(kws[0].id, {
          bid: lastChange.old_bid,
          current_bid: lastChange.old_bid,
        });
      }
    } else if (entity_type === 'campaign_budget' && lastChange.budget_before != null) {
      // Reverter budget na Amazon
      apiResult = await adsRequestV3('PUT', '/sp/campaigns', [{
        campaignId: campaign_id,
        budget: { budgetType: 'DAILY', budget: lastChange.budget_before },
      }], refreshToken, profileId, 'application/vnd.spCampaign.v3+json');

      // Atualizar campanha local
      await base44.asServiceRole.entities.Campaign.update(campaign_id, {
        daily_budget: lastChange.budget_before,
      });
    } else if (entity_type === 'campaign_placement' && lastChange.old_placement_top != null) {
      // Reverter placements
      const placements = {};
      if (lastChange.old_placement_top != null) placements.topOfSearch = { multiplier: lastChange.old_placement_top / 100 };
      if (lastChange.old_placement_rest != null) placements.restOfSearch = { multiplier: lastChange.old_placement_rest / 100 };
      if (lastChange.old_placement_product != null) placements.productPages = { multiplier: lastChange.old_placement_product / 100 };

      apiResult = await adsRequestV3('PUT', '/sp/campaigns', [{
        campaignId: campaign_id,
        placement: placements,
      }], refreshToken, profileId, 'application/vnd.spCampaign.v3+json');

      // Atualizar campanha local
      await base44.asServiceRole.entities.Campaign.update(campaign_id, {
        placement_top_search: lastChange.old_placement_top,
        placement_rest_search: lastChange.old_placement_rest,
        placement_product_pages: lastChange.old_placement_product,
      });
    }

    // Registrar reversão
    await base44.asServiceRole.entities.CampaignCreationLog.create({
      amazon_account_id,
      user_id: user.id,
      operation_type: 'rollback',
      entity_type,
      entity_id: entity_id || campaign_id,
      campaign_id,
      rule_applied: 'Rollback de alteração',
      rationale: `Revertido para configuração anterior: ${JSON.stringify({ old_bid: lastChange.old_bid, budget_before: lastChange.budget_before }).slice(0, 200)}`,
      status: 'success',
      amazon_response: JSON.stringify(apiResult?.data || {}).slice(0, 500),
      request_id: apiResult?.requestId || '',
      created_at: now,
    }).catch(() => {});

    return Response.json({
      ok: true,
      reverted: true,
      entity_type,
      entity_id: entity_id || campaign_id,
      previous_value: {
        old_bid: lastChange.old_bid,
        budget_before: lastChange.budget_before,
        old_placement_top: lastChange.old_placement_top,
        old_placement_rest: lastChange.old_placement_rest,
        old_placement_product: lastChange.old_placement_product,
      },
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});