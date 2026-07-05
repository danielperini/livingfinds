/**
 * weeklyBudgetUpdate — Delegador para calculateDailyBudgetAllocation
 *
 * Executa toda sexta-feira. Agora delega para a função central de orçamento
 * que implementa a referência de R$60/dia com distribuição por produto e tipo.
 * Mantida para compatibilidade com automação agendada existente.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    let accounts: any[] = [];
    if (body.amazon_account_id) {
      accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id });
    } else {
      accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' });
    }

    if (!accounts.length) {
      return Response.json({ ok: false, message: 'Nenhuma conta Amazon conectada.' });
    }

    const results: any[] = [];
    for (const account of accounts) {
      const result = await base44.asServiceRole.functions.invoke('calculateDailyBudgetAllocation', {
        amazon_account_id: account.id,
        dry_run: false,
        trigger: 'weeklyBudgetUpdate',
      });

      // Atualizar max_daily_budget_limit da conta com o total alocado
      if (result?.total_allocated > 0) {
        await base44.asServiceRole.entities.AmazonAccount.update(account.id, {
          max_daily_budget_limit: Math.ceil(result.total_allocated),
        }).catch(() => {});
      }

      results.push({
        account_id: account.id,
        total_allocated: result?.total_allocated,
        active_products: result?.active_products,
        active_campaigns: result?.active_campaigns,
        campaigns_applied: result?.campaigns_applied,
        within_tolerance: result?.within_tolerance,
      });
    }

    return Response.json({ ok: true, updated: results.filter(r => r.total_allocated > 0).length, results });

  } catch (error: any) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});