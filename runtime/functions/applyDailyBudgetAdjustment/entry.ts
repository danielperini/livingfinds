/**
 * applyDailyBudgetAdjustment — Delegador para calculateDailyBudgetAllocation
 *
 * Esta função foi refatorada para delegar toda a lógica de orçamento à função
 * central calculateDailyBudgetAllocation, que implementa as regras completas de
 * distribuição com referência de R$60/dia.
 *
 * Mantida para compatibilidade retroativa com automações existentes.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const { amazon_account_id, dry_run = false } = body;

    if (!amazon_account_id) {
      return Response.json({ ok: false, error: 'amazon_account_id é obrigatório.' }, { status: 400 });
    }

    // Delegar para a função central
    const result = await base44.asServiceRole.functions.invoke('calculateDailyBudgetAllocation', {
      amazon_account_id,
      dry_run,
      trigger: 'applyDailyBudgetAdjustment',
    });

    return Response.json({
      ok: result?.ok ?? false,
      delegated_to: 'calculateDailyBudgetAllocation',
      ...result,
    });

  } catch (error: any) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});