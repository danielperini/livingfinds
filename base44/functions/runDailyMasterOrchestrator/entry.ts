import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

/**
 * runDailyMasterOrchestrator
 *
 * Orquestrador diário completo.
 * Todas as decisões passam pela entrada canônica runUnifiedDecisionEngine.
 */

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function invoke(base44: any, fn: string, payload: object = {}) {
  try {
    const res = await base44.asServiceRole.functions.invoke(fn, { _service_role: true, ...payload });
    return { fn, ok: res?.data?.ok !== false, data: res?.data };
  } catch (e: any) {
    return { fn, ok: false, error: e?.message };
  }
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const user = body._service_role ? null : await base44.auth.me().catch(() => null);
    if (!body._service_role && !user) {
      return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const log: any[] = [];
    const started_at = new Date().toISOString();
    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-updated_date', 1).catch(() => []);
    const accountId = accounts?.[0]?.id || null;
    const basePayload = accountId ? { amazon_account_id: accountId } : {};

    log.push(await invoke(base44, 'refreshAmazonAdsTokenDailyOrHourly', basePayload));
    await wait(3000);

    log.push(await invoke(base44, 'syncProductCatalogV2', basePayload));
    await wait(4000);

    log.push(await invoke(base44, 'syncProductSalesMetrics', basePayload));
    await wait(4000);

    log.push(await invoke(base44, 'runDailyFullReportPipeline', basePayload));
    await wait(5000);

    log.push(await invoke(base44, 'syncAdsCampaignStatesV2', basePayload));
    await wait(3000);
    log.push(await invoke(base44, 'syncAdGroupsAndKeywords', basePayload));
    await wait(3000);

    log.push(await invoke(base44, 'checkInventoryChangesAndKickoff', basePayload));
    await wait(4000);

    log.push(await invoke(base44, 'runUnifiedDecisionEngine', basePayload));
    await wait(4000);

    log.push(await invoke(base44, 'executeApprovedDecisionQueue', basePayload));
    await wait(4000);

    for (let batch = 0; batch < 3; batch++) {
      const remaining = await base44.asServiceRole.entities.ProductKickoffQueue.filter({ status: 'scheduled' }, 'scheduled_at', 1).catch(() => []);
      if (remaining.length === 0) break;
      log.push(await invoke(base44, 'processProductKickoffQueueV2', { ...basePayload, force: true }));
      if (batch < 2) await wait(15000);
    }

    log.push(await invoke(base44, 'directAdsRepair', basePayload));
    await wait(5000);
    log.push(await invoke(base44, 'syncAdsCampaignStatesV2', basePayload));
    await wait(3000);

    log.push(await invoke(base44, 'runHourlyAdsGuardrails', basePayload));
    await wait(3000);

    log.push(await invoke(base44, 'evaluateNewCampaigns72h', basePayload));
    await wait(3000);

    log.push(await invoke(base44, 'enforceManualCampaignMinTerms', basePayload));
    await wait(3000);

    log.push(await invoke(base44, 'fixProductCampaignLinksV2', basePayload));
    await wait(2000);

    log.push(await invoke(base44, 'runBackupToDrive', { ...basePayload, backup_type: 'daily_incremental' }));

    const completed_at = new Date().toISOString();
    const errors = log.filter((l) => !l.ok);

    return Response.json({
      ok: errors.length === 0,
      started_at,
      completed_at,
      decision_engine: 'runUnifiedDecisionEngine',
      steps_total: log.length,
      steps_ok: log.filter((l) => l.ok).length,
      steps_error: errors.length,
      errors: errors.map((e) => ({ fn: e.fn, error: e.error || e.data?.error })),
      log,
    });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || 'Erro no orquestrador diário' }, { status: 500 });
  }
});
