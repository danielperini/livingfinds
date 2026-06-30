/**
 * archiveCampaign — Arquiva campanha na Amazon Ads e atualiza banco local
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

async function getAdsToken(refreshToken) {
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
  if (!res.ok) throw new Error(data.error_description || data.error || 'Token failed');
  return data.access_token;
}

function getAdsBaseUrl() {
  const r = (Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { amazon_account_id, campaign_id, archive_reason } = body;
    
    if (!amazon_account_id || !campaign_id) {
      return Response.json({ error: 'amazon_account_id e campaign_id necessários' }, { status: 400 });
    }

    const account = await base44.asServiceRole.entities.AmazonAccount.get(amazon_account_id);
    if (!account) return Response.json({ error: 'Conta Amazon não encontrada' }, { status: 404 });

    const refreshToken = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN');
    const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID');
    
    if (!refreshToken || !profileId) {
      return Response.json({ error: 'Credenciais Amazon não configuradas' }, { status: 400 });
    }

    const token = await getAdsToken(refreshToken);
    
    // Arquivar na Amazon (API v3)
    const res = await fetch(`${getAdsBaseUrl()}/sp/campaigns/${campaign_id}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID'),
        'Amazon-Advertising-API-Scope': String(profileId),
        'Content-Type': 'application/vnd.spCampaign.v3+json',
        'Accept': 'application/vnd.spCampaign.v3+json',
      },
      body: JSON.stringify({ state: 'ARCHIVED' }),
    });

    const responseData = await res.json();
    
    if (!res.ok) {
      return Response.json({ 
        ok: false, 
        error: 'Falha ao arquivar campanha na Amazon',
        http_status: res.status,
        amazon_response: responseData,
      }, { status: 500 });
    }

    // Atualizar banco local
    const campaigns = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id, campaign_id });
    if (campaigns.length === 0) {
      return Response.json({ error: 'Campanha não encontrada no banco local' }, { status: 404 });
    }

    await base44.asServiceRole.entities.Campaign.update(campaigns[0].id, {
      state: 'archived',
      status: 'archived',
      archived: true,
      archived_at: new Date().toISOString(),
      archive_reason: archive_reason || 'Arquivamento manual',
      original_state: campaigns[0].state,
      last_activity_at: new Date().toISOString(),
    });

    // Atualizar produto vinculado
    const products = await base44.asServiceRole.entities.Product.filter({ amazon_account_id, asin: campaigns[0].asin });
    if (products.length > 0) {
      await base44.asServiceRole.entities.Product.update(products[0].id, {
        has_campaign: false,
        campaign_status: 'archived',
        linked_campaign_id: null,
      });
    }

    // Log
    await base44.asServiceRole.entities.LearningEvent.create({
      amazon_account_id,
      event_type: 'campaign_archived',
      entity_type: 'campaign',
      entity_id: campaign_id,
      observation: `Campanha arquivada manualmente por ${user.full_name || user.email}. Motivo: ${archive_reason || 'Não especificado'}`,
      recorded_at: new Date().toISOString(),
    });

    return Response.json({
      ok: true,
      campaign_id,
      previous_state: campaigns[0].state,
      new_state: 'archived',
      http_status: res.status,
      message: 'Campanha arquivada com sucesso',
    });

  } catch (error) {
    console.error('[archiveCampaign] Erro:', error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
});