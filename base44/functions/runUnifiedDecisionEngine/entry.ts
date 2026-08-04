import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

/**
 * The only decision producer.  It deliberately does not execute Amazon calls:
 * executeApprovedDecisionQueue and confirmExecutedDecisions own that lifecycle.
 */
const invoke = async (base44: any, name: string, payload: Record<string, unknown>) => {
  try {
    const result = await base44.asServiceRole.functions.invoke(name, payload);
    return result?.data || result || { ok: true };
  } catch (error: any) {
    return { ok: false, error: error?.response?.data?.error || error?.message || String(error) };
  }
};

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    if (!authenticated && !body._service_role) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });

    const accountId = body.amazon_account_id || null;
    const dailyClose = body.daily_close === true;
    const dryRun = body.dry_run === true;
    const correlationId = body.correlation_id || crypto.randomUUID();
    const common = {
      amazon_account_id: accountId,
      _service_role: true,
      _canonical_orchestrator: 'runUnifiedDecisionEngine',
      decision_engine_correlation_id: correlationId,
      dry_run: dryRun,
    };

    // Previous-day reports must be requested before the daily close.  Intraday
    // runs only consume already persisted, fresh data.
    const reportRequest = dailyClose && !body.skip_sync
      ? await invoke(base44, 'ensureDailyReportsCurrent', common)
      : { ok: true, skipped: true };
    const scopeBefore = await invoke(base44, 'reconcileManualBidCycleScope', { ...common, skip_sync: body.skip_sync === true });

    // Rebuild first.  Every later action has a historical RepricingSnapshot id.
    const snapshots = await invoke(base44, 'buildCanonicalMarketplaceSnapshots', {
      ...common,
      mode: dailyClose || body.bootstrap === true ? 'bootstrap' : 'incremental',
      daily_close: dailyClose,
      persist: true,
      window_minutes: 15,
    });
    const snapshotRunId = snapshots.run_id || snapshots.snapshot_run_id || correlationId;

    const economicAssessment = dailyClose
      ? await invoke(base44, 'runDailyEconomicAssessment', { ...common, force: true, assessment_date: body.assessment_date || null })
      : { ok: true, skipped: true };

    const journeyAudit = await invoke(base44, 'classifyMarketplaceCampaignJourneys', common);
    const manualStructureAudit = dailyClose || body.bootstrap === true
      ? await invoke(base44, 'enforceCanonicalManualCampaigns', { ...common, trigger_type: 'unified_daily_manual_structure_audit' })
      : { ok: true, skipped: true };

    // Classification/audit happens before bids. Legacy engines may add non-bid
    // observations, but cannot execute or produce bid/budget decisions here.
    const deterministic = await invoke(base44, 'runDeterministicDecisionEngine', {
      ...common,
      skip_economic_bid_budget: true,
      skip_direct_execution: true,
      daily_close: dailyClose,
      snapshot_run_id: snapshotRunId,
    });
    const economicBalancer = await invoke(base44, 'runEconomicBudgetBalancer', {
      ...common,
      mode: dailyClose || body.bootstrap === true ? 'all' : 'incremental',
      skip_sync: true,
      queue_only: true,
      snapshot_run_id: snapshotRunId,
      daily_close: dailyClose,
    });
    const repricing = body.skip_repricing === true ? { ok: true, skipped: true } : await invoke(base44, 'runAutomaticRepricing', {
      ...common,
      operation: dailyClose || body.full_repricing_evaluation === true ? 'full_evaluation' : 'evaluate',
      recommendation_only: dryRun || body.repricing_recommendation_only === true,
      snapshot_run_id: snapshotRunId,
      daily_close: dailyClose,
      trigger: 'runUnifiedDecisionEngine',
    });

    // One pipeline is authoritative for AUTO, manual EXACT, legacy phrase/broad
    // and product-targeting search terms. It is read-only with regard to Amazon.
    const searchTerms = dailyClose || body.bootstrap === true
      ? await invoke(base44, 'runImmediateSameSkuSearchTermHarvest', { ...common, lookback_days: 65, max_promotions: 25, queue_only: true })
      : { ok: true, skipped: true };
    // Após consolidar o dia anterior, corta desperdício por termo antes de
    // considerar qualquer pausa ampla. A função cria negativas EXATAS na
    // origem; pausas de campanha permanecem deliberadamente desabilitadas.
    const autoSearchTermGuard = dailyClose
      ? await invoke(base44, 'runWeeklyWasteTermsCleanup', { ...common, mode: 'daily_guard', allow_campaign_pause: false })
      : { ok: true, skipped: true };
    const cpcGuard = dailyClose
      ? await invoke(base44, 'smartBidFromCpc', { ...common })
      : { ok: true, skipped: true };
    const scopeAfter = await invoke(base44, 'reconcileManualBidCycleScope', { ...common, skip_sync: true });

    const stages = { reportRequest, scopeBefore, snapshots, economicAssessment, journeyAudit, manualStructureAudit, deterministic, economicBalancer, repricing, searchTerms, autoSearchTermGuard, cpcGuard, scopeAfter };
    return Response.json({
      ok: Object.values(stages).every((stage: any) => stage?.ok !== false),
      engine: 'unified-marketplace-decision-governance',
      engine_version: 'unified-v5-canonical-snapshot',
      correlation_id: correlationId,
      snapshot_run_id: snapshotRunId,
      daily_close: dailyClose,
      dry_run: dryRun,
      execution: 'queued_only; separate executor and confirmation schedules own Amazon mutations',
      stages,
    });
  } catch (error: any) {
    return Response.json({ ok: false, engine: 'unified-marketplace-decision-governance', error: error?.message || 'Falha no motor unificado' }, { status: 500 });
  }
});
