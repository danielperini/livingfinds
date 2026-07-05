/**
 * updateDailyBudgetSuggestion — Delegador para calculateDailyBudgetAllocation
 *
 * Executa o cálculo centralizado de orçamento (dry_run=true) e persiste a
 * sugestão no AutopilotConfig para exibição no dashboard.
 * Mantida para compatibilidade com automação semanal existente.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    // Resolver conta
    let account: any = null;
    if (body.amazon_account_id) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id });
      account = accs[0] || null;
    }
    if (!account) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      account = accs[0] || null;
    }
    if (!account) return Response.json({ ok: false, message: 'Nenhuma conta conectada' });

    // Delegar cálculo — dry_run=false para persistir a sugestão no AutopilotConfig
    const result = await base44.asServiceRole.functions.invoke('calculateDailyBudgetAllocation', {
      amazon_account_id: account.id,
      dry_run: false,
      trigger: 'updateDailyBudgetSuggestion_weekly',
    });

    return Response.json({
      ok: result?.ok ?? false,
      suggested_budget: result?.total_allocated,
      active_products: result?.active_products,
      active_campaigns: result?.active_campaigns,
      budget_per_product: result?.budget_per_product,
      budget_per_campaign: result?.budget_per_campaign,
      within_tolerance: result?.within_tolerance,
      delegated_to: 'calculateDailyBudgetAllocation',
    });

  } catch (error: any) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});