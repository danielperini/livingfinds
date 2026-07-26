import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';

/**
 * Compatibilidade da rota histórica.
 *
 * Ordem única:
 * 1. sincronizar estrutura das regras Amazon;
 * 2. retirar ações antigas de bid da fila;
 * 3. executar pacing de orçamento/estado sem alterar bids;
 * 4. executar o motor canônico de bids.
 */
Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    const internal = { ...body, _service_role: true };

    // eligible_asins e bid_multiplier_override são escopo transitório do ciclo
    // horário e não devem reconstruir regras recorrentes persistidas.
    const nativePayload = {
      ...internal,
      eligible_asins: undefined,
      bid_multiplier_override: undefined,
    };
    const nativeResponse = await base44.asServiceRole.functions.invoke('syncAmazonScheduleBidRules', nativePayload)
      .catch((error: any) => ({ data: { ok: false, error: error?.message || String(error) } }));
    const nativeRules = nativeResponse?.data || nativeResponse || {};

    const reconcileResponse = await base44.asServiceRole.functions.invoke('reconcileLegacyDaypartingQueue', internal)
      .catch((error: any) => ({ data: { ok: false, error: error?.message || String(error) } }));
    const queueReconciliation = reconcileResponse?.data || reconcileResponse || {};

    const pacingResponse = await base44.asServiceRole.functions.invoke('runIntraDayBudgetPacingCycle', internal)
      .catch((error: any) => ({ data: { ok: false, error: error?.message || String(error), actions_executed: 0 } }));
    const pacing = pacingResponse?.data || pacingResponse || {};

    const response = await base44.asServiceRole.functions.invoke('runCanonicalDaypartingEngine', {
      ...internal,
      skip_native_preflight: true,
      skip_queue_preflight: true,
      source_function: body.source_function || 'runIntraDayPacingCycle_legacy_wrapper',
    });
    const data = response?.data || response || {};
    const bidActions = Number(data?.executed || 0);
    const pacingActions = Number(pacing?.actions_executed || 0);

    return Response.json({
      ...data,
      ok: data?.ok !== false && pacing?.ok !== false,
      actions_executed: pacingActions + bidActions,
      budget_actions_executed: pacingActions,
      bid_actions_executed: bidActions,
      spend_pacing: pacing?.spend_pacing || data?.pacing || 'unknown',
      pacing_ratio: pacing?.pacing_ratio ?? null,
      budget_pacing: pacing,
      native_rule_preflight: nativeRules,
      legacy_queue_reconciliation: queueReconciliation,
      delegated_from: 'runIntraDayPacingCycle',
      bid_engine: 'runCanonicalDaypartingEngine',
      budget_engine: 'runIntraDayBudgetPacingCycle',
      legacy_route_preserved: true,
    }, { status: data?.ok === false || pacing?.ok === false ? 500 : 200 });
  } catch (error: any) {
    return Response.json({
      ok: false,
      actions_executed: 0,
      delegated_from: 'runIntraDayPacingCycle',
      error: error?.message || 'Falha no ciclo intra-diário',
    }, { status: 500 });
  }
});
