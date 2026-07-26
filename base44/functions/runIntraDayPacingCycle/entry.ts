import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';

function todayBRT() {
  return new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
}

/**
 * Compatibilidade da rota antiga.
 * A sincronização estrutural das regras Amazon ocorre no máximo uma vez ao dia;
 * o ajuste horário continua sendo executado em cada chamada.
 */
Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    const internal = { ...body, _service_role: true };

    const accounts = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1).catch(() => [])
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-updated_at', 1).catch(() => []);
    const accountId = accounts[0]?.id || body.amazon_account_id || null;

    const dailySync = accountId ? await base44.asServiceRole.entities.SyncExecutionLog.filter({
      amazon_account_id: accountId,
      operation: 'sync_amazon_schedule_bid_rules',
      execution_date: todayBRT(),
      status: 'success',
    }, '-started_at', 1).catch(() => []) : [];

    let nativeRules: any = { ok: true, skipped: true, reason: 'already_synced_today' };
    if (dailySync.length === 0 || body.force_native_sync === true) {
      const nativeResponse = await base44.asServiceRole.functions.invoke('syncAmazonScheduleBidRules', internal)
        .catch((error: any) => ({ data: { ok: false, error: error?.message || String(error) } }));
      nativeRules = nativeResponse?.data || nativeResponse || {};
    }

    const reconcileResponse = await base44.asServiceRole.functions.invoke('reconcileLegacyDaypartingQueue', internal)
      .catch((error: any) => ({ data: { ok: false, error: error?.message || String(error) } }));
    const queueReconciliation = reconcileResponse?.data || reconcileResponse || {};

    const response = await base44.asServiceRole.functions.invoke('runCanonicalDaypartingEngine', {
      ...internal,
      skip_native_preflight: true,
      skip_queue_preflight: true,
      source_function: body.source_function || 'runIntraDayPacingCycle_legacy_wrapper',
    });
    const data = response?.data || response || {};

    return Response.json({
      ...data,
      native_rule_preflight: nativeRules,
      legacy_queue_reconciliation: queueReconciliation,
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
