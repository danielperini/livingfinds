/**
 * getBudgetUsageRealtime — Budget Usage API Amazon Ads (tempo quase real)
 *
 * Usa a Budget Usage API da Amazon Ads para obter o consumo de orçamento
 * do dia atual em tempo quase real (delay ~15 min vs 24h dos relatórios v3).
 *
 * Endpoint: POST /campaigns/budget/usage
 * Docs: https://advertising.amazon.com/API/docs/en-us/budget-usage
 *
 * Retorna: { campaigns: [{ campaignId, budget, spend, pacingRate, status }] }
 * Atualiza Campaign.current_spend e Campaign.daily_budget no banco.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function getAdsBase(region: string) {
  const r = (region || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

Deno.serve(async (req) => {
  const t0 = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    const isAuthenticated = await base44.auth.isAuthenticated().catch(() => false);
    if (!isAuthenticated && !body._service_role) {
      return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    // Resolver conta
    const accountId = body.amazon_account_id;
    const accounts = accountId
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: accountId }, null, 1)
      : await base44.asServiceRole.entities.AmazonAccount.list('-created_date', 1);
    const account = accounts[0];
    if (!account) return Response.json({ ok: false, error: 'Conta Amazon não encontrada' }, { status: 404 });

    const aid = account.id;
    const clientId = Deno.env.get('ADS_CLIENT_ID') || '';
    const clientSecret = Deno.env.get('ADS_CLIENT_SECRET') || '';
    const refreshToken = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN') || '';
    const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID') || '';
    const adsBase = getAdsBase(account.region || Deno.env.get('ADS_REGION') || 'NA');

    if (!refreshToken || !clientId || !clientSecret) {
      return Response.json({ ok: false, error: 'Credenciais Amazon Ads não configuradas' });
    }

    // Obter token LWA
    const lwaRes = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }).toString(),
    });
    const lwaData = await lwaRes.json().catch(() => ({}));
    if (!lwaRes.ok || !lwaData.access_token) {
      return Response.json({ ok: false, error: lwaData.error_description || `Token falhou: HTTP ${lwaRes.status}` });
    }
    const token = lwaData.access_token;

    const headers = {
      'Authorization': `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': clientId,
      'Amazon-Advertising-API-Scope': profileId,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };

    // Budget Usage API — endpoint por tipo de anúncio (SP)
    // Docs: /sp/campaigns/budget/usage
    // Filtro opcional por campaignIds
    const campaignFilter: any = { campaignIds: body.campaign_ids?.length > 0 ? body.campaign_ids : undefined };
    if (!campaignFilter.campaignIds) delete campaignFilter.campaignIds;

    const budgetHeaders = {
      'Authorization': `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': clientId,
      'Amazon-Advertising-API-Scope': profileId,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };

    // Tentar Budget Usage API v3 (SP)
    // Fallback: listar campanhas via SP campaigns list API para obter budget atual
    let budgetItems: any[] = [];
    let apiSource = 'budget_usage';

    const budgetRes = await fetch(`${adsBase}/sp/campaigns/budget/usage`, {
      method: 'POST',
      headers: budgetHeaders,
      body: JSON.stringify(campaignFilter),
    });

    if (budgetRes.ok) {
      const budgetData = await budgetRes.json().catch(() => ({}));
      budgetItems = budgetData?.budgetUsageResults || budgetData?.campaigns || [];
    } else {
      // Fallback: SP campaigns list v3 para obter budget e estado atual
      console.log(`[getBudgetUsage] Budget Usage API HTTP ${budgetRes.status} — usando fallback SP campaigns list`);
      apiSource = 'campaigns_list_fallback';

      const listRes = await fetch(`${adsBase}/sp/campaigns/list`, {
        method: 'POST',
        headers: {
          ...budgetHeaders,
          'Content-Type': 'application/vnd.spCampaign.v3+json',
          'Accept': 'application/vnd.spCampaign.v3+json',
        },
        body: JSON.stringify({
          stateFilter: { include: ['ENABLED', 'PAUSED'] },
          maxResults: 500,
        }),
      });

      if (listRes.ok) {
        const listData = await listRes.json().catch(() => ({}));
        const camps: any[] = listData?.campaigns || [];
        budgetItems = camps.map(c => ({
          campaignId: String(c.campaignId || c.campaign_id || ''),
          budget: c.budget?.budget || c.dailyBudget || 0,
          budgetUsage: 0, // não disponível via list, mas budget está correto
          status: c.state || c.status || '',
        }));
      } else {
        const errData = await budgetRes.json().catch(() => ({}));
        return Response.json({
          ok: false,
          error: `Budget Usage API: HTTP ${budgetRes.status} — ${errData?.message || budgetRes.statusText}`,
          http_status: budgetRes.status,
        });
      }
    }

    console.log(`[getBudgetUsage] ${budgetItems.length} campanhas retornadas pela Budget Usage API`);

    if (budgetItems.length === 0) {
      return Response.json({ ok: true, campaigns: [], message: 'Nenhuma campanha retornada', duration_ms: Date.now() - t0 });
    }

    // Atualizar Campaign.current_spend e daily_budget no banco
    const existingCamps = await base44.asServiceRole.entities.Campaign.filter(
      { amazon_account_id: aid }, null, 5000
    ).catch(() => []);
    const campByAmazonId = new Map((existingCamps as any[]).map(c => [
      String(c.amazon_campaign_id || c.campaign_id), c
    ]));

    const campaignUpdates: any[] = [];
    const result: any[] = [];

    for (const item of budgetItems) {
      const campId = String(item.campaignId || item.id || '');
      const budget = Number(item.budget || item.budgetAmount || 0);
      const spend = Number(item.budgetUsage || item.usagePercent ? (budget * item.usagePercent / 100) : item.spend || 0);
      const pacingRate = budget > 0 ? Math.round(spend / budget * 1000) / 10 : 0;

      result.push({
        campaign_id: campId,
        budget,
        spend,
        pacing_rate: pacingRate,
        status: item.status || '',
        budget_at_risk: pacingRate > 90,
      });

      const existing = campByAmazonId.get(campId);
      if (existing) {
        campaignUpdates.push({
          id: existing.id,
          current_spend: spend,
          ...(budget > 0 ? { daily_budget: budget } : {}),
        });
      }
    }

    // Salvar em lotes
    for (let i = 0; i < campaignUpdates.length; i += 100) {
      await base44.asServiceRole.entities.Campaign.bulkUpdate(campaignUpdates.slice(i, i + 100)).catch(() => {});
      if (i + 100 < campaignUpdates.length) await sleep(150);
    }

    const budgetAtRisk = result.filter(c => c.budget_at_risk);
    console.log(`[getBudgetUsage] ✓ ${campaignUpdates.length} campanhas atualizadas | ${budgetAtRisk.length} com orçamento crítico (>90%) | source=${apiSource}`);

    return Response.json({
      ok: true,
      campaigns: result,
      total: result.length,
      updated_in_db: campaignUpdates.length,
      budget_at_risk: budgetAtRisk.length,
      api_source: apiSource,
      duration_ms: Date.now() - t0,
    });

  } catch (err: any) {
    console.error('[getBudgetUsageRealtime]', err.message);
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
});