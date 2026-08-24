import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

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
    if (!authenticated && !body._service_role) {
      return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    const correlationId = body.correlation_id || crypto.randomUUID();
    const common = {
      amazon_account_id: body.amazon_account_id || null,
      _service_role: true,
      _canonical_orchestrator: 'runUnifiedDecisionEngine',
      decision_engine_correlation_id: correlationId,
      dry_run: body.dry_run === true,
    };

    // SALES MODE: venda e lucro pós-Ads são o objetivo primário. Crescimento de
    // campanha só acontece quando existe sinal de conversão, entrega competitiva
    // ou necessidade econômica de descoberta para ASIN elegível.
    const snapshots = await invoke(base44, 'buildCanonicalMarketplaceSnapshots', {
      ...common,
      mode: 'incremental',
      persist: true,
      window_minutes: 15,
    });
    const snapshotRunId = snapshots.run_id || snapshots.snapshot_run_id || correlationId;

    const harvest = await invoke(base44, 'runImmediateSameSkuSearchTermHarvest', {
      ...common,
      snapshot_run_id: snapshotRunId,
      lookback_days: body.lookback_days ?? 65,
      minimum_orders: 1,
      initial_exact_test_hours: 72,
      maximum_orders_for_initial_promotion: 5,
      inherit_source_bid: true,
      create_manual_exact: true,
      one_term_per_campaign: true,
      include_manual_sources: true,
      negative_exact_after_manual_confirmation: true,
      queue_only: true,
      max_promotions: body.max_new_exact_today ?? 20,
      require_stock: true,
      require_active_product: true,
      trigger_type: 'sales_mode_winner_harvest',
    });

    const bidRecovery = await invoke(base44, 'runIntradaySalesRecovery', {
      ...common,
      snapshot_run_id: snapshotRunId,
      trigger_type: 'sales_mode_bid_recovery',
      max_bid_step_pct: body.max_bid_step_pct ?? 10,
      competitive_coverage_bid_step_pct: body.competitive_bid_step_pct ?? 7,
      max_budget_step_pct: body.max_budget_step_pct ?? 12,
    });

    const bidEconomics = await invoke(base44, 'smartBidFromCpc', {
      ...common,
      manual_only: false,
      target_source: 'PerformanceSettings',
      reduce_only_when_unprofitable: true,
      never_exceed_target_acos: true,
      trigger_type: 'sales_mode_economic_bid_control',
    });

    const waste = await invoke(base44, 'runWeeklyWasteTermsCleanup', {
      ...common,
      mode: 'sales_mode',
      lookback_hours: body.waste_lookback_hours ?? 168,
      allow_campaign_pause: true,
      apply_negative_terms: true,
      include_auto: true,
      include_manual: true,
      max_campaign_pauses: body.max_campaign_pauses_today ?? 100,
      protect_converted_entities: true,
      require_evidence_before_pause: true,
      trigger_type: 'sales_mode_waste_rotation',
    });

    const lifecycle = await invoke(base44, 'runCanonicalCampaignLifecycleLayer', {
      ...common,
      snapshot_run_id: snapshotRunId,
      force_sales_mode: true,
      serving_campaign_growth_target_pct: 0,
      growth_metric: 'SALES_AND_PROFIT',
      expansion_policy: 'winner_harvest_first_then_economic_discovery',
      max_new_exact_per_run: body.max_new_exact_today ?? 20,
      max_replacements_per_run: body.max_campaign_pauses_today ?? 100,
    });

    const budget = await invoke(base44, 'runEconomicBudgetBalancer', {
      ...common,
      mode: 'all',
      queue_only: true,
      skip_sync: true,
      snapshot_run_id: snapshotRunId,
      enable_intraday_reallocation: true,
      protect_winners_from_budget_exhaustion: true,
      prioritize_sales_velocity: true,
      never_exceed_account_daily_budget: true,
    });

    const execution = body.dry_run === true
      ? { ok: true, skipped: true, reason: 'dry_run' }
      : await invoke(base44, 'executeApprovedDecisionQueue', {
          ...common,
          snapshot_run_id: snapshotRunId,
          expedited: true,
          max_actions: body.max_actions ?? 180,
          trigger_type: 'sales_mode_execute_now',
        });

    const stages = { snapshots, harvest, bidRecovery, bidEconomics, waste, lifecycle, budget, execution };
    return Response.json({
      ok: Object.values(stages).every((stage: any) => stage?.ok !== false),
      engine: 'sales-mode-v1',
      objective: 'maximize_sales_with_economic_guardrails',
      correlation_id: correlationId,
      snapshot_run_id: snapshotRunId,
      targets: {
        max_new_exact_today: body.max_new_exact_today ?? 20,
        max_campaign_pauses_today: body.max_campaign_pauses_today ?? 100,
        tomorrow_new_exact_target: body.tomorrow_new_exact_target ?? 10,
      },
      policy: {
        primary_kpi: 'orders_sales_and_post_ads_profit',
        winner_source: 'same-SKU converted search terms from AUTO and MANUAL campaigns',
        new_campaign_rule: 'create only from proven winner or economically justified discovery',
        pause_rule: 'pause only with evidence; never pause protected converters merely to hit quota',
        bid_rule: 'raise competitive bids in reversible steps; cut bids when economics deteriorate',
        budget_rule: 'reallocate toward winners without breaching account cap',
        execution: 'canonical queue + Amazon confirmation',
      },
      stages,
    });
  } catch (error: any) {
    return Response.json({ ok: false, engine: 'sales-mode-v1', error: error?.message || 'Falha no modo vendas' }, { status: 500 });
  }
});
