import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';

/**
 * runUnifiedDecisionEngine
 *
 * Entrada canônica e única do motor de decisões do LivingFinds.
 * Reconciliador manual, motor determinístico, regras nativas Amazon, migração
 * da fila antiga e monitor de tendência compartilham o mesmo ciclo.
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
      engine_version: 'unified-v4-repricing',
    };

    // Snapshot econômico e estado canônico sempre são atualizados antes das
    // decisões. Escritas na Amazon dependem da feature flag por conta e dos
    // limites de rollout verificados dentro da função delegada.
    const journeyResponse = await base44.asServiceRole.functions.invoke(
      'runEconomicProductJourney',
      {
        amazon_account_id: body.amazon_account_id || null,
        dry_run: body.dry_run === true,
        execute: body.execute_product_journey === true,
        max_actions: body.max_product_journey_actions,
        _service_role: true,
      },
    ).catch((error: any) => ({ data: { ok: false, error: error?.message || String(error) } }));
    const productJourney = journeyResponse?.data || journeyResponse || {};

    const scopeBeforeResponse = await base44.asServiceRole.functions.invoke(
      'reconcileManualBidCycleScope',
      {
        amazon_account_id: body.amazon_account_id || null,
        _service_role: true,
        skip_sync: body.skip_scope_sync === true,
      },
    ).catch((error: any) => ({ data: { ok: false, error: error?.message || String(error) } }));
    const scopeBefore = scopeBeforeResponse?.data || scopeBeforeResponse || {};

    const bootstrapResponse = await base44.asServiceRole.functions.invoke(
      'runManualZeroDeliveryBootstrap',
      {
        amazon_account_id: body.amazon_account_id || null,
        dry_run: body.dry_run === true,
        _service_role: true,
      },
    ).catch((error: any) => ({ data: { ok: false, error: error?.message || String(error) } }));
    const bootstrap = bootstrapResponse?.data || bootstrapResponse || {};

    const result = await base44.asServiceRole.functions.invoke(
      'runDeterministicDecisionEngine',
      payload,
    );
    const data = result?.data || result || {};

    // O motor unificado apenas orquestra. Decisao de preco, guardrails e fila
    // idempotente permanecem centralizados em runAutomaticRepricing.
    const repricing = body.skip_repricing === true
      ? { ok: true, skipped: true, reason: 'skip_repricing_requested' }
      : await base44.asServiceRole.functions.invoke(
        'runAutomaticRepricing',
        {
          amazon_account_id: body.amazon_account_id || null,
          operation: body.full_repricing_evaluation === true
            ? 'full_evaluation'
            : 'evaluate',
          // Uma simulacao do motor central nunca pode criar acao de preco.
          recommendation_only:
            body.dry_run === true || body.repricing_recommendation_only === true,
          trigger: 'runUnifiedDecisionEngine',
          decision_engine_correlation_id: data?.correlationId || null,
          _service_role: true,
        },
      ).then((response: any) => response?.data || response || {})
        .catch((error: any) => ({
          ok: false,
          error: error?.response?.data?.error || error?.message || String(error),
        }));

    const nativeRulesResponse = await base44.asServiceRole.functions.invoke(
      'syncAmazonScheduleBidRules',
      {
        amazon_account_id: body.amazon_account_id || null,
        dry_run: body.dry_run === true,
        _service_role: true,
      },
    ).catch((error: any) => ({ data: { ok: false, error: error?.message || String(error) } }));
    const nativeRules = nativeRulesResponse?.data || nativeRulesResponse || {};

    // Remove apenas ações legadas ainda pendentes. O histórico executado é mantido.
    const legacyQueueResponse = await base44.asServiceRole.functions.invoke(
      'reconcileLegacyDaypartingQueue',
      {
        amazon_account_id: body.amazon_account_id || null,
        _service_role: true,
      },
    ).catch((error: any) => ({ data: { ok: false, error: error?.message || String(error) } }));
    const legacyQueue = legacyQueueResponse?.data || legacyQueueResponse || {};

    const scopeAfterResponse = await base44.asServiceRole.functions.invoke(
      'reconcileManualBidCycleScope',
      {
        amazon_account_id: body.amazon_account_id || null,
        _service_role: true,
        skip_sync: true,
      },
    ).catch((error: any) => ({ data: { ok: false, error: error?.message || String(error) } }));
    const scopeAfter = scopeAfterResponse?.data || scopeAfterResponse || {};

    const trendMonitorResponse = await base44.asServiceRole.functions.invoke(
      'runAcosTrendMonitor',
      {
        amazon_account_id: body.amazon_account_id || null,
        trigger: 'runUnifiedDecisionEngine',
        _service_role: true,
      },
    ).catch((e: any) => ({ data: { ok: false, error: e?.message } }));
    const trendMonitor = trendMonitorResponse?.data || trendMonitorResponse || {};

    return Response.json({
      ok: data?.ok !== false && repricing?.ok !== false &&
        productJourney?.ok !== false &&
        scopeAfter?.ok !== false && nativeRules?.ok !== false &&
        legacyQueue?.ok !== false,
      engine: 'unified',
      engine_version: 'unified-v4-repricing',
      delegated_to: 'runDeterministicDecisionEngine',
      repricing_delegated_to: 'runAutomaticRepricing',
      product_journey: productJourney,
      amazon_account_id: body.amazon_account_id || null,
      manual_bid_scope_before: scopeBefore,
      manual_zero_delivery_bootstrap: bootstrap,
      result: data,
      repricing,
      amazon_schedule_bid_rules: nativeRules,
      legacy_dayparting_queue: legacyQueue,
      manual_bid_scope_after: scopeAfter,
      acos_trend_monitor: trendMonitor,
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
