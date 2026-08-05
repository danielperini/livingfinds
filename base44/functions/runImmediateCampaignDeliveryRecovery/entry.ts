import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

async function invoke(base44: any, name: string, payload: Record<string, unknown>) {
  try {
    const response = await base44.asServiceRole.functions.invoke(name, payload);
    return response?.data || response || {};
  } catch (error: any) {
    return { ok: false, error: error?.response?.data?.error || error?.message || String(error) };
  }
}

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    if (!authenticated && !body._service_role) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });

    const accountId = body.amazon_account_id;
    if (!accountId) return Response.json({ ok: false, error: 'amazon_account_id obrigatório' }, { status: 400 });

    const common = {
      amazon_account_id: accountId,
      _service_role: true,
      _canonical_orchestrator: 'runUnifiedDecisionEngine',
      decision_engine_correlation_id: body.correlation_id || crypto.randomUUID(),
      force: true,
      minimum_age_hours: 72,
      immediate: true,
      queue_only: false,
      trigger: 'settings_dayparting_immediate_recovery',
    };

    const structure = await invoke(base44, 'enforceCanonicalManualCampaigns', {
      ...common,
      trigger_type: 'immediate_stale_campaign_repair',
    });
    const delivery = await invoke(base44, 'reconcileCampaignDeliveryHealth', common);
    const executor = await invoke(base44, 'executeApprovedDecisionQueue', {
      ...common,
      max_batch: 30,
    });
    const confirmation = await invoke(base44, 'confirmExecutedDecisions', common);

    const accountResults = Array.isArray(delivery?.results) ? delivery.results : [];
    const actions = accountResults.flatMap((row: any) => Array.isArray(row?.actions) ? row.actions : []);
    const repaired = actions.filter((action: any) => action.action === 'REPAIR_STRUCTURE').length;
    const queued = actions.filter((action: any) => ['INCREASE_BID', 'PAUSE_AND_REPLACE', 'ARCHIVE_NO_PRODUCT', 'ARCHIVE_OUT_OF_STOCK'].includes(action.action)).length;

    return Response.json({
      ok: [structure, delivery, executor, confirmation].every(stage => stage?.ok !== false),
      evaluated: actions.length,
      queued,
      repaired,
      executed: Number(executor?.executed || 0),
      confirmed: Number(confirmation?.confirmed || 0),
      correlation_id: common.decision_engine_correlation_id,
      stages: { structure, delivery, executor, confirmation },
    });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || 'Falha na recuperação imediata' }, { status: 500 });
  }
});
