import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

/**
 * Compatibilidade legada.
 *
 * O antigo motor diario criava e executava bids/budgets em paralelo. O ponto
 * de entrada permanece para schedules e telas antigas, mas toda decisao agora
 * passa pelo motor unificado, pelo balanceador economico e pela confirmacao
 * remota canonica.
 */
Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    if (!authenticated && !body._service_role) {
      return Response.json({ ok: false, error: 'Nao autorizado' }, { status: 401 });
    }

    const response = await base44.asServiceRole.functions.invoke('runUnifiedDecisionEngine', {
      ...body,
      dry_run: body.analysis_only === true || body.execute_actions === false || body.dry_run === true,
      _service_role: true,
      source_function: 'runDailyAdsOptimization:legacy-wrapper',
    });
    const data = response?.data || response || {};
    const balancer = data?.economic_budget_balancer || {};
    return Response.json({
      ...data,
      deprecated: true,
      redirected_to: 'runUnifiedDecisionEngine',
      decisions_created: balancer?.totals?.proposed || 0,
      decisions_executed: balancer?.totals?.executed || 0,
      breakdown: {
        economic_bid_budget: balancer?.totals?.proposed || 0,
      },
    });
  } catch (error: any) {
    return Response.json({
      ok: false,
      deprecated: true,
      redirected_to: 'runUnifiedDecisionEngine',
      error: error?.response?.data?.error || error?.message || 'Falha ao encaminhar para o motor unificado',
    }, { status: 500 });
  }
});
