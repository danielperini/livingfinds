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
    // Meta de portfólio: ampliar em 40% a quantidade de campanhas que realmente
    // entregam (impressões/cliques/gasto), nunca a mera contagem de campanhas criadas.
    // É uma meta subordinada aos guardrails econômicos, estoque e confirmação Amazon.
    const servingCampaignGrowthTargetPct = Math.min(Math.max(Number(body.serving_campaign_growth_target_pct ?? 40), 0), 100);
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
          snapshot_run_id: snapshotRunId,
          trigger_type: dailyClose ? 'unified_daily_economic_curve_guard' : 'unified_intraday_economic_curve_guard',
        });

    const deterministic = await invoke(base44, 'runDeterministicDecisionEngine', {
      ...common,
      skip_economic_bid_budget: true,
      skip_direct_execution: true,
      daily_close: dailyClose,
      snapshot_run_id: snapshotRunId,
    });
    const decisionV3Shadow = await invoke(base44, 'runDecisionArbiterV3', common);

    const salesRecovery = body.skip_sales_recovery === true || dailyClose
      ? { ok: true, skipped: true }
      : await invoke(base44, 'runIntradaySalesRecovery', {
          ...common,
          snapshot_run_id: snapshotRunId,
          trigger_type: 'unified_intraday_sales_recovery',
        });

    const asinDiversification = body.skip_asin_diversification === true
      ? { ok: true, skipped: true }
      : await invoke(base44, 'runAsinPortfolioDiversificationGuard', {
          ...common,
          snapshot_run_id: snapshotRunId,
          serving_campaign_growth_target_pct: servingCampaignGrowthTargetPct,
          growth_metric: 'SERVING_CAMPAIGNS',
          never_expand_for_count_only: true,
          trigger_type: dailyClose ? 'unified_daily_asin_diversification' : 'unified_intraday_asin_diversification',
        });

    const campaignLifecycle = lifecycleWindow
      ? await invoke(base44, 'runCanonicalCampaignLifecycleLayer', {
          ...common,
          daily_close: dailyClose,
          snapshot_run_id: snapshotRunId,
          serving_campaign_growth_target_pct: servingCampaignGrowthTargetPct,
          growth_metric: 'SERVING_CAMPAIGNS',
          expansion_policy: 'replace_zero_delivery_then_expand_economically_eligible',
        })
      : { ok: true, skipped: true, next_window_hours: 3 - (currentHour % 3) };

    const economicBalancer = lifecycleWindow
      ? { ok: true, skipped: true, delegated_to: 'runCanonicalCampaignLifecycleLayer' }
      : await invoke(base44, 'runEconomicBudgetBalancer', {
          ...common,
          mode: 'incremental', skip_sync: true, queue_only: true,
          snapshot_run_id: snapshotRunId, daily_close: false,
        });

    const servingGrowth = body.skip_serving_campaign_growth === true || !lifecycleWindow
      ? { ok: true, skipped: true }
      : await invoke(base44, 'runServingCampaignGrowthObjective', {
          ...common,
          snapshot_run_id: snapshotRunId,
          serving_campaign_growth_target_pct: servingCampaignGrowthTargetPct,
          max_auto_budget_expansions: body.max_auto_budget_expansions ?? 2,
          max_new_exact_per_run: body.max_new_exact_per_run ?? 2,
          delivery_lookback_days: 7,
          trigger_type: dailyClose ? 'unified_daily_serving_growth_v18' : 'unified_intraday_serving_growth_v18',
        });
    const servingGrowthReport = Array.isArray(servingGrowth?.reports) ? servingGrowth.reports[0] : null;
    const servingGrowthGap = Math.max(0, Number(servingGrowthReport?.growth_gap || 0));
    const replacementCapacity = servingGrowthReport
      ? Math.min(20, Math.max(2, servingGrowthGap))
      : 6;

    const deliveryHealth = body.skip_campaign_delivery_health === true
      ? { ok: true, skipped: true }
      : await invoke(base44, 'reconcileCampaignDeliveryHealth', {
          ...common,
          snapshot_run_id: snapshotRunId,
          serving_campaign_growth_target_pct: servingCampaignGrowthTargetPct,
          growth_metric: 'SERVING_CAMPAIGNS',
          prioritize_zero_delivery_rotation: true,
          delivery_lookback_days: 7,
          max_replacements_per_run: replacementCapacity,
          max_structure_repairs_per_run: body.max_structure_repairs_per_run ?? 3,
          max_bid_recoveries_per_run: body.max_bid_recoveries_per_run ?? 3,
        });

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
      manualStructureAudit, economicCurveAdsGuard, deterministic, decisionV3Shadow,
      salesRecovery, asinDiversification, campaignLifecycle, economicBalancer,
      servingGrowth, deliveryHealth, daypartConfiguration, daypartBudgetRestore,
      scheduledCampaignState, scheduledBidDaypart, repricing, scopeAfter,
    };
    return Response.json({
      ok: Object.values(stages).every((stage: any) => stage?.ok !== false),
      engine: 'unified-marketplace-decision-governance',
      engine_version: 'unified-v19-profitable-serving-recovery',
      correlation_id: correlationId,
      snapshot_run_id: snapshotRunId,
      daily_close: dailyClose,
      dry_run: dryRun,
      serving_campaign_growth_goal: {
        target_growth_pct: servingCampaignGrowthTargetPct,
        metric: 'SERVING_CAMPAIGNS',
        baseline_serving_campaigns: servingGrowthReport?.baseline_serving_campaigns ?? null,
        current_serving_campaigns: servingGrowthReport?.current_serving_campaigns ?? null,
        target_serving_campaigns: servingGrowthReport?.target_serving_campaigns ?? null,
        growth_gap: servingGrowthReport?.growth_gap ?? null,
        goal_met: servingGrowthReport?.goal_met === true,
        definition: 'campanhas elegíveis com entrega real; não campanhas apenas existentes',
        completion_rule: 'cumprida somente quando current_serving_campaigns >= target_serving_campaigns',
        policy: 'AUTO limitada por orçamento recebe discovery econômico; ZERO_DELIVERY usa reparo 1:1 com safe_max_cpc e teto de perda por ASIN; campanhas com gasto sem venda não recebem expansão',
        scheduler_driven: true,
        confirmation_required: true,
      },
      economic_ads_guard: {
        function: 'runEconomicCurveAdsGuard',
        sales_curve: 'ABC 80/15/5',
        profit_curve: 'ABC por lucro pós-Ads real persistido',
        dynamic_asin_loss_budget: true,
        sequential_zero_sale_ceiling: true,
        bayesian_cvr_guard: true,
        mer_tacos_guardrail: true,
        protects_profitable_winners: true,
        execution_owner: 'executeApprovedDecisionQueue',
        confirmation_required: true,
      },
      sales_recovery: {
        function: 'runIntradaySalesRecovery',
        automatic: true,
        policy: 'quando receita fica abaixo da trajetória, corta perdedores e transfere capacidade para vencedores comprovados sem elevar gasto agregado por princípio',
        max_bid_step_pct: 8,
        max_budget_step_pct: 10,
        top_of_search_change: false,
        execution_owner: 'executeApprovedDecisionQueue',
        confirmation_required: true,
      },
      delivery_rotation: {
        function: 'reconcileCampaignDeliveryHealth',
        automatic: true,
        zero_delivery_test_hours: 72,
        max_bid_recovery_attempts: 2,
        max_replacements_per_run: replacementCapacity,
        max_structure_repairs_per_run: body.max_structure_repairs_per_run ?? 3,
        max_bid_recoveries_per_run: body.max_bid_recoveries_per_run ?? 3,
        economic_bid_cap: true,
        trusted_bootstrap_economics: 'somente custo confirmado, preço, break-even e safe_max_cpc explícitos',
        asin_zero_sale_spend_cap: 'clamp(4 x safe_max_cpc, R$2,50, R$5,00)',
        duplicate_campaign_rows_removed_before_decision: true,
        serving_evidence_prevents_false_structure_repair: true,
        replacement_priority: 'same-SKU converted Search Terms from canonical harvest',
        pause_old_only_after_confirmed_replacement: true,
        execution_owner: 'executeApprovedDecisionQueue',
        confirmation_required: true,
      },
      campaign_lifecycle: {
        due: lifecycleWindow,
        interval_hours: 3,
        brt_hour: currentHour,
        schedule_owner: 'runUnifiedDecisionEngine',
        serving_campaign_growth_target_pct: servingCampaignGrowthTargetPct,
        serving_growth_stage: 'runServingCampaignGrowthObjective',
      },
      asin_portfolio: {
        automatic: true,
        ui_required: false,
        policy: 'exploration floor for economically eligible ASINs + concentration cap; economic curve guard and sales recovery have precedence over exploration',
        serving_campaign_growth_target_pct: servingCampaignGrowthTargetPct,
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
