/**
 * reactivateWinnerCampaign — Reativa campanha vencedora pausada indevidamente e aplica proteção anti-pausa automática
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';

async function getAdsToken(refreshToken, clientId, clientSecret) {
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Token failed: ${data.error_description || data.error}`);
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
    if (!body._service_role) return Response.json({ error: 'Uso interno' }, { status: 403 });

    const { amazon_account_id, campaign_db_id, campaign_id, new_budget } = body;
    if (!amazon_account_id || !campaign_db_id || !campaign_id) {
      return Response.json({ error: 'amazon_account_id, campaign_db_id e campaign_id são obrigatórios' }, { status: 400 });
    }

    // Buscar conta
    const account = await base44.asServiceRole.entities.AmazonAccount.get(amazon_account_id);
    if (!account) return Response.json({ error: 'Conta não encontrada' }, { status: 404 });

    const refreshToken = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN');
    const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID');
    const clientId = Deno.env.get('ADS_CLIENT_ID');
    const clientSecret = Deno.env.get('ADS_CLIENT_SECRET');

    if (!refreshToken || !profileId) {
      return Response.json({ error: 'Credenciais Amazon não configuradas' }, { status: 400 });
    }

    const token = await getAdsToken(refreshToken, clientId, clientSecret);
    const baseUrl = getAdsBaseUrl();

    const headers = {
      'Authorization': `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': clientId,
      'Amazon-Advertising-API-Scope': String(profileId),
      'Content-Type': 'application/vnd.spCampaign.v3+json',
      'Accept': 'application/vnd.spCampaign.v3+json',
    };

    // ── 1. Reativar na Amazon (state=ENABLED) + opcionalmente ajustar budget ──
    const campaignPayload = { campaignId: campaign_id, state: 'ENABLED' };
    if (new_budget && new_budget > 0) {
      campaignPayload.budget = { budget: new_budget, budgetType: 'DAILY' };
    }

    const amazonRes = await fetch(`${baseUrl}/sp/campaigns`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ campaigns: [campaignPayload] }),
    });
    const amazonData = await amazonRes.json();

    const hasError = (amazonData?.campaigns?.error?.length || 0) > 0;
    const amazonSuccess = amazonRes.ok && !hasError;

    // ── 2. Atualizar banco local com proteção ──
    const now = new Date().toISOString();
    const dbUpdate = {
      state: 'enabled',
      status: 'enabled',
      is_operational: true,
      ads_resume_pending: false,
      ads_pause_reason: null,
      ads_protected: true,          // proteção anti-pausa automática
      last_activity_at: now,
      updated_at: now,
    };
    if (new_budget && new_budget > 0) {
      dbUpdate.daily_budget = new_budget;
      dbUpdate.budget = new_budget;
    }

    await base44.asServiceRole.entities.Campaign.update(campaign_db_id, dbUpdate);

    // ── 3. Log de execução ──
    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id,
      operation: 'reactivate_winner_campaign',
      trigger_type: 'manual',
      status: amazonSuccess ? 'success' : 'warning',
      started_at: now,
      completed_at: now,
      records_processed: 1,
      records_imported: amazonSuccess ? 1 : 0,
      endpoint: `PUT ${baseUrl}/sp/campaigns`,
      http_status: amazonRes.status,
      result_summary: amazonSuccess
        ? `Campanha ${campaign_id} reativada com sucesso. ads_protected=true aplicado. Budget: R$ ${new_budget || 'inalterado'}.`
        : `Campanha ${campaign_id}: reativação Amazon falhou. Banco local atualizado com proteção. Erro: ${JSON.stringify(amazonData?.campaigns?.error?.[0])}`,
    });

    return Response.json({
      ok: true,
      campaign_id,
      amazon_success: amazonSuccess,
      amazon_http_status: amazonRes.status,
      amazon_response: amazonData,
      db_updated: true,
      ads_protected: true,
      new_state: 'enabled',
      new_budget: new_budget || null,
      message: amazonSuccess
        ? `Campanha reativada e protegida com sucesso.`
        : `Banco local protegido. Verificar estado na Amazon manualmente (HTTP ${amazonRes.status}).`,
    });

  } catch (error) {
    console.error('[reactivateWinnerCampaign] Erro:', error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
});