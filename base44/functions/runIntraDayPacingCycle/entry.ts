import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';

/**
 * Compatibilidade da rota antiga.
 *
 * O motor anterior alterava bids diretamente sobre valores já modificados e
 * atuava principalmente em keywords. A implementação canônica agora está em
 * runCanonicalDaypartingEngine e cobre campanhas AUTO, MANUAL EXACT e product
 * targeting, preservando esta rota para schedules e chamadas antigas.
 */
Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    const response = await base44.asServiceRole.functions.invoke('runCanonicalDaypartingEngine', {
      ...body,
      _service_role: true,
      source_function: body.source_function || 'runIntraDayPacingCycle_legacy_wrapper',
    });
    const data = response?.data || response || {};
    return Response.json({
      ...data,
      delegated_from: 'runIntraDayPacingCycle',
      delegated_to: 'runCanonicalDaypartingEngine',
      legacy_route_preserved: true,
    }, { status: data?.ok === false ? 500 : 200 });
  } catch (error: any) {
    return Response.json({
      ok: false,
      delegated_from: 'runIntraDayPacingCycle',
      delegated_to: 'runCanonicalDaypartingEngine',
      error: error?.message || 'Falha no wrapper de pacing',
    }, { status: 500 });
  }
});
