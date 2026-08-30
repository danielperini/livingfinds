import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';

const MAX_CAMPAIGN_DAILY_BUDGET = 15;
const BATCH_SIZE = 50;

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    if (!body._service_role) return Response.json({ ok: false, error: 'Uso interno' }, { status: 403 });

    const accountFilter = body.amazon_account_id ? { id: String(body.amazon_account_id) } : {};
    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter(accountFilter, '-created_date', 100).catch(() => []);

    const result: any[] = [];
    let campaignsScanned = 0;
    let campaignsOverCap = 0;
    let amazonAdjusted = 0;
    let failed = 0;

    for (const account of accounts) {
      const campaigns = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: account.id }, '-updated_at', 2000).catch(() => []);
      campaignsScanned += campaigns.length;

      const overCap = campaigns.filter((c: any) => {
        const state = String(c?.state || c?.status || '').toLowerCase();
        if (state === 'archived') return false;
        const budget = Number(c?.daily_budget ?? c?.budget ?? 0);
        return Number.isFinite(budget) && budget > MAX_CAMPAIGN_DAILY_BUDGET;
      });

      campaignsOverCap += overCap.length;

      for (let i = 0; i < overCap.length; i += BATCH_SIZE) {
        const batch = overCap.slice(i, i + BATCH_SIZE);
        const adjustments = batch.map((c: any) => ({
          campaign_id: c.amazon_campaign_id || c.campaign_id,
          db_id: c.id,
          new_budget: MAX_CAMPAIGN_DAILY_BUDGET,
          reason: 'hard_campaign_daily_budget_cap',
        })).filter((a: any) => a.campaign_id && a.db_id);

        if (!adjustments.length) continue;

        const response = await base44.asServiceRole.functions.invoke('adjustCampaignBudgets', {
          _service_role: true,
          amazon_account_id: account.id,
          adjustments,
        }).catch((error: any) => ({ ok: false, error: error?.message || String(error) }));

        const data = response?.data || response || {};
        const ok = data?.ok !== false;
        amazonAdjusted += Number(data?.amazon_success || 0);
        if (!ok) failed += adjustments.length;

        result.push({
          amazon_account_id: account.id,
          requested: adjustments.length,
          amazon_success: Number(data?.amazon_success || 0),
          db_updated: Number(data?.db_updated || 0),
          ok,
          error: data?.error || null,
        });
      }
    }

    return Response.json({
      ok: failed === 0,
      max_campaign_daily_budget: MAX_CAMPAIGN_DAILY_BUDGET,
      accounts_scanned: accounts.length,
      campaigns_scanned: campaignsScanned,
      campaigns_over_cap: campaignsOverCap,
      amazon_adjusted: amazonAdjusted,
      failed,
      result,
    });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || String(error) }, { status: 500 });
  }
});