import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { CAMPAIGN_LIFECYCLE_VERSION, shouldRetireAutoCampaign } from '../../shared/campaignLifecyclePolicy.ts';
import { productAdsEligibility } from '../../shared/productAdsEligibility.ts';

const invoke = async (base44: any, name: string, payload: Record<string, unknown>) => {
  try {
    const response = await base44.asServiceRole.functions.invoke(name, payload);
    return response?.data || response || { ok: true };
  } catch (error: any) {
    return { ok: false, error: error?.response?.data?.error || error?.message || String(error) };
  }
};

const active = (value: unknown) => ['enabled', 'active'].includes(String(value || '').toLowerCase());
const upper = (value: unknown) => String(value || '').trim().toUpperCase();
const finite = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;
const campaignId = (row: any) => String(row.amazon_campaign_id || row.campaign_id || row.id || '');
const isAuto = (row: any) => upper(row.targeting_type) === 'AUTO' || upper(row.name || row.campaign_name).startsWith('AUTO |');

function daysOld(value: unknown) {
  const time = new Date(String(value || '')).getTime();
  if (!Number.isFinite(time)) return 0;
  return Math.max(0, (Date.now() - time) / 86400000);
}

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    if (!authenticated && !body._service_role) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    if (body._canonical_orchestrator !== 'runUnifiedDecisionEngine') {
      return Response.json({ ok: false, error: 'Uso exclusivo pelo motor canônico' }, { status: 403 });
    }

    const accounts = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1)
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-updated_at', 50);
    const results: any[] = [];

    for (const account of accounts) {
      const accountId = String(account.id);
      const common = {
        amazon_account_id: accountId,
        _service_role: true,
        _canonical_orchestrator: 'runUnifiedDecisionEngine',
        decision_engine_correlation_id: body.decision_engine_correlation_id || crypto.randomUUID(),
        dry_run: body.dry_run === true,
      };

      const [settingsRows, campaigns, products, metricsRows, priorDecisions] = await Promise.all([
        base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id: accountId }, '-updated_at', 1).catch(() => []),
        base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: accountId }, '-created_at', 10000).catch(() => []),
        base44.asServiceRole.entities.Product.filter({ amazon_account_id: accountId }, null, 5000).catch(() => []),
        base44.asServiceRole.entities.CampaignMetricsDaily.filter({ amazon_account_id: accountId }, '-date', 10000).catch(() => []),
        base44.asServiceRole.entities.OptimizationDecision.filter({ amazon_account_id: accountId }, '-created_at', 30000).catch(() => []),
      ]);
      const settings = settingsRows[0] || {};
      const targetAcos = finite(settings.target_acos || settings.acos_target || 15);
      const globalBudget = finite(settings.daily_budget_global || settings.account_daily_budget_limit || settings.daily_budget || 0);
      const minBid = finite(settings.min_bid || 0.2);
      const maxBid = finite(settings.max_bid || 3);
      const increment = finite(settings.bid_increment || settings.allowed_increment || 0.1);
      const maxSpendWithoutSale = finite(settings.max_spend_without_sale || Math.max(5, globalBudget * 0.05));

      const productByAsin = new Map(products.filter((p: any) => p.asin).map((p: any) => [upper(p.asin), p]));
      const eligibilityByAsin = new Map([...productByAsin.entries()].map(([asin, product]) => [asin, productAdsEligibility(product)]));
      const eligibleAsins = [...eligibilityByAsin.entries()].filter(([, eligibility]) => eligibility.eligible).map(([asin]) => asin);

      const kickoff = await invoke(base44, 'ensureActiveProductCampaignCoverage', {
        ...common,
        auto_initial_bid: 0.5,
        manual_initial_bid: 0.6,
        maximum_initial_manual_campaigns: 4,
        minimum_term_relevance: 0.9,
        exact_only: true,
        one_term_per_campaign: true,
        require_stock: true,
        require_active_product: true,
        eligible_asins: eligibleAsins,
        term_source_order: ['TermBank', 'AmazonAdsSuggestions'],
        idempotent_by: ['amazon_account_id', 'asin', 'normalized_term', 'match_type'],
      });

      const harvesting = await invoke(base44, 'runImmediateSameSkuSearchTermHarvest', {
        ...common,
        lookback_days: 65,
        minimum_orders: 2,
        maximum_orders_for_initial_promotion: 3,
        target_acos: targetAcos,
        target_acos_source: 'PerformanceSettings',
        inherit_source_bid: true,
        create_manual_exact: true,
        one_term_per_campaign: true,
        include_manual_sources: true,
        negative_exact_after_manual_confirmation: true,
        queue_only: true,
        max_promotions: 25,
        require_stock: true,
        require_active_product: true,
        eligible_asins: eligibleAsins,
      });

      const autoDedup = await invoke(base44, 'deduplicateAutoCampaignsByAsin', {
        ...common,
        dry_run: body.dry_run === true,
        trigger_type: 'canonical_campaign_lifecycle',
      });

      const wasteGuard = await invoke(base44, 'runWeeklyWasteTermsCleanup', {
        ...common,
        mode: 'daily_guard',
        lookback_hours: 48,
        max_term_words: 3,
        allow_campaign_pause: false,
        max_spend_without_sale: maxSpendWithoutSale,
        negative_match_type: 'NEGATIVE_EXACT',
        include_auto: true,
        include_manual: true,
        eligible_asins: eligibleAsins,
        trigger_type: 'canonical_campaign_lifecycle',
      });

      const manualBidGuard = await invoke(base44, 'smartBidFromCpc', {
        ...common,
        manual_only: true,
        target_source: 'PerformanceSettings',
        target_acos: targetAcos,
        min_bid: minBid,
        max_bid: maxBid,
        increment,
        reduce_only_when_unprofitable: true,
        max_spend_without_sale: maxSpendWithoutSale,
        never_exceed_target_acos: true,
        eligible_asins: eligibleAsins,
        trigger_type: 'canonical_campaign_lifecycle',
      });

      const budget = await invoke(base44, 'runEconomicBudgetBalancer', {
        ...common,
        mode: 'all',
        queue_only: true,
        skip_sync: true,
        daily_close: body.daily_close === true,
        project_daily_spend_per_campaign: true,
        global_budget_limit: globalBudget,
        global_budget_source: 'PerformanceSettings',
        enable_intraday_reallocation: true,
        protect_winners_from_budget_exhaustion: true,
        never_exceed_account_daily_budget: true,
        eligible_asins: eligibleAsins,
      });

      const lastThreeDays = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
      const metricsByCampaign = new Map<string, { orders: number; sales: number }>();
      for (const row of metricsRows) {
        if (String(row.date || '') < lastThreeDays) continue;
        const id = String(row.campaign_id || '');
        const agg = metricsByCampaign.get(id) || { orders: 0, sales: 0 };
        agg.orders += finite(row.orders);
        agg.sales += finite(row.sales);
        metricsByCampaign.set(id, agg);
      }

      const retirementDecisions: any[] = [];
      for (const campaign of campaigns) {
        if (!active(campaign.state || campaign.status)) continue;
        const id = campaignId(campaign);
        const asin = upper(campaign.asin || campaign.advertised_asin || (String(campaign.name || '').match(/B0[A-Z0-9]{8}/i)?.[0]));
        if (!id || !asin) continue;

        const product = productByAsin.get(asin);
        const eligibility = productAdsEligibility(product);
        if (!eligibility.eligible) {
          const reasonCode = eligibility.reason;
          const key = `CAMPAIGN_PRODUCT_ELIGIBILITY|${accountId}|${id}|${reasonCode}`;
          if (priorDecisions.some((row: any) => row.idempotency_key === key && !['failed', 'rejected', 'cancelled', 'expired'].includes(String(row.status || '')))) continue;
          if (body.dry_run === true) {
            retirementDecisions.push({ campaign_id: id, asin, reason_code: reasonCode, dry_run: true });
            continue;
          }
          const decision = await base44.asServiceRole.entities.OptimizationDecision.create({
            amazon_account_id: accountId,
            decision_type: 'product_ads_eligibility',
            entity_type: 'campaign',
            entity_id: id,
            campaign_id: id,
            campaign_name: campaign.name || campaign.campaign_name || null,
            asin,
            sku: product?.sku || null,
            action: 'pause_campaign',
            canonical_action_type: 'CAMPAIGN_STATE_CHANGE',
            rationale: reasonCode === 'PRODUCT_INACTIVE'
              ? 'Produto inativo no catálogo canônico: campanha retirada da operação para não consumir verba nem esforço do motor.'
              : reasonCode === 'PRODUCT_OUT_OF_STOCK'
                ? 'Produto sem estoque disponível: campanha retirada da operação até o estoque retornar.'
                : 'Produto não elegível para Ads no catálogo canônico: campanha retirada da operação até regularização.',
            rule_key: reasonCode,
            reason_code: reasonCode,
            value_before: 'ENABLED',
            value_after: 'PAUSED',
            confidence: 1,
            risk: 'low',
            requires_approval: false,
            approval_status: 'auto_approved_deterministic',
            status: 'approved',
            queue_status: 'pending',
            priority_class: 'P1',
            execution_mode: 'EXPEDITED_QUEUE',
            confirmation_required: true,
            confirmation_status: 'pending',
            idempotency_key: key,
            conflict_group: `${accountId}|campaign|${id}`,
            source_function: 'runCanonicalCampaignLifecycleLayer',
            model_version: CAMPAIGN_LIFECYCLE_VERSION,
            data_used: JSON.stringify({ asin, sku: product?.sku || null, product_status_signals: eligibility.statusSignals, stock: eligibility.stock, eligibility_reason: reasonCode }),
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });
          retirementDecisions.push({ campaign_id: id, asin, reason_code: reasonCode, decision_id: decision.id });
          continue;
        }

        if (!isAuto(campaign)) continue;
        const metrics = metricsByCampaign.get(id) || { orders: 0, sales: 0 };
        const retire = shouldRetireAutoCampaign({
          ageDays: daysOld(campaign.created_at || campaign.created_date),
          consecutiveDaysWithoutSales: metrics.orders === 0 && metrics.sales === 0 ? 3 : 0,
          protectedWinner: campaign.protected_high_performance === true,
          inStock: true,
          structurallyComplete: campaign.incomplete !== true,
        });
        if (!retire) continue;
        const key = `AUTO_LIFECYCLE_RETIRE|${accountId}|${id}|30D_3D_NO_SALES`;
        if (priorDecisions.some((row: any) => row.idempotency_key === key && !['failed', 'rejected', 'cancelled'].includes(String(row.status || '')))) continue;
        if (body.dry_run === true) {
          retirementDecisions.push({ campaign_id: id, asin, reason_code: 'AUTO_30D_3D_NO_SALES_RETIRE', dry_run: true });
          continue;
        }
        const decision = await base44.asServiceRole.entities.OptimizationDecision.create({
          amazon_account_id: accountId,
          decision_type: 'automatic_campaign_lifecycle',
          entity_type: 'campaign',
          entity_id: id,
          campaign_id: id,
          campaign_name: campaign.name || campaign.campaign_name || null,
          action: 'pause_campaign',
          canonical_action_type: 'CAMPAIGN_STATE_CHANGE',
          rationale: 'AUTO com pelo menos 30 dias e 3 dias consecutivos sem vendas após garimpo final de termos.',
          rule_key: 'AUTO_30D_3D_NO_SALES_RETIRE',
          reason_code: 'AUTO_30D_3D_NO_SALES_RETIRE',
          value_before: 'ENABLED',
          value_after: 'PAUSED',
          confidence: 1,
          risk: 'medium',
          requires_approval: false,
          approval_status: 'auto_approved_deterministic',
          status: 'approved',
          queue_status: 'pending',
          execution_mode: 'STANDARD_QUEUE',
          confirmation_required: true,
          confirmation_status: 'pending',
          idempotency_key: key,
          conflict_group: `${accountId}|campaign|${id}`,
          source_function: 'runCanonicalCampaignLifecycleLayer',
          model_version: CAMPAIGN_LIFECYCLE_VERSION,
          data_used: JSON.stringify({ age_days: daysOld(campaign.created_at || campaign.created_date), last_3d_orders: metrics.orders, last_3d_sales: metrics.sales, asin, final_harvest_stage: harvesting?.ok !== false }),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
        retirementDecisions.push({ campaign_id: id, asin, reason_code: 'AUTO_30D_3D_NO_SALES_RETIRE', decision_id: decision.id });
      }

      await base44.asServiceRole.entities.SyncExecutionLog.create({
        amazon_account_id: accountId,
        sync_type: 'canonical_campaign_lifecycle',
        status: [kickoff, harvesting, autoDedup, wasteGuard, manualBidGuard, budget].some((stage: any) => stage?.ok === false) ? 'partial' : 'completed',
        source_function: 'runCanonicalCampaignLifecycleLayer',
        records_processed: campaigns.length,
        records_imported: retirementDecisions.length,
        message: `Ciclo centralizado: ${eligibleAsins.length} ASIN(s) ativos com estoque; ${retirementDecisions.length} campanha(s) em retirada/encerramento; target ACoS ${targetAcos}%; budget global ${globalBudget}.`,
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
      }).catch(() => {});

      results.push({
        amazon_account_id: accountId,
        settings: { target_acos: targetAcos, global_budget: globalBudget, min_bid: minBid, max_bid: maxBid, increment, max_spend_without_sale: maxSpendWithoutSale },
        product_eligibility: { active_in_stock_asins: eligibleAsins.length, policy: 'active_and_in_stock_only' },
        stages: { kickoff, harvesting, autoDedup, wasteGuard, manualBidGuard, budget },
        retirement_decisions: retirementDecisions,
      });
    }

    return Response.json({
      ok: results.every((row) => Object.values(row.stages).every((stage: any) => stage?.ok !== false)),
      engine: CAMPAIGN_LIFECYCLE_VERSION,
      schedule_owner: 'runUnifiedDecisionEngine',
      interval_hours: 3,
      product_eligibility_policy: 'active_and_in_stock_only',
      results,
    });
  } catch (error: any) {
    return Response.json({ ok: false, engine: CAMPAIGN_LIFECYCLE_VERSION, error: error?.message || 'Falha no ciclo canônico de campanhas' }, { status: 500 });
  }
});
