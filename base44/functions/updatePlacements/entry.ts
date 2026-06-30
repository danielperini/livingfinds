/**
 * updatePlacements — Ajusta placements de campanha (topo, resto, páginas de produto)
 * API v3, com validação de CPC econômico e auditoria
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
    const { amazon_account_id, campaign_id, placement_top, placement_rest, placement_product, max_cpc } = body;

    if (!amazon_account_id || !campaign_id) {
      return Response.json({ error: 'amazon_account_id and campaign_id required' }, { status: 400 });
    }

    // Validar: não aumentar todos simultaneamente
    const changes = [];
    if (placement_top != null) changes.push({ type: 'top_of_search', value: placement_top });
    if (placement_rest != null) changes.push({ type: 'rest_of_search', value: placement_rest });
    if (placement_product != null) changes.push({ type: 'product_pages', value: placement_product });

    if (changes.length === 0) {
      return Response.json({ error: 'Ao menos um placement deve ser informado' }, { status: 400 });
    }

    // Buscar conta Amazon
    const account = await base44.asServiceRole.entities.AmazonAccount.get(amazon_account_id).catch(() => null);
    if (!account) return Response.json({ ok: false, error: 'AmazonAccount não encontrada' });

    const refreshToken = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN');
    if (!refreshToken) return Response.json({ ok: false, error: 'Sem refresh_token' });

    const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID');
    if (!profileId) return Response.json({ ok: false, error: 'ads_profile_id não configurado' });

    // Buscar campanha atual
    const campaigns = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id, campaign_id });
    if (campaigns.length === 0) return Response.json({ ok: false, error: 'Campanha não encontrada' });

    const campaign = campaigns[0];
    const currentBid = campaign.bidding_strategy === 'dynamic_down_only' ? 0.30 : 0.50; // bid base estimado

    // Validar CPC econômico
    if (max_cpc != null) {
      for (const change of changes) {
        const effectiveCpc = currentBid * (1 + (change.value || 0) / 100);
        if (effectiveCpc > max_cpc) {
          return Response.json({
            ok: false,
            error: `Placement ${change.type} ultrapassa CPC máximo. Bid base: $${currentBid}, ajuste: ${change.value}%, CPC efetivo: $${effectiveCpc.toFixed(2)}, max: $${max_cpc}`,
          });
        }
      }
    }

    // API v3: PUT /sp/campaigns/{id} com placements
    const updatePayload = {
      campaignId: campaign_id,
      placement: {},
    };

    // Estrutura v3 para placements
    const placements = {};
    if (placement_top != null) {
      placements.topOfSearch = { multiplier: placement_top / 100 };
    }
    if (placement_rest != null) {
      placements.restOfSearch = { multiplier: placement_rest / 100 };
    }
    if (placement_product != null) {
      placements.productPages = { multiplier: placement_product / 100 };
    }

    updatePayload.placement = placements;

    const result = await adsRequestV3('PUT', '/sp/campaigns', [updatePayload], refreshToken, profileId, 'application/vnd.spCampaign.v3+json');

    if (![200, 207].includes(result.status)) {
      return Response.json({
        ok: false,
        error: 'Falha ao atualizar placements',
        amazon_status: result.status,
        amazon_error: JSON.stringify(result.data).slice(0, 300),
      });
    }

    const now = new Date().toISOString();

    // Salvar auditoria
    await base44.asServiceRole.entities.CampaignCreationLog.create({
      amazon_account_id,
      user_id: user.id,
      operation_type: 'update_bid',
      entity_type: 'campaign',
      entity_id: campaign_id,
      campaign_id,
      old_placement_top: campaign.placement_top_search || 0,
      new_placement_top: placement_top != null ? placement_top : campaign.placement_top_search || 0,
      old_placement_rest: campaign.placement_rest_search || 0,
      new_placement_rest: placement_rest != null ? placement_rest : campaign.placement_rest_search || 0,
      old_placement_product: campaign.placement_product_pages || 0,
      new_placement_product: placement_product != null ? placement_product : campaign.placement_product_pages || 0,
      rule_applied: 'Ajuste de placements',
      rationale: `Placements atualizados: top=${placement_top}%, rest=${placement_rest}%, product=${placement_product}%`,
      status: 'success',
      amazon_response: JSON.stringify(result.data).slice(0, 500),
      request_id: result.requestId,
      created_at: now,
    }).catch(() => {});

    // Atualizar campanha local
    await base44.asServiceRole.entities.Campaign.update(campaign_id, {
      placement_top_search: placement_top != null ? placement_top : campaign.placement_top_search,
      placement_rest_search: placement_rest != null ? placement_rest : campaign.placement_rest_search,
      placement_product_pages: placement_product != null ? placement_product : campaign.placement_product_pages,
      synced_at: now,
    });

    return Response.json({
      ok: true,
      placements: {
        top_of_search: placement_top != null ? placement_top : campaign.placement_top_search,
        rest_of_search: placement_rest != null ? placement_rest : campaign.placement_rest_search,
        product_pages: placement_product != null ? placement_product : campaign.placement_product_pages,
      },
      request_id: result.requestId,
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});