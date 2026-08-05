import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

/**
 * The only decision producer. It deliberately does not execute Amazon calls,
 * except canonical reconciliation functions that already confirm the remote
 * Amazon state before persisting local changes.
 */
const invoke = async (base44: any, name: string, payload: Record<string, unknown>) => {
  try {
    const result = await base44.asServiceRole.functions.invoke(name, payload);
    return result?.data || result || { ok: true };
  } catch (error: any) {
    return { ok: false, error: error?.response?.data?.error || error?.message || String(error) };
  }
};

function brtHour(now = new Date()): number {
  const hour = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit',
    hour12: false,
  }).format(now);
  return Number(hour) % 24;
}

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
    const currentHour = brtHour(body.now ? new Date(body.now) : new Date());
    const autoAuditWindow = dailyClose || body.bootstrap === true || body.force_auto_campaign_audit === true || currentHour % 3 === 0;
    const common = {
      amazon_account_id: accountId,
      _service_role: true,
      _canonical_orchestrator: 'runUnifiedDecisionEngine',
      decision_engine_correlation_id: correlationId,
      dry_run: dryRun,
    };

    const reportRequest = dailyClose && !body.skip_sync
      ? await invoke(base44, 'ensureDailyReportsCurrent', common)
      : { ok: true, skipped: true };
    const scopeBefore = await invoke(base44, 'reconcileManualBidCycleScope', { ...common, skip_sync: body.skip_sync === true });

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
    const manualStructureAudit = await invoke(base44, 'enforceCanonicalManualCampaigns', {
      ...common,
      trigger_type: dailyClose ? 'unified_daily_manual_structure_audit' : 'unified_intraday_manual_structure_audit',
    });

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
    const deliveryHealth = body.skip_campaign_delivery_health === true
      ? { ok: true, skipped: true }
      : await invoke(base44, 'reconcileCampaignDeliveryHealth', {
          ...common,
          snapshot_run_id: snapshotRunId,
        });

    const automaticCampaignDedup = autoAuditWindow
      ? await invoke(base44, 'deduplicateAutoCampaignsByAsin', {
          ...common,
          dry_run: dryRun,
          trigger_type: 'unified_auto_campaign_3h_guard',
        })
      : { ok: true, skipped: true, next_window_hours: 3 - (currentHour % 3) };

    const automaticWasteGuard = autoAuditWindow
      ? await invoke(base44, 'runWeeklyWasteTermsCleanup', {
          ...common,
          mode: 'daily_guard',
          auto_only: true,
          max_term_words: 3,
          lookback_hours: 48,
          allow_campaign_pause: false,
          trigger_type: 'unified_auto_campaign_3h_guard',
        })
      : { ok: true, skipped: true, next_window_hours: 3 - (currentHour % 3) };

    const automaticBidGuard = autoAuditWindow
      ? await invoke(base44, 'smartBidFromCpc', {
          ...common,
          auto_only: true,
          lookback_hours: 48,
          reduce_only: true,
          target_source: 'PerformanceSettings',
          trigger_type: 'unified_auto_campaign_3h_guard',
        })
      : { ok: true, skipped: true, next_window_hours: 3 - (currentHour % 3) };

    const scheduledCampaignState = body.skip_scheduled_daypart === true
      ? { ok: true, skipped: true }
      : await invoke(base44, 'queueCanonicalCampaignDaypartState', {
          ...common,
          holiday_dates: body.holiday_dates || null,
          now: body.now || null,
        });

    const scheduledBidDaypart = body.skip_scheduled_daypart === true
      ? { ok: true, skipped: true }
      : await invoke(base44, 'queueScheduledAdsDaypartTest', {
          ...common,
          dry_run: body.scheduled_daypart_dry_run !== false,
          enable_live_test: body.enable_scheduled_daypart_live_test === true,
          holiday_dates: body.holiday_dates || null,
          now: body.now || null,
        });

    const repricing = body.skip_repricing === true ? { ok: true, skipped: true } : await invoke(base44, 'runAutomaticRepricing', {
      ...common,
      operation: dailyClose || body.full_repricing_evaluation === true ? 'full_evaluation' : 'evaluate',
      recommendation_only: dryRun || body.repricing_recommendation_only === true,
      snapshot_run_id: snapshotRunId,
      daily_close: dailyClose,
      trigger: 'runUnifiedDecisionEngine',
    });

    const searchTerms = dailyClose || body.bootstrap === true
      ? await invoke(base44, 'runImmediateSameSkuSearchTermHarvest', { ...common, lookback_days: 65, max_promotions: 25, queue_only: true })
      : { ok: true, skipped: true };
    const cpcGuard = dailyClose
      ? await invoke(base44, 'smartBidFromCpc', { ...common })
      : { ok: true, skipped: true };
    const scopeAfter = await invoke(base44, 'reconcileManualBidCycleScope', { ...common, skip_sync: true });

    const stages = {
      reportRequest, scopeBefore, snapshots, economicAssessment, journeyAudit,
      manualStructureAudit, deterministic, economicBalancer, deliveryHealth,
      automaticCampaignDedup, automaticWasteGuard, automaticBidGuard,
      scheduledCampaignState, scheduledBidDaypart, repricing, searchTerms,
      cpcGuard, scopeAfter,
    };
    return Response.json({
      ok: Object.values(stages).every((stage: any) => stage?.ok !== false),
      engine: 'unified-marketplace-decision-governance',
      engine_version: 'unified-v9-auto-campaign-3h-guard',
      correlation_id: correlationId,
      snapshot_run_id: snapshotRunId,
      daily_close: dailyClose,
      dry_run: dryRun,
      auto_campaign_audit: {
        due: autoAuditWindow,
        interval_hours: 3,
        brt_hour: currentHour,
        lookback_hours: 48,
      },
      execution: 'queued decisions plus canonical Amazon-confirmed reconciliation',
      stages,
    });
  } catch (error: any) {
    return Response.json({ ok: false, engine: 'unified-marketplace-decision-governance', error: error?.message || 'Falha no motor unificado' }, { status: 500 });
  }
});
