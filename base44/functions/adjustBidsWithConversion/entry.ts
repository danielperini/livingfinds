import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

/**
 * Compatibilidade legada.
 *
 * O fluxo anterior executava bids e budgets diretamente, atualizava o estado
 * local antes da confirmacao remota e concorria com outros motores. Todas as
 * chamadas agora passam pelo balanceador economico e pela fila canonica de
 * OptimizationDecision.
 */
Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    if (!authenticated && !body._service_role) {
      return Response.json({ ok: false, error: 'Nao autorizado' }, { status: 401 });
    }

    const response = await base44.asServiceRole.functions.invoke('runEconomicBudgetBalancer', {
      ...body,
      dry_run: body.dry_run === true,
      mode: 'all',
      _service_role: true,
      source_function: 'adjustBidsWithConversion:legacy-wrapper',
    });
    return Response.json({
      ...(response?.data || response || {}),
      deprecated: true,
      redirected_to: 'runEconomicBudgetBalancer',
    });
  } catch (error: any) {
    return Response.json({
      ok: false,
      deprecated: true,
      redirected_to: 'runEconomicBudgetBalancer',
      error: error?.response?.data?.error || error?.message || 'Falha ao encaminhar para o balanceador economico',
    }, { status: 500 });
  }
});
