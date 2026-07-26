import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';

/**
 * Rota canônica de decisão de dayparting.
 *
 * Preserva schedules e chamadas existentes. Antes de decidir, sincroniza as
 * regras Amazon e cancela somente ações legadas pendentes, sem apagar histórico.
 */
Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    const internal = { ...body, _service_role: true };

    const nativeResponse = await base44.asServiceRole.functions.invoke('syncAmazonScheduleBidRules', internal)
      .catch((error: any) => ({ data: { ok: false, error: error?.message || String(error) } }));
    const nativeRules = nativeResponse?.data || nativeResponse || {};

    const reconcileResponse = await base44.asServiceRole.functions.invoke('reconcileLegacyDaypartingQueue', internal)
      .catch((error: any) => ({ data: { ok: false, error: error?.message || String(error) } }));
    const queueReconciliation = reconcileResponse?.data || reconcileResponse || {};

    const response = await base44.asServiceRole.functions.invoke('runCanonicalDaypartingEngine', {
      ...internal,
      source_function: body.source_function || 'runDaypartingDecisionEngine_canonical_route',
    });
    const data = response?.data || response || {};

    return Response.json({
      ...data,
      native_rule_preflight: nativeRules,
      legacy_queue_reconciliation: queueReconciliation,
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
