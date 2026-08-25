import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { calculateRealTacos } from '../../shared/decisionMetrics.ts';
import {
  economicsAreActionable,
  resolveOperatingAcos,
  resolveSafeMaxCpc,
} from '../../shared/profitGuardPolicy.ts';
import { productAdsEligibility } from '../../shared/productAdsEligibility.ts';
import { canonicalAccountSalesByDate } from '../../shared/salesDailyIntegrity.ts';
import {
  calculateServingGrowthGoal,
  calculateEconomicPromotionCapacity,
  classifyTrafficState,
  evaluateAutoDiscoveryBudget,
  hasServingEvidence,
  shouldProtectServingManual,
} from '../../shared/servingCampaignGrowthPolicy.ts';

const SOURCE = 'runServingCampaignGrowthObjective';
const POLICY_VERSION = 'serving-growth-v19-sales-first';
const DEFAULT_LOOKBACK_DAYS = 7;

const finite = (value: unknown, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const lower = (value: unknown) => String(value || '').trim().toLowerCase();
const upper = (value: unknown) => String(value || '').trim().toUpperCase();
const money = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));
const campaignIdOf = (row: any) => String(row?.campaign_id || row?.amazon_campaign_id || row?.id || '');
const active = (row: any) => ['enabled', 'active'].includes(lower(row?.state || row?.status || row?.amazon_status));
const automatic = (row: any) => {
  const type = upper(row?.amazon_targeting_type || row?.targeting_type);
  const name = upper(row?.name || row?.campaign_name);
  return type === 'AUTO' || /^AUTO\s*\|/.test(name) || /\|\s*AUTO\s*\|/.test(name);
};
const manual = (row: any) => !automatic(row);
const brtDate = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
const ageHours = (row: any) => {
  const created = new Date(row?.created_at || row?.created_date || row?.start_date || 0).getTime();
  return Number.isFinite(created) && created > 0 ? Math.max(0, (Date.now() - created) / 3_600_000) : Infinity;
};

type Metrics = { impressions: number; clicks: number; spend: number; sales: number; orders: number };
const emptyMetrics = (): Metrics => ({ impressions: 0, clicks: 0, spend: 0, sales: 0, orders: 0 });

function addMetrics(target: Metrics, row: any): Metrics {
  target.impressions += Math.max(0, finite(row?.impressions));
  target.clicks += Math.max(0, finite(row?.clicks));
  target.spend += Math.max(0, finite(row?.spend ?? row?.cost));
  target.sales += Math.max(0, finite(row?.sales ?? row?.attributed_sales));
  target.orders += Math.max(0, finite(row?.orders ?? row?.purchases));
  return target;
}

function latestIntradayByCampaign(rows: any[]): Map<string, any> {
  const map = new Map<string, any>();
  const sorted = [...rows].sort((a, b) =>
    new Date(String(b.observed_at || b.updated_at || b.created_at || 0)).getTime() -
    new Date(String(a.observed_at || a.updated_at || a.created_at || 0)).getTime()
  );
  for (const row of sorted) {
    const id = campaignIdOf(row);
    if (id && !map.has(id)) map.set(id, row);
  }
  return map;
}

function canonicalCampaigns(rows: any[]): any[] {
  const map = new Map<string, any>();
  for (const row of rows) {
    if (row?.api_missing === true || row?.excluded_from_dashboard === true || row?.archived === true) continue;
    const id = campaignIdOf(row);
    if (!id) continue;
    const current = map.get(id);
    const timestamp = new Date(row.last_api_sync_at || row.last_sync_at || row.updated_at || row.updated_date || row.created_at || 0).getTime();
    const currentTimestamp = new Date(current?.last_api_sync_at || current?.last_sync_at || current?.updated_at || current?.updated_date || current?.created_at || 0).getTime();
    if (!current || timestamp >= currentTimestamp) map.set(id, row);
  }
  return [...map.values()];
}

function freshCampaignFallback(campaign: any, today: string): Metrics {
  const freshness = String(
    campaign?.last_api_sync_at || campaign?.last_sync_at || campaign?.last_csv_import_at || campaign?.synced_at || '',
  ).slice(0, 10);
  if (freshness !== today) return emptyMetrics();
  return addMetrics(emptyMetrics(), campaign);
}

function asinOf(campaign: any): string {
  return upper(
    campaign?.asin || campaign?.advertised_asin ||
    String(campaign?.name || campaign?.campaign_name || '').match(/B0[A-Z0-9]{8}/i)?.[0],
  );
}

function campaignBudgetLimited(campaign: any, metrics: Metrics, currentBudget: number): boolean {
  const status = lower([
    campaign?.amazon_status,
    campaign?.delivery_status,
    campaign?.campaign_status,
    campaign?.status_code,
    campaign?.status,
  ].filter(Boolean).join('|')).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return status.includes('out_of_budget') || status.includes('budget_exhausted') ||
    status.includes('orcamento excedido') || (currentBudget > 0 && metrics.spend >= currentBudget * 0.90);
}

function positiveMinimum(values: unknown[], fallback: number): number {
  const positive = values.map((value) => finite(value)).filter((value) => value > 0);
  return positive.length ? Math.min(...positive) : fallback;
}

function activeDecisionKeys(rows: any[]): Set<string> {
  const terminal = new Set(['failed', 'failed_final', 'cancelled', 'rejected', 'expired', 'superseded', 'rolled_back']);
  return new Set(rows
    .filter((row) => !terminal.has(lower(row?.status)))
    .map((row) => String(row?.idempotency_key || ''))
    .filter(Boolean));
}

function promotedCount(result: any): number {
  const data = result?.data || result || {};
  return (Array.isArray(data.reports) ? data.reports : []).reduce((sum: number, report: any) =>
    sum + (Array.isArray(report?.promoted_terms) ? report.promoted_terms.length : 0), 0);
}

Deno.serve(async (request) => {
  const startedAt = new Date().toISOString();
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    if (!authenticated && !body._service_role) {
      return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    const accounts = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, undefined, 1).catch(() => [])
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-updated_at', 20).catch(() => []);
    const dryRun = body.dry_run === true;
    const targetGrowthPct = clamp(finite(body.serving_campaign_growth_target_pct, 40), 0, 100);
    const lookbackDays = clamp(Math.floor(finite(body.delivery_lookback_days, DEFAULT_LOOKBACK_DAYS)), 1, 30);
    const maxAutoBudgetExpansions = clamp(Math.floor(finite(body.max_auto_budget_expansions, 6)), 0, 10);
    const maxNewExactPerRun = clamp(Math.floor(finite(body.max_new_exact_per_run, 6)), 0, 10);
    const reports: any[] = [];

    for (const account of accounts) {
      const accountId = String(account.id);
      const today = brtDate();
      const cutoff30 = daysAgo(30);
      const cutoffDelivery = daysAgo(lookbackDays - 1);
      const [settingsRows, campaignRows, dailyRows, intradayRows, products, economics, assessments,
        controllerRows, salesRows, priorSnapshots, priorDecisions] = await Promise.all([
        base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id: accountId }, '-updated_at', 1).catch(() => []),
        base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: accountId }, '-updated_at', 10_000).catch(() => []),
        base44.asServiceRole.entities.CampaignMetricsDaily.filter({ amazon_account_id: accountId }, '-date', 30_000).catch(() => []),
        base44.asServiceRole.entities.IntradaySpendSnapshot.filter({ amazon_account_id: accountId, spend_date: today }, '-observed_at', 20_000).catch(() => []),
        base44.asServiceRole.entities.Product.filter({ amazon_account_id: accountId }, '-updated_at', 5_000).catch(() => []),
        base44.asServiceRole.entities.ProductEconomics.filter({ amazon_account_id: accountId }, '-updated_at', 5_000).catch(() => []),
        base44.asServiceRole.entities.DailyProductAdsAssessment.filter({ amazon_account_id: accountId }, '-assessment_date', 5_000).catch(() => []),
        base44.asServiceRole.entities.AccountDailySpendController.filter({ amazon_account_id: accountId }, '-spend_date', 10).catch(() => []),
        base44.asServiceRole.entities.SalesDaily.filter({ amazon_account_id: accountId }, '-date', 10_000).catch(() => []),
        base44.asServiceRole.entities.ServingCampaignGrowthSnapshot.filter({ amazon_account_id: accountId, policy_version: POLICY_VERSION }, 'baseline_at', 100).catch(() => []),
        base44.asServiceRole.entities.OptimizationDecision.filter({ amazon_account_id: accountId }, '-created_at', 20_000).catch(() => []),
      ]);

      const settings = settingsRows[0] || {};
      const campaigns = canonicalCampaigns(campaignRows);
      const activeCampaigns = campaigns.filter(active);
      const latestIntraday = latestIntradayByCampaign(intradayRows);
      const todayMetrics = new Map<string, Metrics>();
      const deliveryMetrics = new Map<string, Metrics>();
      const metrics30 = new Map<string, Metrics>();
      for (const row of dailyRows) {
        const id = campaignIdOf(row);
        const date = String(row?.date || '').slice(0, 10);
        if (!id || !date) continue;
        if (date === today) {
          const aggregate = todayMetrics.get(id) || emptyMetrics();
          addMetrics(aggregate, row);
          todayMetrics.set(id, aggregate);
        }
        if (date >= cutoffDelivery && date <= today) {
          const aggregate = deliveryMetrics.get(id) || emptyMetrics();
          addMetrics(aggregate, row);
          deliveryMetrics.set(id, aggregate);
        }
        if (date >= cutoff30 && date <= today) {
          const aggregate = metrics30.get(id) || emptyMetrics();
          addMetrics(aggregate, row);
          metrics30.set(id, aggregate);
        }
      }

      const metricsTodayFor = (campaign: any): Metrics => {
        const id = campaignIdOf(campaign);
        const snapshot = latestIntraday.get(id);
        if (snapshot) return addMetrics(emptyMetrics(), snapshot);
        return todayMetrics.get(id) || freshCampaignFallback(campaign, today);
      };
      const deliveryMetricsFor = (campaign: any): Metrics => {
        const id = campaignIdOf(campaign);
        const aggregate = deliveryMetrics.get(id);
        if (aggregate) return aggregate;
        const todayMetricsValue = metricsTodayFor(campaign);
        return hasServingEvidence(todayMetricsValue) ? todayMetricsValue : emptyMetrics();
      };

      const asinHistory = new Map<string, Metrics>();
      for (const campaign of activeCampaigns) {
        const asin = asinOf(campaign);
        const metric = metrics30.get(campaignIdOf(campaign));
        if (!asin || !metric) continue;
        const aggregate = asinHistory.get(asin) || emptyMetrics();
        addMetrics(aggregate, metric);
        asinHistory.set(asin, aggregate);
      }
      const conservativeCvrFor = (asin: string): number => {
        const history = asinHistory.get(asin);
        if (!history || history.clicks <= 0 || history.orders <= 0) return 0.05;
        return clamp(history.orders / history.clicks, 0.01, 0.20);
      };

      const servingRows = activeCampaigns.filter((campaign) => hasServingEvidence(metricsTodayFor(campaign)));
      const priorBaseline = priorSnapshots[0] || null;
      const baselineServing = priorBaseline
        ? Math.max(0, Math.floor(finite(priorBaseline.baseline_serving_campaigns)))
        : servingRows.length;
      const baselineAt = priorBaseline?.baseline_at || new Date().toISOString();
      const goal = calculateServingGrowthGoal({
        baselineServing,
        currentServing: servingRows.length,
        targetGrowthPct,
      });

      const matureZeroDelivery = activeCampaigns.filter((campaign) =>
        ageHours(campaign) >= 72 && !hasServingEvidence(deliveryMetricsFor(campaign))
      );
      const matureZeroAsins = [...new Set(matureZeroDelivery.map(asinOf).filter(Boolean))];
      const inFlightManuals = activeCampaigns.filter((campaign) =>
        manual(campaign) && ageHours(campaign) < 72 && !hasServingEvidence(deliveryMetricsFor(campaign))
      );

      const trafficRows = servingRows.map((campaign) => {
        const id = campaignIdOf(campaign);
        const asin = asinOf(campaign);
        const history = metrics30.get(id) || metricsTodayFor(campaign);
        const traffic = classifyTrafficState({
          ...history,
          conservativeCvr: conservativeCvrFor(asin),
          evaluationConfidence: 0.80,
        });
        return { campaign, id, asin, history, ...traffic };
      });
      const servingLearning = trafficRows.filter((row) => row.state === 'SERVING_LEARNING');
      const servingEvaluable = trafficRows.filter((row) => row.state === 'SERVING_EVALUABLE' || row.state === 'CONVERTING');

      const productByAsin = new Map(products.filter((row: any) => row.asin).map((row: any) => [upper(row.asin), row]));
      const economicsByAsin = new Map(economics.filter((row: any) => row.asin).map((row: any) => [upper(row.asin), row]));
      const assessmentByAsin = new Map<string, any>();
      for (const row of assessments) {
        const asin = upper(row?.asin);
        if (asin && !assessmentByAsin.has(asin)) assessmentByAsin.set(asin, row);
      }

      const controller = controllerRows.find((row: any) => String(row?.spend_date || '').slice(0, 10) === today) || controllerRows[0] || {};
      const accountSpendFromSnapshots = [...latestIntraday.values()].reduce((sum, row) => sum + Math.max(0, finite(row?.spend)), 0);
      const accountSpend = Math.max(accountSpendFromSnapshots, finite(controller?.confirmed_spend));
      const accountBudgetCap = positiveMinimum([
        controller?.effective_daily_spend_cap,
        controller?.economic_daily_spend_cap,
        settings?.daily_budget_limit,
        settings?.account_daily_budget_limit,
      ], 0);
      const canonicalSales = canonicalAccountSalesByDate(salesRows);
      const realSalesToday = finite(canonicalSales.get(today)?.revenue);
      const accountTacos = calculateRealTacos(accountSpend, realSalesToday);
      const maximumTacos = Math.max(0, finite(settings?.max_tacos ?? settings?.maximum_tacos ?? settings?.target_tacos));
      const hardStop = controller?.global_kill_switch === true ||
        ['critical', 'cap_imminent', 'cap_reached'].includes(lower(controller?.cap_status));
      const maximumCampaignBudget = Math.max(5, finite(settings?.maximum_campaign_budget, 100));
      const decisionKeys = activeDecisionKeys(priorDecisions);
      const rejectedAuto: any[] = [];
      const autoCandidates: any[] = [];
      let reservedAccountHeadroom = 0;

      for (const campaign of servingRows.filter(automatic)) {
        const campaignId = campaignIdOf(campaign);
        const asin = asinOf(campaign);
        const metrics = metricsTodayFor(campaign);
        const product = productByAsin.get(asin);
        const eligibility = productAdsEligibility(product);
        const econ: any = economicsByAsin.get(asin);
        const assessment = assessmentByAsin.get(asin);
        const currentBudget = Math.max(0, finite(campaign?.daily_budget ?? campaign?.budget));
        const currentCpc = metrics.clicks > 0 ? metrics.spend / metrics.clicks : 0;
        const operatingAcos = resolveOperatingAcos(econ, finite(settings?.target_acos, 15));
        const observedCvr = metrics.clicks > 0 ? metrics.orders / metrics.clicks : conservativeCvrFor(asin);
        const observedAov = metrics.orders > 0 ? metrics.sales / metrics.orders : finite(econ?.average_sale_price ?? econ?.current_price);
        const safeMaxCpc = finite(assessment?.safe_max_cpc ?? econ?.safe_max_cpc) ||
          finite(resolveSafeMaxCpc({ economics: econ, observedCvr, observedAov, operatingAcos: operatingAcos.target_acos }));
        const maximumProfitableSpend = Math.max(0, finite(
          assessment?.maximum_profitable_cpa ?? econ?.maximum_profitable_ad_spend ?? econ?.contribution_margin_amount,
        ));
        const calculatedLossBudget = maximumProfitableSpend > 0
          ? clamp(maximumProfitableSpend * 0.25, 2.50, 15)
          : 0;
        const campaignLossLimit = Math.max(0, finite(campaign?.motor_daily_loss_limit));
        const lossBudget = positiveMinimum([campaignLossLimit, calculatedLossBudget], 0);
        const allowedSpend = metrics.sales > 0 ? metrics.sales * (operatingAcos.target_acos / 100) : 0;
        const loss = Math.max(0, metrics.spend - allowedSpend);
        const currentAcos = metrics.sales > 0 ? metrics.spend / metrics.sales * 100 : 0;

        if (!economicsAreActionable(econ, assessment)) {
          rejectedAuto.push({ campaign_id: campaignId, asin, reason: 'ECONOMICS_NOT_ACTIONABLE' });
          continue;
        }

        const decision = evaluateAutoDiscoveryBudget({
          automatic: true,
          enabled: active(campaign),
          inStock: eligibility.inStock,
          budgetLimited: campaignBudgetLimited(campaign, metrics, currentBudget),
          growthGap: goal.growth_gap,
          currentBudget,
          ...metrics,
          currentCpc,
          safeMaxCpc,
          loss,
          lossBudget,
          currentAcos,
          maximumAcos: operatingAcos.target_acos,
          accountTacos,
          maximumTacos,
          accountSpend: accountSpend + reservedAccountHeadroom,
          accountBudgetCap,
          spendAvailableNow: Number.isFinite(Number(controller?.spend_available_now))
            ? Math.max(0, finite(controller?.spend_available_now) - reservedAccountHeadroom)
            : undefined,
          maximumCampaignBudget,
          maximumIncreasePct: 10,
          maximumIncreaseAmount: 1,
          minimumIncreaseAmount: 0.50,
          hardStop,
        });
        if (!decision.eligible) {
          rejectedAuto.push({ campaign_id: campaignId, asin, ...decision });
          continue;
        }
        autoCandidates.push({ campaign, campaignId, asin, metrics, safeMaxCpc, loss, lossBudget, operatingAcos, decision });
      }

      autoCandidates.sort((a, b) =>
        (b.metrics.spend / Math.max(0.01, finite(b.campaign.daily_budget || b.campaign.budget))) -
        (a.metrics.spend / Math.max(0.01, finite(a.campaign.daily_budget || a.campaign.budget))) ||
        b.metrics.clicks - a.metrics.clicks
      );
      const budgetDecisions: any[] = [];
      const rawSpendAvailable = Number(controller?.spend_available_now);
      const safeAccountHeadroom = Math.max(0, Math.min(
        Math.max(0, accountBudgetCap - accountSpend),
        Number.isFinite(rawSpendAvailable) ? Math.max(0, rawSpendAvailable) : Number.POSITIVE_INFINITY,
      ));
      const budgetDecisionLimit = Math.min(maxAutoBudgetExpansions, goal.growth_gap);
      for (const candidate of autoCandidates) {
        if (budgetDecisions.length >= budgetDecisionLimit) break;
        if (candidate.decision.increase_amount > safeAccountHeadroom - reservedAccountHeadroom + 0.0001) {
          rejectedAuto.push({
            campaign_id: candidate.campaignId,
            asin: candidate.asin,
            reason: 'AGGREGATE_GLOBAL_BUDGET_HEADROOM_EXHAUSTED',
          });
          continue;
        }
        const key = `${POLICY_VERSION}|${accountId}|${candidate.campaignId}|AUTO_DISCOVERY_BUDGET|${today}|${candidate.decision.target_budget.toFixed(2)}`;
        if (decisionKeys.has(key)) {
          reservedAccountHeadroom += candidate.decision.increase_amount;
          budgetDecisions.push({ campaign_id: candidate.campaignId, asin: candidate.asin, reused: true, ...candidate.decision });
          continue;
        }
        reservedAccountHeadroom += candidate.decision.increase_amount;
        if (dryRun) {
          budgetDecisions.push({ campaign_id: candidate.campaignId, asin: candidate.asin, dry_run: true, ...candidate.decision });
          continue;
        }
        const created = await base44.asServiceRole.entities.OptimizationDecision.create({
          amazon_account_id: accountId,
          decision_type: 'serving_campaign_growth',
          entity_type: 'campaign',
          entity_id: candidate.campaignId,
          campaign_id: candidate.campaignId,
          campaign_name: candidate.campaign.name || candidate.campaign.campaign_name || null,
          asin: candidate.asin,
          action: 'increase_budget',
          canonical_action_type: 'CAMPAIGN_BUDGET_CHANGE',
          rationale: `Discovery AUTO v18: campanha com entrega real e limitada por orçamento recebe expansão de ${candidate.decision.increase_pct.toFixed(1)}%, preservando safe_max_cpc R$ ${candidate.safeMaxCpc.toFixed(2)}, loss budget R$ ${candidate.lossBudget.toFixed(2)}, ACoS econômico e TACoS/MER da conta.`,
          rule_key: 'AUTO_DISCOVERY_BUDGET_SAFE',
          reason_code: 'AUTO_DISCOVERY_BUDGET_SAFE',
          current_value: candidate.decision.current_budget,
          proposed_value: candidate.decision.target_budget,
          value_before: candidate.decision.current_budget,
          value_after: candidate.decision.target_budget,
          confidence: 0.90,
          risk: 'low',
          requires_approval: false,
          approval_status: 'auto_approved',
          status: 'approved',
          queue_status: 'pending',
          execution_mode: 'STANDARD_QUEUE',
          confirmation_required: true,
          confirmation_status: 'pending',
          conflict_group: `${accountId}|campaign|${candidate.campaignId}`,
          idempotency_key: key,
          source_function: SOURCE,
          model_version: POLICY_VERSION,
          data_used: JSON.stringify({
            metric: 'SERVING_CAMPAIGNS', goal, safe_max_cpc: candidate.safeMaxCpc,
            current_cpc: candidate.metrics.clicks > 0 ? candidate.metrics.spend / candidate.metrics.clicks : 0,
            loss: candidate.loss, loss_budget: candidate.lossBudget, account_tacos: accountTacos,
            maximum_tacos: maximumTacos, account_spend: accountSpend,
            account_budget_cap: accountBudgetCap,
          }),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
        decisionKeys.add(key);
        budgetDecisions.push({ decision_id: created?.id, campaign_id: candidate.campaignId, asin: candidate.asin, ...candidate.decision });
      }

      const promotionCapacity = calculateEconomicPromotionCapacity({
        maxNewExactPerRun,
        economicEligibleConvertedTerms: maxNewExactPerRun,
      });
      let termBank: any = { ok: true, skipped: true };
      let autoHarvest: any = { ok: true, skipped: true };
      if (promotionCapacity > 0) {
        if (!dryRun) {
          termBank = await base44.asServiceRole.functions.invoke('updateTermBankFromAutomaticCampaigns', {
            amazon_account_id: accountId,
            _service_role: true,
            trigger_type: 'serving_growth_v18_auto_first',
          }).then((result: any) => result?.data || result || { ok: true })
            .catch((error: any) => ({ ok: false, error: error?.message || String(error) }));
        }
        autoHarvest = await base44.asServiceRole.functions.invoke('runImmediateSameSkuSearchTermHarvest', {
          amazon_account_id: accountId,
          _service_role: true,
          dry_run: dryRun,
          lookback_days: 65,
          max_promotions: promotionCapacity,
          source_campaign_type: 'AUTO',
          exclude_asins: [],
          trigger_type: 'serving_growth_v19_auto_first',
        }).then((result: any) => result?.data || result || { ok: true })
          .catch((error: any) => ({ ok: false, error: error?.message || String(error) }));
      }
      const autoExactPromotions = dryRun ? 0 : promotedCount(autoHarvest);
      const remainingManualCapacity = Math.max(0, promotionCapacity - autoExactPromotions);
      let manualHarvest: any = { ok: true, skipped: true };
      if (remainingManualCapacity > 0) {
        manualHarvest = await base44.asServiceRole.functions.invoke('runImmediateSameSkuSearchTermHarvest', {
          amazon_account_id: accountId,
          _service_role: true,
          dry_run: dryRun,
          lookback_days: 65,
          max_promotions: remainingManualCapacity,
          source_campaign_type: 'MANUAL',
          exclude_asins: [],
          trigger_type: 'serving_growth_v19_manual_converted_terms',
        }).then((result: any) => result?.data || result || { ok: true })
          .catch((error: any) => ({ ok: false, error: error?.message || String(error) }));
      }
      const manualExactPromotions = dryRun ? 0 : promotedCount(manualHarvest);
      const exactPromotions = autoExactPromotions + manualExactPromotions;

      const protectedManuals = trafficRows.filter((row) => {
        if (!manual(row.campaign)) return false;
        const econ: any = economicsByAsin.get(row.asin);
        const operatingAcos = resolveOperatingAcos(econ, finite(settings?.target_acos, 15));
        const maximumProfitableSpend = Math.max(0, finite(econ?.maximum_profitable_ad_spend ?? econ?.contribution_margin_amount));
        const lossBudget = maximumProfitableSpend > 0 ? clamp(maximumProfitableSpend * 0.25, 2.50, 15) : 0;
        const allowedSpend = row.history.sales > 0 ? row.history.sales * (operatingAcos.target_acos / 100) : 0;
        return shouldProtectServingManual({
          manual: true,
          ...row.history,
          conservativeCvr: conservativeCvrFor(row.asin),
          evaluationConfidence: 0.80,
          loss: Math.max(0, row.history.spend - allowedSpend),
          lossBudget,
        });
      });

      const status = goal.goal_met
        ? 'goal_met'
        : budgetDecisions.length || exactPromotions > 0
          ? 'safe_discovery_active'
          : matureZeroDelivery.length > 0
            ? 'awaiting_one_to_one_rotation'
            : 'awaiting_economic_candidates';
      const snapshot = {
        amazon_account_id: accountId,
        policy_version: POLICY_VERSION,
        ...goal,
        existing_campaigns: campaigns.length,
        active_campaigns: activeCampaigns.length,
        auto_serving_campaigns: servingRows.filter(automatic).length,
        manual_serving_campaigns: servingRows.filter(manual).length,
        serving_learning_campaigns: servingLearning.length,
        serving_evaluable_campaigns: servingEvaluable.length,
        mature_zero_delivery_campaigns: matureZeroDelivery.length,
        discovery_budget_decisions: budgetDecisions.filter((row) => !row.reused).length,
        auto_exact_promotions: autoExactPromotions,
        manual_exact_promotions: manualExactPromotions,
        exact_promotions_total: exactPromotions,
        baseline_at: baselineAt,
        checked_at: new Date().toISOString(),
        details: {
          status,
          definition: 'SERVING = impressão, clique ou gasto real no dia; EXISTS/ENABLED sem entrega não conta',
          goal_completion_rule: 'goal_met somente quando current_serving_campaigns >= target_serving_campaigns',
          traffic_sufficiency: 'clicks_observed / clicks_required_from_conservative_asin_cvr_at_80pct_detection_confidence',
          auto_discovery: 'AUTO budget-limited first; maximum +10% and R$1 per cycle; safe CPC, loss, ACoS, TACoS/MER and global cap mandatory',
          exact_source_priority: 'same-SKU converted Search Terms: AUTO first, then MANUAL variations',
          zero_delivery_policy: 'mature ZERO_DELIVERY ASINs excluded from additive creation and delegated to confirmed 1:1 replacement',
          mature_zero_delivery_asins: matureZeroAsins,
          in_flight_manuals: inFlightManuals.length,
          protected_serving_manuals: protectedManuals.slice(0, 100).map((row) => ({
            campaign_id: row.id, asin: row.asin, state: row.state, ...row.traffic,
          })),
          account_guardrails: {
            account_spend: money(accountSpend), account_budget_cap: money(accountBudgetCap),
            real_sales_today: money(realSalesToday), tacos_mer_pct: accountTacos,
            maximum_tacos_mer_pct: maximumTacos, hard_stop: hardStop,
          },
          budget_decisions: budgetDecisions,
          rejected_auto_sample: rejectedAuto.slice(0, 100),
          term_bank: termBank?.summary || termBank,
          auto_harvest: autoHarvest?.reports || autoHarvest,
          manual_harvest: manualHarvest?.reports || manualHarvest,
        },
      };

      if (!dryRun) {
        await base44.asServiceRole.entities.ServingCampaignGrowthSnapshot.create(snapshot);
        await base44.asServiceRole.entities.SyncExecutionLog.create({
          amazon_account_id: accountId,
          operation: 'serving_campaign_growth_v18',
          trigger_type: body.trigger_type || 'unified_decision_engine',
          status: goal.goal_met ? 'success' : 'completed',
          execution_date: today,
          started_at: startedAt,
          completed_at: new Date().toISOString(),
          records_processed: activeCampaigns.length,
          records_imported: budgetDecisions.filter((row) => !row.reused).length + exactPromotions,
          result_summary: JSON.stringify({
            policy_version: POLICY_VERSION, status, goal,
            existing_campaigns: campaigns.length, active_campaigns: activeCampaigns.length,
            mature_zero_delivery_campaigns: matureZeroDelivery.length,
            discovery_budget_decisions: budgetDecisions.length,
            auto_exact_promotions: autoExactPromotions,
            manual_exact_promotions: manualExactPromotions,
            exact_promotions_total: exactPromotions,
          }),
        }).catch(() => null);
      }
      reports.push(snapshot);
    }

    return Response.json({
      ok: reports.every((report) => report?.details?.term_bank?.ok !== false && report?.details?.auto_harvest?.ok !== false && report?.details?.manual_harvest?.ok !== false),
      engine: 'SERVING_CAMPAIGN_GROWTH_V18',
      policy_version: POLICY_VERSION,
      dry_run: dryRun,
      reports,
    });
  } catch (error: any) {
    return Response.json({
      ok: false,
      engine: 'SERVING_CAMPAIGN_GROWTH_V18',
      policy_version: POLICY_VERSION,
      error: error?.message || String(error),
    }, { status: 500 });
  }
});
