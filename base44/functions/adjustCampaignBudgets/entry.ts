import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    if (!body._service_role) return Response.json({ ok: false, error: 'Uso interno' }, { status: 403 });

    const { amazon_account_id, adjustments } = body;
    // adjustments: [{ campaign_id, db_id, new_budget, reason }]

    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ id: amazon_account_id }, null, 1);
    const account = accounts[0];
    if (!account) return Response.json({ ok: false, error: 'Conta não encontrada' }, { status: 404 });

    const refreshToken = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN');
    const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID');
    const clientId = Deno.env.get('ADS_CLIENT_ID');
    const clientSecret = Deno.env.get('ADS_CLIENT_SECRET');

    const tokenRes = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }),
    });
    const { access_token } = await tokenRes.json();
    if (!access_token) return Response.json({ ok: false, error: 'Falha no token' }, { status: 500 });

    const region = (Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
    const baseUrl = region === 'EU' ? 'https://advertising-api-eu.amazon.com' :
                    region === 'FE' ? 'https://advertising-api-fe.amazon.com' :
                    'https://advertising-api.amazon.com';

    const headers = {
      'Authorization': `Bearer ${access_token}`,
      'Amazon-Advertising-API-ClientId': clientId,
      'Amazon-Advertising-API-Scope': String(profileId),
      'Content-Type': 'application/vnd.spCampaign.v3+json',
      'Accept': 'application/vnd.spCampaign.v3+json',
    };

    const payload = {
      campaigns: adjustments.map((a: any) => ({
        campaignId: a.campaign_id,
        budget: { budget: a.new_budget, budgetType: 'DAILY' },
      })),
    };

    const res = await fetch(`${baseUrl}/sp/campaigns`, { method: 'PUT', headers, body: JSON.stringify(payload) });
    const data = await res.json();

    const successIds = new Set((data?.campaigns?.success || []).map((s: any) => String(s.campaignId)));
    const errors = data?.campaigns?.error || [];
    const allSuccess = res.ok && successIds.size === 0 && errors.length === 0;

    // Atualizar banco
    let dbUpdated = 0;
    for (const adj of adjustments) {
      if (allSuccess || successIds.has(String(adj.campaign_id))) {
        try {
          await base44.asServiceRole.entities.Campaign.update(adj.db_id, {
            daily_budget: adj.new_budget,
            budget: adj.new_budget,
            updated_at: new Date().toISOString(),
          });
          dbUpdated++;
        } catch (_) {}
      }
    }

    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id,
      operation: 'budget_adjustment',
      trigger_type: 'manual',
      status: errors.length === 0 ? 'success' : 'warning',
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      records_processed: adjustments.length,
      records_imported: dbUpdated,
      result_summary: `Budget ajustado em ${dbUpdated}/${adjustments.length} campanhas. Erros: ${errors.length}.`,
    }).catch(() => {});

    return Response.json({
      ok: errors.length === 0,
      http_status: res.status,
      amazon_success: allSuccess ? adjustments.length : successIds.size,
      amazon_errors: errors,
      db_updated: dbUpdated,
    });
  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});