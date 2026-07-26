import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';

/**
 * Rota canônica de decisão de dayparting.
 *
 * A implementação anterior calculava ajustes próprios de até 20% sobre o bid
 * corrente. Para impedir deriva, conflito com regras nativas e motores
 * paralelos, esta rota agora delega ao runCanonicalDaypartingEngine, que usa
 * bid-base persistido e faixa absoluta de 0,50x a 1,50x.
 */
Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    const response = await base44.asServiceRole.functions.invoke('runCanonicalDaypartingEngine', {
      ...body,
      _service_role: true,
      source_function: body.source_function || 'runDaypartingDecisionEngine_canonical_route',
    });
    const data = response?.data || response || {};
    return Response.json({
      ...data,
      delegated_from: 'runDaypartingDecisionEngine',
      delegated_to: 'runCanonicalDaypartingEngine',
      legacy_engine_disabled: true,
    }, { status: data?.ok === false ? 500 : 200 });
  } catch (error: any) {
    return Response.json({
      ok: false,
      delegated_from: 'runDaypartingDecisionEngine',
      delegated_to: 'runCanonicalDaypartingEngine',
      error: error?.message || 'Falha na rota canônica de dayparting',
    }, { status: 500 });
  }
});
