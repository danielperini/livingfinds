import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

/**
 * runUnifiedDecisionEngine
 *
 * Entrada canônica e única do motor de decisões do LivingFinds.
 * Antes e depois do motor principal, reconcilia o escopo do ciclo manual de bids
 * para impedir que campanhas antigas, pausadas/arquivadas, ASINs inativos,
 * produtos sem estoque, keywords não-EXACT ou grupos multi-keyword permaneçam
 * em lifecycle/fila de decisões.
 */
Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);

    if (!authenticated && !body._service_role) {
      return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    const payload = {
      ...body,
      _service_role: true,
      source_function: body.source_function || 'runUnifiedDecisionEngine',
      engine_version: 'unified-v1',
    };

    // Pré-flight: sincroniza estados e retira lixo histórico do ciclo antes de decidir.
    const scopeBeforeResponse = await base44.asServiceRole.functions.invoke(
      'reconcileManualBidCycleScope',
      {
        amazon_account_id: body.amazon_account_id || null,
        _service_role: true,
        skip_sync: body.skip_scope_sync === true,
      },
    ).catch((error: any) => ({ data: { ok: false, error: error?.message || String(error) } }));
    const scopeBefore = scopeBeforeResponse?.data || scopeBeforeResponse || {};

    const result = await base44.asServiceRole.functions.invoke(
      'runDeterministicDecisionEngine',
      payload,
    );
    const data = result?.data || result || {};

    // Pós-flight: o motor legado ainda pode enxergar linhas históricas persistidas.
    // Cancela qualquer decisão nova que não pertença ao universo manual ativo.
    const scopeAfterResponse = await base44.asServiceRole.functions.invoke(
      'reconcileManualBidCycleScope',
      {
        amazon_account_id: body.amazon_account_id || null,
        _service_role: true,
        skip_sync: true,
      },
    ).catch((error: any) => ({ data: { ok: false, error: error?.message || String(error) } }));
    const scopeAfter = scopeAfterResponse?.data || scopeAfterResponse || {};

    return Response.json({
      ok: data?.ok !== false && scopeAfter?.ok !== false,
      engine: 'unified',
      delegated_to: 'runDeterministicDecisionEngine',
      amazon_account_id: body.amazon_account_id || null,
      manual_bid_scope_before: scopeBefore,
      manual_bid_scope_after: scopeAfter,
      result: data,
    });
  } catch (error: any) {
    return Response.json(
      {
        ok: false,
        engine: 'unified',
        error: error?.message || 'Falha no motor unificado de decisões',
      },
      { status: 500 },
    );
  }
});
