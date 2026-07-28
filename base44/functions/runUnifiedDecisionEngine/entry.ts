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
      engine_version: 'unified-v3-zero-delivery-bootstrap',
    };

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
      ok: data?.ok !== false && scopeAfter?.ok !== false && nativeRules?.ok !== false && legacyQueue?.ok !== false,
      engine: 'unified',
      engine_version: 'unified-v3-zero-delivery-bootstrap',
      delegated_to: 'runDeterministicDecisionEngine',
      amazon_account_id: body.amazon_account_id || null,
      manual_bid_scope_before: scopeBefore,
      manual_zero_delivery_bootstrap: bootstrap,
      result: data,
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
