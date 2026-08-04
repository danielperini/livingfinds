import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

/**
 * Compatibilidade legada para diagnosticos de zero delivery.
 *
 * O aumento controlado de bids sem impressoes agora usa os mesmos dados
 * economicos, cooldown, idempotencia e confirmacao Amazon do balanceador.
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
      mode: 'zero_delivery_only',
      _service_role: true,
      source_function: 'runManualZeroDeliveryBootstrap:legacy-wrapper',
    });
    const data = response?.data || response || {};
    return Response.json({
      ...data,
      deprecated: true,
      redirected_to: 'runEconomicBudgetBalancer',
      proposals: data?.accounts?.flatMap((row: any) => row.proposed || []) || [],
    });
  } catch (error: any) {
    return Response.json({
      ok: false,
      deprecated: true,
      redirected_to: 'runEconomicBudgetBalancer',
      error: error?.response?.data?.error || error?.message || 'Falha ao encaminhar zero delivery',
    }, { status: 500 });
  }
});
