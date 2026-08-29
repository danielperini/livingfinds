import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

const invoke = async (base44: any, name: string, payload: Record<string, unknown>) => {
  try {
    const result = await base44.asServiceRole.functions.invoke(name, payload);
    return result?.data || result || { ok: true };
  } catch (error: any) {
    return { ok: false, error: error?.response?.data?.error || error?.message || String(error) };
  }
};

function brDate(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

const ACTIVE_PROMOTION_STATES = new Set([
  'campaign_creating', 'campaign_created', 'ad_group_created', 'product_ad_created',
  'keyword_created', 'enabling', 'manual_active', 'negative_creating', 'negative_created',
  'completed', 'repair_required', 'failed_retryable',
]);

const numberFrom = (value: any, ...keys: string[]) => keys.reduce((result, key) =>
  result || Number(value?.[key] || 0), 0);

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    const configuredInternalToken = Deno.env.get('INTERNAL_FUNCTION_TOKEN') ||
      Deno.env.get('API_TOKEN') ||
      Deno.env.get('ADMIN_PASSWORD') ||
      '';
    const presentedInternalToken = request.headers.get('x-internal-invocation-token') || '';
    const internalAuthorized = Boolean(configuredInternalToken) && presentedInternalToken === configuredInternalToken;
    if (!authenticated && !internalAuthorized) {
      return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    const correlationId = body.correlation_id || crypto.randomUUID();
    const accountId = body.amazon_account_id || null;
    const dryRun = body.dry_run === true;
    const today = brDate();
    const requestedNewExactToday = Math.max(0, Math.min(20, Number(body.max_new_exact_today ?? 20)));
    const tomorrowTarget = Math.max(0, Math.min(50, Number(body.tomorrow_new_exact_target ?? 10)));
    const maxActions = Math.max(12, Math.min(180, Number(body.max_actions ?? 180)));

    const common = {
      amazon_account_id: accountId,
      _service_role: true,
      _canonical_orchestrator: 'runUnifiedDecisionEngine',
      decision_engine_correlation_id: correlationId,
      dry_run: dryRun,
    };

    const promotionFilter: any = accountId ? { amazon_account_id: accountId } : {};
    const todayPromotions = await base44.asServiceRole.entities.SearchTermPromotion
      .filter(promotionFilter, '-created_at', 10000).catch(() => []);
    const exactAlreadyStartedToday = todayPromotions.filter((p: any) =>
      String(p.created_at || '').slice(0, 10) === today &&
      ACTIVE_PROMOTION_STATES.has(String(p.promotion_status || '').toLowerCase())
    ).length;
    const exactRemainingToday = Math.max(0, requestedNewExactToday - exactAlreadyStartedToday);

    const snapshots = await invoke(base44, 'buildCanonicalMarketplaceSnapshots', {
      ...common,
      mode: 'incremental',
      persist: !dryRun,
      window_minutes: 15,
    });
    const snapshotRunId = snapshots.run_id || snapshots.snapshot_run_id || correlationId;

    const aiStrategy = body.skip_ai_strategy === true
      ? { ok: true, skipped: true }
      : await invoke(base44, 'aiEngine', {
          ...common,
          mode: 'claude_analyze',
          prompt: 'Analise a conta Amazon Ads com foco exclusivo em aumentar vendas lucrativas. Para cada oportunidade, retorne winner_score, waste_score, confidence, expected_incremental_sales e reason. Priorize termos same-SKU convertidos, cobertura competitiva de vencedores, redução de desperdício, risco de canibalização e oportunidades de redistribuição de orçamento. Não proponha ultrapassar ACoS/meta econômica, estoque ou teto diário: hard guards determinísticos são soberanos.',
          context: {
            objective: 'maximize_sales_with_economic_guardrails',
            snapshot_run_id: snapshotRunId,
            exact_daily_cap: requestedNewExactToday,
            exact_already_started_today: exactAlreadyStartedToday,
            exact_remaining_today: exactRemainingToday,
            pause_daily_cap: 'unlimited_when_economically_proven',
          },
        });

    const harvest = exactRemainingToday > 0
      ? await invoke(base44, 'runImmediateSameSkuSearchTermHarvest', {
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
          max_promotions: exactRemainingToday,
          require_stock: true,
          require_active_product: true,
          trigger_type: 'sales_mode_winner_harvest',
        })
      : { ok: true, skipped: true, reason: 'daily_exact_quota_reached', max_promotions: 0 };

    // V4: o winner same-SKU não aguarda o próximo tick do scheduler. A fila
    // deduplicada é drenada no mesmo ciclo e nunca acima do saldo diário.
    const queuedFromHarvest = Math.max(0, Number(harvest?.queued_count || 0));
    const kickoffDrain = !dryRun && exactRemainingToday > 0 && queuedFromHarvest > 0
      ? await invoke(base44, 'processProductKickoffQueueV2', {
          ...common,
          force: true,
          ignore_window: true,
          max_items: Math.min(exactRemainingToday, queuedFromHarvest),
          trigger_type: 'sales_mode_same_cycle_harvest_drain_v4',
        })
      : { ok: true, skipped: true, reason: dryRun ? 'dry_run' : 'nothing_new_to_drain' };

    const bidRecovery = await invoke(base44, 'runIntradaySalesRecovery', {
      ...common,
      snapshot_run_id: snapshotRunId,
      trigger_type: 'sales_mode_bid_recovery',
      max_bid_step_pct: body.max_bid_step_pct ?? 15,
      competitive_coverage_bid_step_pct: body.competitive_bid_step_pct ?? 10,
      max_budget_step_pct: body.max_budget_step_pct ?? 12,
    });

    // P0_CANONICAL_BID_EXECUTION_V3:
    // smartBidFromCpc deixou de ser executor. Bid econômico é produzido pelos
    // motores canônicos e executado somente por executeApprovedDecisionQueue.
    const bidEconomics = {
      ok: true,
      skipped: true,
      canonical_queue_only: true,
      direct_amazon_write: false,
      reason: 'P0_CANONICAL_BID_EXECUTION_ONLY',
    };

    const waste = await invoke(base44, 'runSalesModeWasteRotation', {
      ...common,
      snapshot_run_id: snapshotRunId,
      lookback_days: body.waste_lookback_days ?? 7,
      min_age_days: body.waste_min_age_days ?? 7,
      trigger_type: 'sales_mode_waste_rotation',
    });

    const economicGuard = await invoke(base44, 'runEconomicCurveAdsGuard', {
      ...common,
      max_actions: body.max_economic_guard_actions ?? 30,
      target_mer_pct: body.target_mer_pct,
      snapshot_run_id: snapshotRunId,
      trigger_type: 'sales_mode_economic_curve_guard',
    });

    const budget = await invoke(base44, 'runEconomicBudgetBalancer', {
      ...common,
      mode: 'all',
      queue_only: true,
      skip_sync: true,
      snapshot_run_id: snapshotRunId,
      enable_intraday_reallocation: true,
      protect_winners_from_budget_exhaustion: true,
      never_exceed_account_daily_budget: true,
    });

    const executionPasses: any[] = [];
    if (!dryRun) {
      const maxPasses = Math.min(15, Math.max(1, Math.ceil(maxActions / 12)));
      let totalProcessed = 0;
      for (let pass = 0; pass < maxPasses && totalProcessed < maxActions; pass++) {
        const execution = await invoke(base44, 'executeApprovedDecisionQueue', {
          ...common,
          snapshot_run_id: snapshotRunId,
          expedited: true,
          trigger_type: 'sales_mode_execute_now',
        });
        executionPasses.push(execution);
        const processed = Number(execution?.processed || 0);
        totalProcessed += processed;
        if (processed <= 0 || Number(execution?.remaining || 0) <= 0) break;
      }
    }
    const execution = dryRun
      ? { ok: true, skipped: true, reason: 'dry_run', passes: [] }
      : {
          ok: executionPasses.every((p: any) => p?.ok !== false),
          passes: executionPasses,
          processed: executionPasses.reduce((s: number, p: any) => s + Number(p?.processed || 0), 0),
          executed: executionPasses.reduce((s: number, p: any) => s + Number(p?.executed || 0), 0),
          failed: executionPasses.reduce((s: number, p: any) => s + Number(p?.failed || 0), 0),
          remaining: executionPasses.length ? Number(executionPasses[executionPasses.length - 1]?.remaining || 0) : 0,
        };

    const stages = { snapshots, aiStrategy, harvest, kickoffDrain, bidRecovery, bidEconomics, waste, economicGuard, budget, execution };
    const wasteRows = Array.isArray(waste?.results) ? waste.results : [];
    const metrics = {
      terms_harvested: numberFrom(harvest, 'aggregates', 'terms_harvested', 'candidates'),
      exact_created: numberFrom(harvest, 'promoted_count', 'promotions_created', 'created'),
      promoted_sales: numberFrom(harvest, 'same_sku_sales_promoted', 'promoted_sales'),
      spend_reallocated_to_winners: numberFrom(budget, 'reallocated_spend', 'winner_budget_increase'),
      bids_raised: numberFrom(bidRecovery, 'bids_raised', 'increased') + numberFrom(bidEconomics, 'bids_raised', 'increased'),
      bids_reduced: numberFrom(bidRecovery, 'bids_reduced', 'reduced') + wasteRows.reduce((sum: number, row: any) => sum + Number(row.bid_reductions || 0), 0),
      pauses: wasteRows.reduce((sum: number, row: any) => sum + Number(row.pauses || 0), 0),
      amazon_confirmations: numberFrom(execution, 'confirmed', 'confirmations'),
      governance_blocks: numberFrom(execution, 'blocked', 'governance_blocked'),
    };
    return Response.json({
      ok: Object.values(stages).every((stage: any) => stage?.ok !== false),
      engine: 'sales-mode-v1.3-safety',
      objective: 'maximize_sales_with_economic_guardrails',
      correlation_id: correlationId,
      snapshot_run_id: snapshotRunId,
      security: {
        authenticated_user: authenticated,
        internal_invocation: internalAuthorized,
        dry_run_blocks_direct_bid_writes: true,
      },
      targets: {
        max_new_exact_today: requestedNewExactToday,
        exact_already_started_today: exactAlreadyStartedToday,
        exact_remaining_before_run: exactRemainingToday,
        campaign_pauses_daily_limit: 'unlimited_when_economically_proven',
        tomorrow_new_exact_target: tomorrowTarget,
        max_actions_this_run: maxActions,
      },
      policy: {
        primary_kpi: 'orders_sales_and_post_ads_profit',
        winner_source: 'same-SKU converted search terms from AUTO and MANUAL campaigns',
        new_campaign_rule: 'daily quota; create only from proven winner or economically justified discovery',
        pause_rule: 'hold → bid reductions → pause only after persistent economic proof; never pause protected winners',
        bid_rule: 'restore competitive winners in reversible steps; cut bids with CPC/ACoS evidence and cooldown',
        budget_rule: 'reallocate toward winners without breaching account cap',
        ai_rule: 'AI advises strategy; deterministic economic guardrails remain sovereign',
        execution: 'canonical queue drained in batches of 12 + Amazon confirmation',
      },
      metrics,
      stages,
    });
  } catch (error: any) {
    return Response.json({ ok: false, engine: 'sales-mode-v1.3-safety', error: error?.message || 'Falha no modo vendas' }, { status: 500 });
  }
});
