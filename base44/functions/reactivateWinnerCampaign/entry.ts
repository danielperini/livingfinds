/**
 * reactivateWinnerCampaign — Reativa campanha vencedora pausada indevidamente e aplica proteção anti-pausa automática
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';

async function getAdsToken(base44: any, accountId: string): Promise<string> {
  const res = await base44.asServiceRole.functions.invoke('amazonAdsTokenManager', {
    amazon_account_id: accountId,
    _service_role: true,
  });
  const data = res?.data || res;
  if (!data?.ok || !data?.access_token) {
    throw new Error(data?.message || data?.error || 'Falha ao obter access token Amazon Ads');
  }
  return String(data.access_token);
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

    const { amazon_account_id, campaign_db_id, campaign_id, asin, force, new_budget } = body;
    if (!amazon_account_id || !campaign_id) {
      return Response.json({ error: 'amazon_account_id e campaign_id são obrigatórios' }, { status: 400 });
    }

    // Resolver o DB id: pode vir como campaign_db_id ou precisar ser buscado
    let dbId = campaign_db_id || null;
    if (!dbId) {
      const rows = await base44.asServiceRole.entities.Campaign.filter(
        { amazon_account_id, campaign_id }, null, 1
      ).catch(() => []);
      if (!rows[0]) {
        // Tentar pelo amazon_campaign_id também
        const rows2 = await base44.asServiceRole.entities.Campaign.filter(
          { amazon_account_id, amazon_campaign_id: campaign_id }, null, 1
        ).catch(() => []);
        dbId = rows2[0]?.id || null;
      } else {
        dbId = rows[0]?.id || null;
      }
    }

    // Buscar conta
    const account = await base44.asServiceRole.entities.AmazonAccount.get(amazon_account_id);
    if (!account) return Response.json({ error: 'Conta não encontrada' }, { status: 404 });

    const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID');
    if (!profileId) {
      return Response.json({ error: 'ads_profile_id não configurado na conta' }, { status: 400 });
    }

    const token = await getAdsToken(base44, amazon_account_id);
    const baseUrl = getAdsBaseUrl();
    const clientId = Deno.env.get('ADS_CLIENT_ID') || '';

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

    if (dbId) {
      await base44.asServiceRole.entities.Campaign.update(dbId, dbUpdate);
    } else {
      // Fallback: atualizar por campaign_id via updateMany
      await base44.asServiceRole.entities.Campaign.updateMany(
        { amazon_account_id, campaign_id },
        { $set: dbUpdate }
      ).catch(() => {});
    }

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