/**
 * pauseCampaign — Pausa campanha na Amazon Ads (SP API v3) e atualiza banco local
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
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
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
    const { amazon_account_id, campaign_id } = body;

    if (!amazon_account_id || !campaign_id) {
      return Response.json({ error: 'amazon_account_id e campaign_id necessários' }, { status: 400 });
    }

    const account = await base44.asServiceRole.entities.AmazonAccount.get(amazon_account_id);
    if (!account) return Response.json({ error: 'Conta Amazon não encontrada' }, { status: 404 });

    const refreshToken = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN');
    const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID');

    if (!refreshToken || !profileId) {
      return Response.json({ error: 'Credenciais Amazon Ads não configuradas' }, { status: 400 });
    }

    const token = await getAdsToken(refreshToken);
    const baseUrl = getAdsBaseUrl();

    // Amazon Ads API v3 — PUT /sp/campaigns (array body)
    const res = await fetch(`${baseUrl}/sp/campaigns`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID'),
        'Amazon-Advertising-API-Scope': String(profileId),
        'Content-Type': 'application/vnd.spCampaign.v3+json',
        'Accept': 'application/vnd.spCampaign.v3+json',
      },
      body: JSON.stringify({
        campaigns: [{ campaignId: campaign_id, state: 'PAUSED' }],
      }),
    });

    const responseData = await res.json();

    // Verificar se a campanha foi pausada com sucesso
    const updated = responseData?.campaigns?.success || responseData?.success;
    const failed = responseData?.campaigns?.error || responseData?.error;

    if (!res.ok || (failed && failed.length > 0 && (!updated || updated.length === 0))) {
      return Response.json({
        ok: false,
        error: 'Falha ao pausar campanha na Amazon',
        http_status: res.status,
        amazon_response: responseData,
      }, { status: 500 });
    }

    // Atualizar banco local
    const campaigns = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id, campaign_id });
    if (campaigns.length > 0) {
      await base44.asServiceRole.entities.Campaign.update(campaigns[0].id, {
        state: 'paused',
        status: 'paused',
        original_state: campaigns[0].state,
        last_activity_at: new Date().toISOString(),
      });
    }

    // Atualizar produto vinculado
    const products = await base44.asServiceRole.entities.Product.filter({
      amazon_account_id,
      linked_campaign_id: campaign_id,
    });
    for (const p of products) {
      await base44.asServiceRole.entities.Product.update(p.id, { campaign_status: 'paused' });
    }

    return Response.json({
      ok: true,
      campaign_id,
      new_state: 'paused',
      message: 'Campanha pausada com sucesso',
      amazon_response: responseData,
    });

  } catch (error) {
    console.error('[pauseCampaign] Erro:', error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
});