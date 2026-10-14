import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { productAdsEligibility } from '../../shared/productAdsEligibility.ts';
import { resolveProductScope, uniqueCampaignRows } from '../../shared/skuCampaignScope.ts';
import { aggregateLatestCampaignMetrics, campaignSnapshotCoverage } from '../../shared/campaignMetricsIntegrity.ts';

const SOURCE = 'runAsinPortfolioDiversificationGuard';
const finite = (value: unknown, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const upper = (value: unknown) => String(value || '').trim().toUpperCase();
const lower = (value: unknown) => String(value || '').trim().toLowerCase();
const active = (value: unknown) => ['enabled', 'active'].includes(lower(value));
const campaignIdOf = (row: any) => String(row.amazon_campaign_id || row.campaign_id || row.id || '');
const roundMoney = (value: number) => Math.round(value * 100) / 100;
const snapshotIsActive = (value: unknown) => !['inactive', 'closed', 'not_found', 'error', 'suppressed'].includes(lower(value));

function brtDate(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
}

function latestByCampaign(rows: any[]): Map<string, any> {
  const sorted = [...rows].sort((a, b) => new Date(String(b.observed_at || b.created_at || 0)).getTime() - new Date(String(a.observed_at || a.created_at || 0)).getTime());
  const map = new Map<string, any>();
  for (const row of sorted) {
    const id = String(row.campaign_id || '');
    if (id && !map.has(id)) map.set(id, row);
  }
  return map;
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
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, undefined, 1)
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-updated_at', 50);
    const results: any[] = [];
    const today = brtDate();

    for (const account of accounts) {
      const accountId = String(account.id);
      const [settingsRows, campaigns, productAds, products, intradayRows, priorDecisions, canonicalSnapshots, campaignMetricRows] = await Promise.all([
        base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id: accountId }, '-updated_at', 1).catch(() => []),
        base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: accountId }, '-updated_at', 5000).catch(() => []),
        base44.asServiceRole.entities.ProductAd.filter({ amazon_account_id: accountId }, '-updated_at', 10000).catch(() => []),
        base44.asServiceRole.entities.Product.filter({ amazon_account_id: accountId }, '-updated_at', 5000).catch(() => []),
        base44.asServiceRole.entities.IntradaySpendSnapshot.filter({ amazon_account_id: accountId, spend_date: today }, '-observed_at', 10000).catch(() => []),
        base44.asServiceRole.entities.OptimizationDecision.filter({ amazon_account_id: accountId }, '-created_at', 10000).catch(() => []),
        body.snapshot_run_id
          ? base44.asServiceRole.entities.RepricingSnapshot.filter({ amazon_account_id: accountId, run_id: body.snapshot_run_id }, '-created_at', 10000).catch(() => [])
          : base44.asServiceRole.entities.RepricingSnapshot.filter({ amazon_account_id: accountId }, '-created_at', 10000).catch(() => []),
        base44.asServiceRole.entities.CampaignMetricsDaily.filter({ amazon_account_id: accountId }, '-date', 10000).catch(() => []),
      ]);

      const settings = settingsRows[0] || {};
      const targetAcos = finite(settings.target_acos || settings.acos_target, 15);
      const accountBudget = Math.max(0, finite(settings.account_daily_budget_limit || settings.daily_budget_global || settings.daily_budget, 0));
      const explorationPoolShare = Math.min(0.30, Math.max(0.15, finite(settings.asin_exploration_pool_share, 0.25)));
      const maxAsinShare = Math.min(0.40, Math.max(0.20, finite(settings.max_asin_spend_share, 0.30)));
      const maxWinnerShare = Math.min(0.45, Math.max(maxAsinShare, finite(settings.max_winner_asin_spend_share, 0.35)));
      const minCampaignBudget = Math.max(5, finite(settings.minimum_campaign_budget, 5));
      const minEconomicConfidence = Math.min(1, Math.max(0.5, finite(settings.unified_min_economic_confidence, 90) / 100));
      const latest = latestByCampaign(intradayRows);
      const lookbackStart = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);
      const recentCampaignMetrics = aggregateLatestCampaignMetrics(campaignMetricRows, { startDate: lookbackStart, endDate: today });
      const snapshotFor = (product: any, asin: string) => {
        const sorted = [...canonicalSnapshots].sort((a: any, b: any) =>
          new Date(String(b.updated_at || b.created_at || 0)).getTime() -
          new Date(String(a.updated_at || a.created_at || 0)).getTime());
        if (product?.sku) return sorted.find((snapshot: any) => upper(snapshot.sku) === upper(product.sku)) || null;
        const asinProducts = products.filter((candidate: any) => upper(candidate.asin) === asin);
        if (asinProducts.length !== 1) return null;
        return sorted.find((snapshot: any) => upper(snapshot.asin) === asin && !snapshot.sku) || null;
      };
      const snapshotBlockers = (snapshot: any, increase: boolean): string[] => {
        if (!snapshot?.id) return ['SNAPSHOT_REQUIRED'];
        const blockers: string[] = [];
        const evidenceTimes = [snapshot.ads_data_fresh_at, snapshot.sp_api_data_fresh_at, snapshot.economics_data_fresh_at]
          .map((value: any) => new Date(String(value || '')).getTime());
        const evidenceFresh = evidenceTimes.every((time: number) => Number.isFinite(time) && time > 0 && Date.now() - time <= 45 * 60 * 1000);
        if (snapshot.data_fresh !== true || !evidenceFresh) blockers.push('STALE_DATA');
        if (!snapshotIsActive(snapshot.listing_status) || !snapshotIsActive(snapshot.offer_status) || snapshot.buyable !== true || finite(snapshot.inventory_available) <= 0) blockers.push('PRODUCT_NOT_ELIGIBLE');
        if (upper(snapshot.economic_state) === 'ECONOMICS_PENDING') blockers.push('ECONOMICS_INCOMPLETE');
        if (finite(snapshot.economic_confidence) < minEconomicConfidence) blockers.push('LOW_ECONOMIC_CONFIDENCE');
        if (increase && finite(snapshot.stock_coverage_days, 999) < 14) blockers.push('LOW_STOCK_BUDGET_INCREASE');
        return blockers;
      };

      const campaignRows = uniqueCampaignRows(campaigns).filter((campaign: any) => active(campaign.state || campaign.status) && upper(campaign.campaign_type || 'SP') === 'SP');
      const accountSnapshotCoverage = campaignSnapshotCoverage(campaignRows.map(campaignIdOf), latest);
      const accountIntradayComplete = accountSnapshotCoverage.complete;
      const portfolio = new Map<string, any>();
      const excludedProducts: any[] = [];
      for (const campaign of campaignRows) {
        const scope = resolveProductScope(campaign, productAds, products);
        const asin = scope.asin;
        const sku = scope.sku;
        if (scope.status !== 'resolved' || !scope.product || (!sku && !asin)) {
          excludedProducts.push({ asin: asin || null, sku: sku || null, campaign_id: campaignIdOf(campaign), reason: `PRODUCT_SCOPE_${scope.status.toUpperCase()}` });
          continue;
        }
        const product = scope.product;
        const eligibility = productAdsEligibility(product);
        if (!eligibility.eligible) {
          excludedProducts.push({ asin: asin || null, sku: sku || null, campaign_id: campaignIdOf(campaign), reason: eligibility.reason, stock: eligibility.stock });
          continue;
        }
        const id = campaignIdOf(campaign);
        const metrics = latest.get(id);
        const scopeKey = sku ? `SKU:${sku}` : `ASIN:${asin}`;
        const row = portfolio.get(scopeKey) || { scope_key: scopeKey, asin, sku, product, campaigns: [], spend: 0, sales: 0, orders: 0, clicks: 0, metrics_missing_campaigns: [] };
        row.campaigns.push(campaign);
        if (!metrics) row.metrics_missing_campaigns.push(id);
        else {
          row.spend += Math.max(0, finite(metrics.spend));
          row.sales += Math.max(0, finite(metrics.sales));
          row.orders += Math.max(0, finite(metrics.orders));
          row.clicks += Math.max(0, finite(metrics.clicks));
        }
        portfolio.set(scopeKey, row);
      }

      const rows = [...portfolio.values()];
      // Intraday snapshots are cumulative per campaign. Count the latest snapshot
      // for every campaign, including unresolved SKUs, in the account denominator.
      const totalSpend = roundMoney([...latest.values()].reduce((sum, row) => sum + Math.max(0, finite(row.spend)), 0));
      const eligibleForExploration = rows.filter((row) => {
        const eligibility = productAdsEligibility(row.product);
        if (!eligibility.eligible) return false;
        const profitAfterAds = finite(row.product.profit_after_ads, 0);
        const breakEvenAcos = finite(row.product.break_even_acos_pct, 0);
        const observedAcos = row.sales > 0 ? row.spend / row.sales * 100 : null;
        const lossWithoutSale = row.sales <= 0 && row.spend >= Math.max(5, finite(row.product.maximum_ad_spend_per_order, 0));
        const economicallyUnsafe = row.product.cost_confirmed === false || lossWithoutSale || (observedAcos !== null && breakEvenAcos > 0 && observedAcos >= breakEvenAcos);
        return !economicallyUnsafe && (profitAfterAds >= 0 || row.spend <= 2 || row.orders > 0);
      });
      const floorShare = eligibleForExploration.length > 0
        ? Math.min(0.05, explorationPoolShare / eligibleForExploration.length)
        : 0;

      const decisions: any[] = [];
      const observations: any[] = [];
      for (const row of rows) {
        const currentShare = totalSpend > 0 ? row.spend / totalSpend : 0;
        const acos = row.sales > 0 ? row.spend / row.sales * 100 : null;
        const profitableWinner = row.orders >= 2 && row.sales > 0 && finite(row.product.profit_after_ads, 0) > 0 && acos !== null && acos <= targetAcos;
        const shareCap = profitableWinner ? maxWinnerShare : maxAsinShare;
        const metricsComplete = accountIntradayComplete && row.metrics_missing_campaigns.length === 0;
        const underExposed = metricsComplete && eligibleForExploration.includes(row) && currentShare < floorShare && row.orders === 0;
        const overConcentrated = metricsComplete && currentShare > shareCap && (!profitableWinner || (acos !== null && acos > targetAcos));
        const campaignAudit = row.campaigns.reduce((audit: any, campaign: any) => {
          const id = campaignIdOf(campaign);
          const metric = recentCampaignMetrics.get(id);
          const campaignType = upper(campaign.targeting_type || campaign.amazon_targeting_type);
          if (campaignType === 'AUTO' || upper(campaign.name || campaign.campaign_name).startsWith('AUTO |')) audit.automatic_campaigns++;
          else audit.manual_campaigns++;
          if (!metric) audit.metrics_missing_7d++;
          else {
            if (metric.impressions <= 0) audit.zero_impression_campaigns_7d++;
            if (metric.spend > 0 && metric.sales <= 0 && metric.spend >= Math.max(5, finite(row.product.maximum_ad_spend_per_order, 0))) audit.spend_without_sales_risk_7d++;
            const breakEvenAcos = finite(row.product.break_even_acos_pct, 0);
            if (metric.spend > 0 && metric.sales > 0 && breakEvenAcos > 0 && metric.spend / metric.sales * 100 >= breakEvenAcos) audit.over_break_even_campaigns_7d++;
          }
          return audit;
        }, { active_campaigns: row.campaigns.length, automatic_campaigns: 0, manual_campaigns: 0, zero_impression_campaigns_7d: 0, spend_without_sales_risk_7d: 0, over_break_even_campaigns_7d: 0, metrics_missing_7d: 0 });

        observations.push({ asin: row.asin || null, sku: row.sku || null, scope_key: row.scope_key, spend: metricsComplete ? roundMoney(row.spend) : null, sales: metricsComplete ? roundMoney(row.sales) : null, orders: metricsComplete ? row.orders : null, acos: metricsComplete ? acos : null, current_share: metricsComplete ? currentShare : null, floor_share: floorShare, cap_share: shareCap, metrics_complete: metricsComplete, account_intraday_complete: accountIntradayComplete, metrics_missing_campaign_ids: row.metrics_missing_campaigns, under_exposed: underExposed, over_concentrated: overConcentrated, ...campaignAudit });

        if (!metricsComplete) {
          observations.push({ asin: row.asin || null, sku: row.sku || null, scope_key: row.scope_key, action: 'REVIEW_METRICS', status: 'BLOCKED_INCOMPLETE_INTRADAY_DATA', reason: accountIntradayComplete ? 'MISSING_SKU_CAMPAIGN_SNAPSHOT; no campaign budget decision based on incomplete SKU spend' : 'MISSING_ACCOUNT_CAMPAIGN_SNAPSHOT; portfolio denominator incomplete; no campaign budget changes' });
          continue;
        }

        if (underExposed) {
          observations.push({
            asin: row.asin || null,
            sku: row.sku || null,
            scope_key: row.scope_key,
            action: 'AUTO_DISCOVERY_REVIEW',
            status: 'OBSERVATION_ONLY',
            reason: 'UNDEREXPOSED_SKU_REQUIRES_DELIVERY_REVIEW; campaign budgets are not divided from the account cap',
            current_share: currentShare,
            floor_share: floorShare,
          });
          continue;
        }
        if (!overConcentrated) continue;
        const candidateCampaigns = [...row.campaigns].sort((a, b) => finite(a.daily_budget || a.budget) - finite(b.daily_budget || b.budget));
        const campaign = underExposed ? candidateCampaigns[0] : candidateCampaigns[candidateCampaigns.length - 1];
        if (!campaign) continue;
        const campaignId = campaignIdOf(campaign);
        const currentBudget = finite(campaign.daily_budget || campaign.budget);
        if (currentBudget <= 0) continue;
        const snapshot = snapshotFor(row.product, row.asin);

        const reduction = currentShare >= shareCap * 1.5 ? 0.20 : 0.10;
        const targetBudget = roundMoney(Math.max(minCampaignBudget, currentBudget * (1 - reduction)));
        if (targetBudget >= currentBudget - 0.01) continue;
        const action = 'reduce_budget';
        const reasonCode = 'SKU_PORTFOLIO_CONCENTRATION';

        const key = `SKU_DIVERSIFY|${accountId}|${row.scope_key}|${campaignId}|${action}|${today}|${targetBudget.toFixed(2)}`;
        if (priorDecisions.some((decision: any) => decision.idempotency_key === key && !['failed', 'cancelled', 'rejected', 'skipped'].includes(String(decision.status || '')))) continue;
        const blockers = snapshotBlockers(snapshot, false);
        if (blockers.length > 0) {
          observations.push({
            asin: row.asin || null,
            sku: row.sku || null,
            scope_key: row.scope_key,
            campaign_id: campaignId,
            action,
            status: 'DEFERRED_UNTIL_CANONICAL_SNAPSHOT',
            blockers,
          });
          continue;
        }
        if (!snapshot) continue;
        if (body.dry_run === true) {
          decisions.push({ asin: row.asin, campaign_id: campaignId, action, current_budget: currentBudget, target_budget: targetBudget, snapshot_id: snapshot.id, dry_run: true });
          continue;
        }

        const decision = await base44.asServiceRole.entities.OptimizationDecision.create({
          amazon_account_id: accountId,
          decision_type: 'budget_optimization',
          entity_type: 'campaign',
          entity_id: campaignId,
          campaign_id: campaignId,
          campaign_name: campaign.name || campaign.campaign_name || null,
          asin: row.asin || null,
          sku: row.sku || snapshot.sku || null,
          action,
          canonical_action_type: 'BUDGET_CHANGE',
          snapshot_id: snapshot.id,
          snapshot_key: snapshot.snapshot_key || null,
          marketplace_id: account.marketplace_id || null,
          profile_id: account.ads_profile_id || null,
          rationale: `SKU ${row.sku || row.asin} concentrou ${(currentShare * 100).toFixed(1)}% do gasto recente, acima do teto ${(shareCap * 100).toFixed(1)}%, sem proteção econômica suficiente. Redução gradual do limite desta campanha; descoberta de baixa entrega é encaminhada ao ciclo de delivery, sem repartir o teto global.`,
          rule_key: reasonCode,
          reason_code: reasonCode,
          value_before: currentBudget,
          value_after: targetBudget,
          current_value: currentBudget,
          proposed_value: targetBudget,
          change_pct: roundMoney(((targetBudget - currentBudget) / currentBudget) * 100),
          account_daily_budget_limit: accountBudget || null,
          account_daily_spend: roundMoney(totalSpend),
          remaining_account_budget: roundMoney(Math.max(0, accountBudget - totalSpend)),
          expected_impact_value: roundMoney(Math.max(0, targetBudget - currentBudget)),
          confidence: 0.94,
          risk: 'medium',
          requires_approval: false,
          approval_status: 'auto_approved_deterministic',
          status: 'approved',
          queue_status: 'pending',
          priority_class: 'P1',
          execution_mode: 'STANDARD_QUEUE',
          confirmation_required: true,
          confirmation_status: 'pending',
          data_scope_validated: true,
          data_scope_status: 'VALID',
          requires_fresh_data: true,
          maximum_data_age_minutes: 45,
          metric_window: today,
          decision_window: String(snapshot.decision_window || `portfolio_${today}`),
          data_window_start: today,
          data_window_end: today,
          precondition_snapshot: JSON.stringify({
            snapshot_id: snapshot.id,
            snapshot_key: snapshot.snapshot_key,
            data_fresh: snapshot.data_fresh,
            listing_status: snapshot.listing_status,
            offer_status: snapshot.offer_status,
            buyable: snapshot.buyable,
            inventory_available: snapshot.inventory_available,
            economic_confidence: snapshot.economic_confidence,
          }),
          rollback_plan: JSON.stringify({ action: 'set_budget', campaign_id: campaignId, value: currentBudget, reason: 'portfolio_budget_rollback' }),
          lock_key: `portfolio_budget|${accountId}|${campaignId}|${today}`,
          max_attempts: 3,
          idempotency_key: key,
          conflict_group: `${accountId}|campaign|${campaignId}`,
          source_function: SOURCE,
          data_used: JSON.stringify({ asin: row.asin || null, sku: row.sku || null, scope_key: row.scope_key, total_account_intraday_spend: totalSpend, sku_spend: row.spend, sku_sales: row.sales, sku_orders: row.orders, sku_acos: acos, current_share: currentShare, floor_share: floorShare, cap_share: shareCap, exploration_pool_share: explorationPoolShare, target_acos: targetAcos, action_scope: 'reduce_campaign_budget_only_for_confirmed_overconcentration', product_eligibility: 'active_and_in_stock', snapshot_id: snapshot.id, snapshot_key: snapshot.snapshot_key }),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
        decisions.push({ asin: row.asin, campaign_id: campaignId, action, current_budget: currentBudget, target_budget: targetBudget, decision_id: decision.id });
      }

      await base44.asServiceRole.entities.SyncExecutionLog.create({
        amazon_account_id: accountId,
        operation: SOURCE,
        trigger_type: body.trigger_type || 'canonical_daily_engine',
        sync_type: 'asin_portfolio_diversification',
        status: excludedProducts.length || !accountIntradayComplete || observations.some((row) => Number(row.metrics_missing_7d) > 0) ? 'partial' : 'completed',
        source_function: SOURCE,
        records_processed: campaignRows.length,
        records_received: campaigns.length,
        records_imported: decisions.length,
        result_summary: JSON.stringify({ scope: 'SKU preferred; ASIN fallback only for unique SKU', active_sp_campaigns_audited: campaignRows.length, resolved_product_scopes: campaignRows.length - excludedProducts.length, excluded_or_ambiguous_campaigns: excludedProducts.length, eligible_skus: eligibleForExploration.length, intraday_snapshot_coverage: accountSnapshotCoverage, sku_audit: observations, excluded_campaigns: excludedProducts, decisions_created: decisions.length, account_spend_source: 'latest cumulative intraday snapshot per campaign', metrics_window: { start: lookbackStart, end: today } }),
        message: `Auditoria por SKU: ${campaignRows.length} campanhas SP ativas examinadas; ${excludedProducts.length} sem vínculo inequívoco ou inelegíveis; ${eligibleForExploration.length} SKUs elegíveis; ${decisions.length} ajuste(s) gradual(is) proposto(s). Métricas faltantes ficam marcadas como ausência de dados, não como zero.`,
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
      }).catch(() => null);

      results.push({ amazon_account_id: accountId, total_spend: roundMoney(totalSpend), eligible_skus: eligibleForExploration.length, audited_campaigns: campaignRows.length, excluded_campaigns: excludedProducts, exploration_pool_share: explorationPoolShare, floor_share_per_sku: floorShare, max_sku_share: maxAsinShare, max_winner_share: maxWinnerShare, observations, decisions });
    }

    return Response.json({ ok: true, engine: 'SKU_PORTFOLIO_DIVERSIFICATION_V3_FRESH_AUDIT', automatic: true, ui_required: false, product_eligibility_policy: 'active_and_in_stock_only', campaign_scope_policy: 'SKU preferred; ASIN only when unique; ambiguous scopes excluded from budget changes', results });
  } catch (error: any) {
    return Response.json({ ok: false, engine: 'SKU_PORTFOLIO_DIVERSIFICATION_V3_FRESH_AUDIT', error: error?.message || String(error) }, { status: 500 });
  }
});
