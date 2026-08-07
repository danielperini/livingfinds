import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

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
    timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false,
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
    const lifecycleWindow = dailyClose || body.bootstrap === true || body.force_campaign_lifecycle === true || currentHour % 3 === 0;
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

    const economicCurveAdsGuard = body.skip_economic_curve_ads_guard === true
      ? { ok: true, skipped: true }
      : await invoke(base44, 'runEconomicCurveAdsGuard', {
          ...common,
          max_actions: 20,
          target_mer_pct: body.target_mer_pct,
        });

    const deterministic = await invoke(base44, 'runDeterministicDecisionEngine', {
      ...common,
      skip_economic_bid_budget: true,
      skip_direct_execution: true,
      daily_close: dailyClose,
      snapshot_run_id: snapshotRunId,
    });

    const campaignLifecycle = lifecycleWindow
      ? await invoke(base44, 'runCanonicalCampaignLifecycleLayer', {
          ...common,
          daily_close: dailyClose,
          snapshot_run_id: snapshotRunId,
        })
      : { ok: true, skipped: true, next_window_hours: 3 - (currentHour % 3) };

    const economicBalancer = lifecycleWindow
      ? { ok: true, skipped: true, delegated_to: 'runCanonicalCampaignLifecycleLayer' }
      : await invoke(base44, 'runEconomicBudgetBalancer', {
          ...common,
          mode: 'incremental', skip_sync: true, queue_only: true,
          snapshot_run_id: snapshotRunId, daily_close: false,
        });

    const deliveryHealth = body.skip_campaign_delivery_health === true
      ? { ok: true, skipped: true }
      : await invoke(base44, 'reconcileCampaignDeliveryHealth', { ...common, snapshot_run_id: snapshotRunId });

    const daypartConfiguration = body.skip_scheduled_daypart === true
      ? { ok: true, skipped: true }
      : await invoke(base44, 'syncDaypartingConfiguration', {
          ...common,
          bootstrap_default_rules: body.bootstrap === true,
        });
    const daypartBudgetRestore = body.skip_scheduled_daypart === true
      ? { ok: true, skipped: true }
      : await invoke(base44, 'reconcileDaypartCampaignBudgets', {
          ...common,
          now: body.now || null,
        });
    const scheduledCampaignState = body.skip_scheduled_daypart === true
      ? { ok: true, skipped: true }
      : await invoke(base44, 'queueCanonicalCampaignDaypartState', {
          ...common, now: body.now || null,
        });
    const scheduledBidDaypart = body.skip_scheduled_daypart === true
      ? { ok: true, skipped: true }
      : await invoke(base44, 'queueScheduledAdsDaypartTest', {
          ...common,
          now: body.now || null,
        });

    const repricing = body.skip_repricing === true
      ? { ok: true, skipped: true }
      : await invoke(base44, 'runAutomaticRepricing', {
          ...common,
          operation: dailyClose || body.full_repricing_evaluation === true ? 'full_evaluation' : 'evaluate',
          recommendation_only: dryRun || body.repricing_recommendation_only === true,
          snapshot_run_id: snapshotRunId,
          daily_close: dailyClose,
          trigger: 'runUnifiedDecisionEngine',
        });
    const scopeAfter = await invoke(base44, 'reconcileManualBidCycleScope', { ...common, skip_sync: true });

    const stages = {
      reportRequest, scopeBefore, snapshots, economicAssessment, journeyAudit,
      manualStructureAudit, economicCurveAdsGuard, deterministic, campaignLifecycle,
      economicBalancer, deliveryHealth, daypartConfiguration, daypartBudgetRestore,
      scheduledCampaignState, scheduledBidDaypart, repricing, scopeAfter,
    };
    return Response.json({
      ok: Object.values(stages).every((stage: any) => stage?.ok !== false),
      engine: 'unified-marketplace-decision-governance',
      engine_version: 'unified-v13-economic-curve-bayes-mer',
      correlation_id: correlationId,
      snapshot_run_id: snapshotRunId,
      daily_close: dailyClose,
      dry_run: dryRun,
      economic_ads_guard: {
        function: 'runEconomicCurveAdsGuard',
        sales_curve: 'ABC 80/15/5',
        profit_curve: 'ABC 80/15/5 lucro pós-Ads',
        dynamic_asin_loss_budget: true,
        sequential_zero_sale_ceiling: true,
        bayesian_cvr_guard: true,
        mer_tacos_guardrail: true,
        execution_owner: 'executeApprovedDecisionQueue',
        confirmation_required: true,
      },
      campaign_lifecycle: {
        due: lifecycleWindow,
        interval_hours: 3,
        brt_hour: currentHour,
        schedule_owner: 'runUnifiedDecisionEngine',
      },
      dayparting: {
        source_of_truth: 'AmazonScheduledRule',
        live_when_not_dry_run: true,
        confirmation_required: true,
        budget_policy: 'restaura somente reduções confirmadas do app; nunca ignora hard cap global',
      },
      execution: 'fila canônica, confirmação Amazon e persistência posterior',
      stages,
    });
  } catch (error: any) {
    return Response.json({ ok: false, engine: 'unified-marketplace-decision-governance', error: error?.message || 'Falha no motor unificado' }, { status: 500 });
  }
});
