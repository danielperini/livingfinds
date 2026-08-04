import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { productGate } from '../../shared/campaignDeliveryGovernor.ts';
import {
  ECONOMIC_BALANCER_VERSION,
  allocateVirtualBudgets,
  calculateMaxSpendWithoutSale,
  classifyEconomicCampaign,
  proposeEconomicAdjustment,
  resolveEconomicBalancerConfig,
  type CampaignEconomicState,
} from '../../shared/economicBudgetBalancer.ts';
import {
  buildCanonicalBidDecision,
  canonicalDecisionIdempotencyKey,
  canonicalEntityLockKey,
  evaluateDecisionGovernance,
} from '../../shared/canonicalDecisionPolicy.ts';

const SOURCE = 'runEconomicBudgetBalancer';

const finite = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const upper = (value: unknown) => String(value || '').trim().toUpperCase();
const lower = (value: unknown) => String(value || '').trim().toLowerCase();
const active = (value: unknown) => ['enabled', 'active'].includes(lower(value));
const campaignIdOf = (row: any) => String(row?.amazon_campaign_id || row?.campaign_id || row?.id || '');
const roundMoney = (value: number) => Math.round(value * 100) / 100;

function brtDate(date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(date);
}

function cutoffDate(daysAgo: number): string {
  return brtDate(new Date(Date.now() - daysAgo * 86400000));
}

function ageHours(value: unknown): number {
  const timestamp = new Date(String(value || '')).getTime();
  return Number.isFinite(timestamp) ? Math.max(0, (Date.now() - timestamp) / 3600000) : 99999;
}

function minutesOld(value: unknown): number {
  const timestamp = new Date(String(value || '')).getTime();
  return Number.isFinite(timestamp) ? Math.max(0, (Date.now() - timestamp) / 60000) : Infinity;
}

function decisionWindow(minutes: number): string {
  const width = minutes * 60000;
  return new Date(Math.floor(Date.now() / width) * width).toISOString();
}

async function list(entity: any, filters: Record<string, unknown>, sort = '-updated_at', limit = 10000) {
  return entity.filter(filters, sort, limit).catch(() => []);
}

function mapCampaignRows(rows: any[]): Map<string, any[]> {
  const result = new Map<string, any[]>();
  for (const row of rows) {
    const id = String(row?.campaign_id || row?.amazon_campaign_id || '');
    if (!id) continue;
    const current = result.get(id) || [];
    current.push(row);
    result.set(id, current);
  }
  return result;
}

function latestIntradayByCampaign(rows: any[]): Map<string, any> {
  const result = new Map<string, any>();
  const sorted = [...rows].sort((a, b) =>
    new Date(String(b.observed_at || b.created_at || 0)).getTime() -
    new Date(String(a.observed_at || a.created_at || 0)).getTime());
  for (const row of sorted) {
    const id = String(row.campaign_id || '');
    if (id && !result.has(id)) result.set(id, row);
  }
  return result;
}

function aggregateHistory(rows: any[], campaignId: string, days: number) {
  const cutoff = cutoffDate(days);
  const matching = rows.filter((row) => String(row.campaign_id || '') === campaignId && String(row.date || '') >= cutoff);
  return matching.reduce((acc, row) => ({
    impressions: acc.impressions + finite(row.impressions),
    clicks: acc.clicks + finite(row.clicks),
    spend: acc.spend + finite(row.spend ?? row.cost),
    sales: acc.sales + finite(row.sales),
    orders: acc.orders + finite(row.orders ?? row.purchases),
  }), { impressions: 0, clicks: 0, spend: 0, sales: 0, orders: 0 });
}

function productFor(campaign: any, products: any[], productAds: any[]) {
  const campaignId = campaignIdOf(campaign);
  const ad = productAds.find((row) => String(row.campaign_id || '') === campaignId);
  const asin = upper(campaign.asin || ad?.asin);
  const sku = upper(campaign.sku || ad?.sku);
  return products.find((row) => (asin && upper(row.asin) === asin) || (sku && upper(row.sku) === sku)) || null;
}

function economicsFor(product: any, rows: any[]) {
  if (!product) return null;
  const asin = upper(product.asin);
  const sku = upper(product.sku);
  return rows.find((row) => (asin && upper(row.asin) === asin) || (sku && upper(row.sku) === sku)) || null;
}

function economicsSnapshot(economics: any, targetAcosFallback: number) {
  const price = finite(economics?.current_price || economics?.average_sale_price);
  const unitCost = finite(economics?.unit_cost || economics?.total_variable_cost_per_unit);
  const marginAmount = finite(economics?.contribution_margin_amount || economics?.profit_before_ads);
  const marginPercent = finite(economics?.contribution_margin_percent || economics?.break_even_acos);
  const safeMaxCpc = finite(economics?.safe_max_cpc || economics?.maximum_economic_cpc);
  const targetAcos = finite(economics?.target_acos, targetAcosFallback);
  const maximumProfitableSpend = finite(economics?.maximum_profitable_ad_spend || economics?.maximum_profitable_cpa || marginAmount);
  const confidence = finite(economics?.final_economic_confidence || economics?.economic_data_confidence || economics?.confidence, 0);
  const available = price > 0 && unitCost > 0 && marginAmount > 0 && safeMaxCpc > 0;
  const allowableCandidates = [maximumProfitableSpend, marginAmount, price * targetAcos / 100].filter((value) => value > 0);
  return {
    price, unitCost, marginAmount, marginPercent, safeMaxCpc, targetAcos,
    confidence,
    available,
    allowableAdSpendPerOrder: allowableCandidates.length ? Math.min(...allowableCandidates) : 0,
  };
}

function inventorySnapshot(product: any) {
  const stock = finite(product?.fba_inventory ?? product?.available_quantity ?? product?.fulfillable_quantity, -1);
  const coverage = finite(product?.stock_coverage_days ?? product?.inventory_coverage_days ?? product?.coverage_days, -1);
  return { stock, coverageDays: coverage >= 0 ? coverage : null };
}

function chooseBidEntity(params: {
  campaign: any;
  classification: CampaignEconomicState;
  action: string;
  keywords: any[];
  targets: any[];
  adGroups: any[];
}) {
  const { campaign, classification, action, keywords, targets, adGroups } = params;
  const campaignId = campaignIdOf(campaign);
  const campaignKeywords = keywords.filter((row) => String(row.campaign_id || '') === campaignId && active(row.state || row.status));
  const campaignTargets = targets.filter((row) => String(row.campaign_id || '') === campaignId && active(row.state || row.status));
  const campaignGroups = adGroups.filter((row) => String(row.campaign_id || '') === campaignId && active(row.state || row.status));
  const isAuto = upper(campaign.targeting_type) === 'AUTO';

  if (!isAuto) {
    const exact = campaignKeywords.filter((row) => upper(row.match_type) === 'EXACT');
    const keyword = exact.length === 1 ? exact[0] : campaignKeywords.length === 1 ? campaignKeywords[0] : null;
    if (!keyword) return null;
    return {
      entityType: 'keyword',
      entityId: String(keyword.keyword_id || keyword.id || ''),
      entityName: String(keyword.keyword_text || keyword.keyword || campaign.name || campaign.campaign_name || ''),
      adGroupId: String(keyword.ad_group_id || ''),
      currentBid: finite(keyword.current_bid || keyword.bid),
      metrics: keyword,
      highlyRelevant: upper(keyword.match_type) === 'EXACT',
    };
  }

  if (campaignTargets.length) {
    const ordered = [...campaignTargets].sort((a, b) => {
      if (action === 'reduce_bid') {
        const aProtected = finite(a.sales) > 0 || finite(a.orders) > 0 ? 1 : 0;
        const bProtected = finite(b.sales) > 0 || finite(b.orders) > 0 ? 1 : 0;
        if (aProtected !== bProtected) return aProtected - bProtected;
        return finite(b.spend) - finite(a.spend);
      }
      const aNoDelivery = finite(a.impressions) <= 0 ? 0 : 1;
      const bNoDelivery = finite(b.impressions) <= 0 ? 0 : 1;
      return aNoDelivery - bNoDelivery || finite(a.bid) - finite(b.bid);
    });
    const target = ordered.find((row) => action !== 'reduce_bid' || (finite(row.sales) <= 0 && finite(row.orders) <= 0));
    if (target) {
      return {
        entityType: 'product_target',
        entityId: String(target.target_id || target.id || ''),
        entityName: String(target.target_value || target.expression || campaign.name || campaign.campaign_name || ''),
        adGroupId: String(target.ad_group_id || ''),
        currentBid: finite(target.bid),
        metrics: target,
        highlyRelevant: false,
      };
    }
  }

  const group = campaignGroups[0];
  if (!group) return null;
  if (action === 'reduce_bid' && classification === 'OVERSHARE_WITH_CONVERSION') return null;
  return {
    entityType: 'ad_group',
    entityId: String(group.ad_group_id || group.id || ''),
    entityName: String(group.ad_group_name || group.name || campaign.name || campaign.campaign_name || ''),
    adGroupId: String(group.ad_group_id || ''),
    currentBid: finite(group.default_bid || group.bid),
    metrics: group,
    highlyRelevant: false,
  };
}

function structurallyComplete(campaign: any, adGroups: any[], productAds: any[], keywords: any[], targets: any[]) {
  const campaignId = campaignIdOf(campaign);
  const groups = adGroups.filter((row) => String(row.campaign_id || '') === campaignId && active(row.state || row.status));
  const ads = productAds.filter((row) => String(row.campaign_id || '') === campaignId && active(row.state || row.status));
  if (groups.length !== 1 || ads.length !== 1) return false;
  if (upper(campaign.targeting_type) !== 'AUTO') {
    const exact = keywords.filter((row) => String(row.campaign_id || '') === campaignId && active(row.state || row.status) && upper(row.match_type) === 'EXACT');
    return exact.length === 1;
  }
  const campaignTargets = targets.filter((row) => String(row.campaign_id || '') === campaignId && active(row.state || row.status));
  return campaignTargets.length > 0 || groups.length === 1;
}

function metricsVersion(row: any, metrics: any) {
  return [
    row?.observed_at || row?.synced_at || '',
    finite(metrics.impressions), finite(metrics.clicks),
    roundMoney(finite(metrics.spend)), roundMoney(finite(metrics.sales)), finite(metrics.orders),
  ].join('|');
}

function parseJson(value: unknown): any {
  try { return JSON.parse(String(value || '{}')); } catch { return {}; }
}

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    if (!authenticated && !body._service_role) {
      return Response.json({ ok: false, error: 'Nao autorizado' }, { status: 401 });
    }

    const canonicalOrchestrator = body._canonical_orchestrator === 'runUnifiedDecisionEngine';
    const dryRun = body.dry_run !== false || !canonicalOrchestrator;
    const mode = body.mode === 'zero_delivery_only' ? 'zero_delivery_only' : 'all';
    const accounts = body.amazon_account_id
      ? await list(base44.asServiceRole.entities.AmazonAccount, { id: body.amazon_account_id }, '-updated_at', 1)
      : await list(base44.asServiceRole.entities.AmazonAccount, { status: 'connected' }, '-updated_at', 50);
    if (!accounts.length) return Response.json({ ok: false, error: 'Conta Amazon conectada nao encontrada' }, { status: 404 });

    const runId = `${SOURCE}|${Date.now()}`;
    const accountResults: any[] = [];

    for (const account of accounts) {
      const accountId = String(account.id);
      const profileId = String(account.ads_profile_id || 'unknown_profile');
      const sync: any[] = [];
      if (body.skip_sync !== true) {
        const stateSync = await base44.asServiceRole.functions.invoke('syncAdsCampaignStatesV2', {
          amazon_account_id: accountId, _service_role: true, trigger_type: SOURCE,
        }).then((response: any) => response?.data || response || {})
          .catch((error: any) => ({ ok: false, error: error?.message || String(error) }));
        sync.push({ function: 'syncAdsCampaignStatesV2', ...stateSync });
        const metricSync = await base44.asServiceRole.functions.invoke('syncAmazonIntradayCampaignMetrics', {
          amazon_account_id: accountId, action: 'auto', _service_role: true, trigger_type: SOURCE,
        }).then((response: any) => response?.data || response || {})
          .catch((error: any) => ({ ok: false, error: error?.message || String(error) }));
        sync.push({ function: 'syncAmazonIntradayCampaignMetrics', ...metricSync });
      }

      const today = brtDate();
      const [configRows, campaigns, adGroups, productAds, keywords, targets, products, economicsRows,
        intradayRows, historyRows, priorDecisions, canonicalSnapshots] = await Promise.all([
        list(base44.asServiceRole.entities.AutopilotConfig, { amazon_account_id: accountId }, '-updated_at', 1),
        list(base44.asServiceRole.entities.Campaign, { amazon_account_id: accountId }, '-updated_at', 5000),
        list(base44.asServiceRole.entities.AdGroup, { amazon_account_id: accountId }, '-updated_at', 10000),
        list(base44.asServiceRole.entities.ProductAd, { amazon_account_id: accountId }, '-updated_at', 10000),
        list(base44.asServiceRole.entities.Keyword, { amazon_account_id: accountId }, '-updated_at', 20000),
        list(base44.asServiceRole.entities.ProductTarget, { amazon_account_id: accountId }, '-updated_at', 10000),
        list(base44.asServiceRole.entities.Product, { amazon_account_id: accountId }, '-updated_at', 5000),
        list(base44.asServiceRole.entities.ProductEconomics, { amazon_account_id: accountId }, '-updated_at', 5000),
        list(base44.asServiceRole.entities.IntradaySpendSnapshot, { amazon_account_id: accountId, spend_date: today }, '-observed_at', 10000),
        list(base44.asServiceRole.entities.CampaignMetricsDaily, { amazon_account_id: accountId }, '-date', 30000),
        list(base44.asServiceRole.entities.OptimizationDecision, { amazon_account_id: accountId }, '-created_at', 10000),
        body.snapshot_run_id
          ? list(base44.asServiceRole.entities.RepricingSnapshot, { amazon_account_id: accountId, run_id: body.snapshot_run_id }, '-created_at', 10000)
          : list(base44.asServiceRole.entities.RepricingSnapshot, { amazon_account_id: accountId }, '-created_at', 10000),
      ]);

      const rawConfig = configRows[0] || {};
      const config = resolveEconomicBalancerConfig(rawConfig);
      const rolloutPhase = String(rawConfig.unified_rollout_phase || 'dry_run');
      const featureEnabled = canonicalOrchestrator
        ? rawConfig.unified_marketplace_decision_engine_v1 === true && rawConfig.unified_engine_dry_run === false && ['bids_only', 'campaigns', 'budget', 'repricing', 'full'].includes(rolloutPhase)
        : rawConfig.economic_budget_balancer_enabled === true && rawConfig.enabled !== false;
      const accountDryRun = dryRun || !featureEnabled;
      const latestIntraday = latestIntradayByCampaign(intradayRows);
      const campaignRows = campaigns.filter((row) => upper(row.campaign_type || 'SP') === 'SP');

      const prepared: any[] = campaignRows.map((campaign) => {
        const campaignId = campaignIdOf(campaign);
        const intraday = latestIntraday.get(campaignId) || null;
        const product = productFor(campaign, products, productAds);
        const canonicalSnapshot = canonicalSnapshots.find((snapshot) =>
          (upper(product?.sku) && upper(snapshot.sku) === upper(product.sku)) ||
          (upper(product?.asin || campaign.asin) && upper(snapshot.asin) === upper(product?.asin || campaign.asin))
        ) || null;
        const metrics = {
          impressions: finite(body.daily_close && canonicalSnapshot ? canonicalSnapshot.impressions_1d : intraday?.impressions ?? campaign.impressions),
          clicks: finite(body.daily_close && canonicalSnapshot ? canonicalSnapshot.clicks_1d : intraday?.clicks ?? campaign.clicks),
          spend: finite(body.daily_close && canonicalSnapshot ? canonicalSnapshot.spend_1d : intraday?.spend ?? campaign.current_spend ?? campaign.spend),
          sales: finite(body.daily_close && canonicalSnapshot ? canonicalSnapshot.same_sku_sales : intraday?.sales ?? campaign.sales),
          orders: finite(body.daily_close && canonicalSnapshot ? canonicalSnapshot.same_sku_orders : intraday?.orders ?? campaign.orders),
        };
        const economics = economicsFor(product, economicsRows);
        const econ = canonicalSnapshot ? {
          price: finite(canonicalSnapshot.sale_price || canonicalSnapshot.current_price),
          unitCost: finite(canonicalSnapshot.product_cost),
          marginAmount: finite(canonicalSnapshot.contribution_margin),
          marginPercent: finite(canonicalSnapshot.margin_rate),
          safeMaxCpc: finite(canonicalSnapshot.safe_max_cpc),
          targetAcos: finite(canonicalSnapshot.target_acos, finite(rawConfig.target_acos || rawConfig.acos_target, 25)),
          confidence: finite(canonicalSnapshot.economic_confidence) * 100,
          available: canonicalSnapshot.data_fresh === true && finite(canonicalSnapshot.contribution_margin) > 0 && finite(canonicalSnapshot.safe_max_cpc) > 0,
          allowableAdSpendPerOrder: finite(canonicalSnapshot.allowable_ad_spend_per_order),
        } : economicsSnapshot(economics, finite(rawConfig.target_acos || rawConfig.acos_target, 25));
        const inventory = canonicalSnapshot ? {
          stock: finite(canonicalSnapshot.inventory_available, -1),
          coverageDays: canonicalSnapshot.stock_coverage_days == null ? null : finite(canonicalSnapshot.stock_coverage_days),
        } : inventorySnapshot(product);
        const productEligibility = productGate(product);
        const age = ageHours(campaign.start_date || campaign.created_at || campaign.created_date);
        const history30 = aggregateHistory(historyRows, campaignId, 30);
        const history65 = aggregateHistory(historyRows, campaignId, 65);
        const profitAfterAds = metrics.orders * econ.marginAmount - metrics.spend;
        const acos = metrics.sales > 0 ? metrics.spend / metrics.sales * 100 : null;
        const freshSource = intraday?.observed_at || intraday?.created_at || campaign.synced_at || campaign.updated_at;
        const fresh = canonicalSnapshot ? canonicalSnapshot.data_fresh === true : minutesOld(freshSource) <= config.metricsFreshMinutes;
        const complete = structurallyComplete(campaign, adGroups, productAds, keywords, targets);
        const lowVolume = history30.orders > 0
          ? history30.orders / 30 <= 1
          : history65.orders <= 2 && age > 24;
        return {
          campaign, campaignId, intraday, metrics, product, economics, econ, inventory, canonicalSnapshot,
          productEligibility, age, history30, history65, profitAfterAds, acos, fresh, complete, lowVolume,
          metricVersion: metricsVersion(intraday || campaign, metrics),
        };
      });

      const totalSpend = prepared.reduce((sum, row) => sum + row.metrics.spend, 0);
      const remainingBudget = roundMoney(Math.max(0, config.accountDailyBudgetLimit - totalSpend));

      for (const row of prepared) {
        row.spendShare = totalSpend > 0 ? row.metrics.spend / totalSpend : 0;
        row.classification = classifyEconomicCampaign({
          campaignType: row.campaign.campaign_type || 'SP',
          isAuto: upper(row.campaign.targeting_type) === 'AUTO',
          state: row.campaign.state || row.campaign.status,
          amazonStatus: row.campaign.amazon_status,
          ageHours: row.age,
          dataFresh: row.fresh,
          structurallyComplete: row.complete,
          economicsAvailable: row.econ.available,
          inStock: row.productEligibility.eligible,
          ...row.metrics,
          spendShare: row.spendShare,
          targetShare: 0,
          lowVolume: row.lowVolume,
          profitAfterAds: row.profitAfterAds,
          acos: row.acos,
          targetAcos: row.econ.targetAcos,
        }, config);
      }

      const allocations = allocateVirtualBudgets(prepared.map((row) => ({
        campaignId: row.campaignId,
        isAuto: upper(row.campaign.targeting_type) === 'AUTO',
        ageHours: row.age,
        classification: row.classification,
        marginPercent: row.econ.marginPercent,
        economicConfidence: row.econ.confidence,
        stockCoverageDays: row.inventory.coverageDays,
        profitAfterAds: row.profitAfterAds,
      })), config.accountDailyBudgetLimit, config);
      const allocationByCampaign = new Map(allocations.map((row) => [row.campaignId, row]));

      const classificationCounts: Record<string, number> = {};
      const simulated: any[] = [];
      const queued: any[] = [];
      const blocked: any[] = [];
      const now = Date.now();
      const oneHourAgo = now - 3600000;
      let changesThisHour = priorDecisions.filter((decision) =>
        decision.source_function === SOURCE && new Date(String(decision.created_at || decision.evaluated_at || 0)).getTime() >= oneHourAgo &&
        !['failed', 'cancelled', 'rejected', 'skipped'].includes(String(decision.status || ''))).length;

      for (const row of prepared) {
        const allocation = allocationByCampaign.get(row.campaignId) || { targetShare: 0, virtualBudget: 0, segment: 'guarded' };
        row.targetShare = allocation.targetShare;
        row.classification = classifyEconomicCampaign({
          campaignType: row.campaign.campaign_type || 'SP',
          isAuto: upper(row.campaign.targeting_type) === 'AUTO',
          state: row.campaign.state || row.campaign.status,
          amazonStatus: row.campaign.amazon_status,
          ageHours: row.age,
          dataFresh: row.fresh,
          structurallyComplete: row.complete,
          economicsAvailable: row.econ.available,
          inStock: row.productEligibility.eligible,
          ...row.metrics,
          spendShare: row.spendShare,
          targetShare: row.targetShare,
          lowVolume: row.lowVolume,
          profitAfterAds: row.profitAfterAds,
          acos: row.acos,
          targetAcos: row.econ.targetAcos,
        }, config);
        classificationCounts[row.classification] = (classificationCounts[row.classification] || 0) + 1;

        if (mode === 'zero_delivery_only' && !['NEW_NO_IMPRESSIONS', 'NEW_IMPRESSIONS_NO_CLICKS', 'LOW_VOLUME_GUARDED'].includes(row.classification)) continue;
        if (changesThisHour >= config.maxChangesPerHour) {
          blocked.push({ campaign_id: row.campaignId, classification: row.classification, reason: 'MAX_CHANGES_PER_HOUR' });
          continue;
        }
        if (simulated.length + queued.length >= Math.min(config.maxChangesPerCycle, finite(rawConfig.unified_max_bid_actions_per_cycle, config.maxChangesPerCycle))) break;

        const provisionalAction = row.classification === 'PROTECTED_WINNER' ? 'increase_budget'
          : ['NEW_NO_IMPRESSIONS', 'NEW_IMPRESSIONS_NO_CLICKS'].includes(row.classification) ? 'increase_bid'
            : 'reduce_bid';
        const bidEntity = provisionalAction === 'increase_budget' ? null : chooseBidEntity({
          campaign: row.campaign,
          classification: row.classification,
          action: provisionalAction,
          keywords,
          targets,
          adGroups,
        });
        const currentBudget = finite(row.campaign.daily_budget || row.campaign.budget);
        const entityMetrics = bidEntity?.metrics || row.metrics;
        const maxSpendWithoutSale = calculateMaxSpendWithoutSale(config, row.econ.allowableAdSpendPerOrder);
        let adjustment: ReturnType<typeof proposeEconomicAdjustment> = proposeEconomicAdjustment({
          classification: row.classification,
          ageHours: row.age,
          isAuto: upper(row.campaign.targeting_type) === 'AUTO',
          highlyRelevant: bidEntity?.highlyRelevant === true,
          economicsAvailable: row.econ.available,
          currentBid: finite(bidEntity?.currentBid),
          currentBudget,
          safeMaxCpc: row.econ.safeMaxCpc,
          impressions: finite(entityMetrics.impressions ?? row.metrics.impressions),
          clicks: finite(entityMetrics.clicks ?? row.metrics.clicks),
          orders: finite(entityMetrics.orders ?? row.metrics.orders),
          sales: finite(entityMetrics.sales ?? row.metrics.sales),
          spend: finite(entityMetrics.spend ?? row.metrics.spend),
          spendShare: row.spendShare,
          targetShare: row.targetShare,
          maxSpendWithoutSale,
          budgetExhausted: row.campaign.budget_exhausted === true || lower(row.campaign.budget_status) === 'exhausted' ||
            (currentBudget > 0 && row.metrics.spend >= currentBudget * 0.90),
          remainingAccountBudget: remainingBudget,
          budgetOptimizationEnabled: rawConfig.budget_optimization_enabled !== false,
        }, config);

        let canonicalBid: ReturnType<typeof buildCanonicalBidDecision> | null = null;
        if (['increase_bid', 'reduce_bid'].includes(adjustment.action) && bidEntity) {
          const priorReductionCount = priorDecisions.filter((decision) =>
            String(decision.entity_id || '') === String(bidEntity.entityId) &&
            Number(decision.value_after) < Number(decision.value_before) &&
            !['failed', 'cancelled', 'rejected', 'skipped', 'blocked'].includes(String(decision.status || ''))
          ).length;
          canonicalBid = buildCanonicalBidDecision({
            currentBid: finite(bidEntity.currentBid),
            safeMaxCpc: row.econ.safeMaxCpc,
            impressions: finite(entityMetrics.impressions ?? row.metrics.impressions),
            clicks: finite(entityMetrics.clicks ?? row.metrics.clicks),
            sameSkuOrders: finite(entityMetrics.orders ?? row.metrics.orders),
            haloOrders: 0,
            spend: finite(entityMetrics.spend ?? row.metrics.spend),
            maxSpendWithoutSale,
            spendShare: row.spendShare,
            ageHours: row.age,
            inStock: row.productEligibility.eligible,
            structurallyComplete: row.complete,
            dataFresh: row.fresh,
            economicsComplete: row.econ.available,
            cooldownActive: false,
            pendingInsertion: ['pending', 'pending_insertion', 'processing', 'draft'].includes(lower(row.campaign.amazon_status || row.campaign.state)),
            winnerProtected: row.canonicalSnapshot?.winner_protected === true || row.classification === 'PROTECTED_WINNER',
            lowVolumeGuarded: row.lowVolume,
            defensive: row.canonicalSnapshot?.risk_state === 'LOSS_CONFIRMED',
            isManualExact: upper(row.campaign.targeting_type) !== 'AUTO' && bidEntity.entityType === 'keyword' && bidEntity.highlyRelevant,
            adGroupConfirmed: Boolean(bidEntity.adGroupId),
            productAdConfirmed: row.complete,
            priorReductionCount,
            attributionComplete: body.daily_close === true || String(row.canonicalSnapshot?.reasons || '').includes('fechamento') || finite(entityMetrics.orders) > 0,
            acos: row.acos,
            targetAcos: row.econ.targetAcos,
            breakEvenAcos: finite(row.canonicalSnapshot?.break_even_acos) || null,
            profitAfterAds: row.profitAfterAds,
          });
          if (!['INCREASE', 'RECOVER_ZERO_DELIVERY', 'DECREASE_SOFT', 'DECREASE_STRONG'].includes(canonicalBid.action) || canonicalBid.proposedBid === null) {
            adjustment = {
              action: 'observe', valueAfter: null, changePct: 0,
              rule: canonicalBid.reasonCode, reason: canonicalBid.reason,
              confidence: canonicalBid.confidence, nextReviewHours: canonicalBid.nextEvaluationHours,
              blockedBy: canonicalBid.action === 'BLOCK' ? canonicalBid.reasonCode : undefined,
            };
          } else {
            adjustment = {
              action: ['INCREASE', 'RECOVER_ZERO_DELIVERY'].includes(canonicalBid.action) ? 'increase_bid' : 'reduce_bid',
              valueAfter: canonicalBid.proposedBid,
              changePct: canonicalBid.changePct,
              rule: canonicalBid.reasonCode,
              reason: canonicalBid.reason,
              confidence: canonicalBid.confidence,
              nextReviewHours: canonicalBid.nextEvaluationHours,
            };
          }
        }

        if (adjustment.action === 'observe' || adjustment.valueAfter === null) {
          blocked.push({
            campaign_id: row.campaignId,
            campaign_name: row.campaign.name || row.campaign.campaign_name,
            classification: row.classification,
            rule: adjustment.rule,
            reason: adjustment.reason,
            blocked_by: adjustment.blockedBy || null,
          });
          continue;
        }

        const isBudget = adjustment.action === 'increase_budget';
        if (!isBudget && !bidEntity?.entityId) {
          blocked.push({ campaign_id: row.campaignId, classification: row.classification, reason: 'BID_ENTITY_NOT_CONFIRMED' });
          continue;
        }
        const entityType = isBudget ? 'campaign' : bidEntity.entityType;
        const entityId = isBudget ? row.campaignId : bidEntity.entityId;
        const action = adjustment.action;
        const window = decisionWindow(config.decisionWindowMinutes);
        const marketplaceId = String(account.marketplace_id || account.marketplace || 'unknown_marketplace');
        const key = canonicalDecisionIdempotencyKey({
          accountId, profileId, marketplaceId, entityType, entityId, actionType: action, decisionWindow: window,
        });
        const prior = priorDecisions.find((decision) => decision.idempotency_key === key);
        if (prior) {
          blocked.push({ campaign_id: row.campaignId, entity_id: entityId, classification: row.classification, reason: 'IDEMPOTENT_WINDOW' });
          continue;
        }

        const cooldownHours = row.classification === 'LOW_VOLUME_GUARDED' ? config.lowVolumeCooldownHours : config.cooldownHours;
        const recentForEntity = priorDecisions.find((decision) => {
          if (decision.source_function !== SOURCE || String(decision.entity_id || '') !== entityId) return false;
          const created = new Date(String(decision.created_at || decision.evaluated_at || 0)).getTime();
          return created >= now - cooldownHours * 3600000 && !['failed', 'cancelled', 'rejected', 'skipped'].includes(String(decision.status || ''));
        });
        if (recentForEntity) {
          const snapshot = parseJson(recentForEntity.precondition_snapshot);
          if (snapshot.metrics_version === row.metricVersion) {
            blocked.push({ campaign_id: row.campaignId, entity_id: entityId, classification: row.classification, reason: 'NO_NEW_DATA' });
            continue;
          }
          blocked.push({ campaign_id: row.campaignId, entity_id: entityId, classification: row.classification, reason: 'COOLDOWN_ACTIVE_WITH_NEW_DATA' });
          continue;
        }

        const valueBefore = isBudget ? currentBudget : bidEntity.currentBid;
        const evaluationDueAt = new Date(Date.now() + adjustment.nextReviewHours * 3600000).toISOString();
        const evidence = {
          snapshot_id: row.canonicalSnapshot?.id || null,
          snapshot_key: row.canonicalSnapshot?.snapshot_key || null,
          account_daily_budget_limit: config.accountDailyBudgetLimit,
          account_daily_spend: roundMoney(totalSpend),
          remaining_account_budget: remainingBudget,
          hours_remaining_today: Math.max(0, 24 - Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false }).format(new Date()))),
          campaign_virtual_budget: allocation.virtualBudget,
          campaign_spend_share: row.spendShare,
          campaign_target_share: row.targetShare,
          spend_share_deviation: row.spendShare - row.targetShare,
          daily_spend: row.metrics.spend,
          spend_velocity: finite(row.intraday?.hour_brt) > 0 ? row.metrics.spend / finite(row.intraday.hour_brt) : null,
          impressions: row.metrics.impressions,
          clicks: row.metrics.clicks,
          orders: row.metrics.orders,
          sales: row.metrics.sales,
          cpc: row.metrics.clicks > 0 ? row.metrics.spend / row.metrics.clicks : 0,
          acos: row.acos,
          profit_after_ads: row.profitAfterAds,
          margin_percent: row.econ.marginPercent,
          maximum_economic_cpc: row.econ.safeMaxCpc,
          max_spend_without_sale: maxSpendWithoutSale,
          stock_qty: row.inventory.stock,
          stock_coverage_days: row.inventory.coverageDays,
          economic_confidence: row.econ.confidence,
          classification: row.classification,
          segment: allocation.segment,
          rule: adjustment.rule,
          metrics_version: row.metricVersion,
          next_evaluation_at: evaluationDueAt,
          posterior_cvr: canonicalBid?.posterior.mean ?? row.canonicalSnapshot?.predicted_conversion_rate ?? null,
          posterior_cvr_low_95: canonicalBid?.posterior.lower ?? row.canonicalSnapshot?.predicted_conversion_rate_low ?? null,
          probability_of_sale: canonicalBid?.probabilityOfSaleNextExpectedWindow ?? row.canonicalSnapshot?.probability_of_sale ?? null,
        };
        const proposal = {
          idempotency_key: key,
          campaign_id: row.campaignId,
          campaign_name: row.campaign.name || row.campaign.campaign_name,
          ad_group_id: isBudget ? null : bidEntity.adGroupId,
          entity_type: entityType,
          entity_id: entityId,
          entity_name: isBudget ? row.campaign.name || row.campaign.campaign_name : bidEntity.entityName,
          asin: row.product?.asin || row.campaign.asin || null,
          sku: row.product?.sku || row.campaign.sku || null,
          classification: row.classification,
          action,
          value_before: valueBefore,
          value_after: adjustment.valueAfter,
          change_pct: adjustment.changePct,
          reason: adjustment.reason,
          rule: adjustment.rule,
          confidence: adjustment.confidence,
          next_evaluation_at: evaluationDueAt,
          evidence,
        };

        const rollbackPlan = isBudget
          ? JSON.stringify({ action: 'set_budget', value: valueBefore })
          : JSON.stringify({ action: 'set_bid', value: valueBefore, paired_ad_group: canonicalBid?.requiresPairedAdGroup === true });
        const governance = evaluateDecisionGovernance({
          actionType: action,
          entityType,
          currentValue: valueBefore,
          proposedValue: adjustment.valueAfter,
          snapshotId: row.canonicalSnapshot?.id || null,
          reasonCode: adjustment.rule,
          reason: adjustment.reason,
          confidence: adjustment.confidence / 100,
          predictionConfidence: finite(row.canonicalSnapshot?.prediction_confidence),
          economicConfidence: row.econ.confidence > 1 ? row.econ.confidence / 100 : row.econ.confidence,
          dataFresh: row.fresh,
          adsDataFresh: row.canonicalSnapshot?.data_fresh !== false,
          spApiDataFresh: row.canonicalSnapshot?.sp_api_data_fresh_at != null,
          economicsDataFresh: row.canonicalSnapshot?.economics_data_fresh_at != null,
          productEligible: row.productEligibility.eligible,
          listingActive: !['inactive', 'not_found', 'error'].includes(lower(row.canonicalSnapshot?.listing_status || row.product?.listing_status || row.product?.status)),
          offerActive: !['inactive', 'closed', 'not_found'].includes(lower(row.canonicalSnapshot?.offer_status || row.product?.offer_status || 'active')),
          buyable: row.canonicalSnapshot ? row.canonicalSnapshot.buyable === true : row.product?.listing_buyable !== false,
          inStock: row.inventory.stock !== 0,
          stockCoverageDays: row.inventory.coverageDays,
          economicsComplete: row.econ.available,
          profitAfterAds: row.profitAfterAds,
          marginRate: row.econ.marginPercent,
          currentAcos: row.acos,
          targetAcos: row.econ.targetAcos,
          safeMaxCpc: row.econ.safeMaxCpc,
          winnerProtected: row.classification === 'PROTECTED_WINNER',
          sameSkuOrders: row.metrics.orders,
          haloOrders: 0,
          cooldownActive: false,
          accountDailyCap: config.accountDailyBudgetLimit,
          accountSpend: totalSpend,
          reservedPendingSpend: priorDecisions.filter((decision) => ['approved', 'scheduled', 'executing', 'confirming'].includes(String(decision.status || ''))).reduce((sum, decision) => sum + Math.max(0, finite(decision.expected_impact_value)), 0),
          proposedSpendImpact: isBudget ? Math.max(0, finite(adjustment.valueAfter) - valueBefore) : 0,
          defensive: row.canonicalSnapshot?.risk_state === 'LOSS_CONFIRMED',
          rollbackPlan,
          maxBidIncreasePct: 0.10,
          absoluteBidIncreasePct: 0.20,
          maxBidReductionPct: 0.20,
          minPredictionConfidence: finite(rawConfig.unified_min_prediction_confidence, 90) / 100,
          minEconomicConfidence: finite(rawConfig.unified_min_economic_confidence, 90) / 100,
        });
        if (!governance.allowed) {
          blocked.push({
            campaign_id: row.campaignId,
            entity_id: entityId,
            classification: row.classification,
            reason: 'GOVERNANCE_BLOCK',
            blockers: governance.blockers,
          });
          continue;
        }

        if (accountDryRun) {
          simulated.push({ ...proposal, governance, dry_run: true, feature_enabled: featureEnabled, status: featureEnabled ? 'SIMULATED' : 'FEATURE_DISABLED' });
          continue;
        }

        const decision = await base44.asServiceRole.entities.OptimizationDecision.create({
          amazon_account_id: accountId,
          correlation_id: runId,
          snapshot_id: row.canonicalSnapshot?.id || null,
          snapshot_key: row.canonicalSnapshot?.snapshot_key || null,
          marketplace_id: account.marketplace_id || null,
          profile_id: profileId,
          decision_type: isBudget ? 'economic_budget_balance' : 'economic_bid_balance',
          entity_type: entityType,
          entity_id: entityId,
          entity_name: proposal.entity_name,
          campaign_id: row.campaignId,
          campaign_name: proposal.campaign_name,
          ad_group_id: proposal.ad_group_id,
          keyword_id: entityType === 'keyword' ? entityId : null,
          target_id: entityType === 'product_target' ? entityId : null,
          asin: proposal.asin,
          sku: proposal.sku,
          action,
          canonical_action_type: isBudget ? 'BUDGET_CHANGE' : 'BID_CHANGE',
          rationale: adjustment.reason,
          rule_key: adjustment.rule,
          reason_code: adjustment.rule,
          current_value: valueBefore,
          proposed_value: adjustment.valueAfter,
          value_before: valueBefore,
          value_after: adjustment.valueAfter,
          change_pct: adjustment.changePct * 100,
          account_daily_budget_limit: evidence.account_daily_budget_limit,
          account_daily_spend: evidence.account_daily_spend,
          remaining_account_budget: evidence.remaining_account_budget,
          campaign_virtual_budget: evidence.campaign_virtual_budget,
          campaign_spend_share: evidence.campaign_spend_share,
          campaign_target_share: evidence.campaign_target_share,
          spend_share_deviation: evidence.spend_share_deviation,
          campaign_classification: row.classification,
          confidence: adjustment.confidence / 100,
          decision_confidence_level: adjustment.confidence >= 90 ? 'high' : adjustment.confidence >= 75 ? 'medium' : 'low',
          risk: adjustment.action === 'increase_budget' ? 'medium' : 'low',
          requires_approval: false,
          approval_status: 'auto_approved',
          status: 'approved',
          queue_status: 'pending',
          execution_channel: SOURCE,
          execution_mode: 'EXECUTE_NOW',
          priority_class: row.classification === 'OVERSHARE_NO_CONVERSION' ? 'P1' : 'P2',
          confirmation_required: true,
          confirmation_status: 'pending',
          data_scope_validated: true,
          data_scope_status: 'VALID',
          metric_window: today,
          decision_window: window,
          data_used: JSON.stringify(evidence),
          precondition_snapshot: JSON.stringify({ metrics_version: row.metricVersion, observed_at: row.intraday?.observed_at || row.campaign.synced_at || null }),
          settings_source: 'AutopilotConfig',
          settings_snapshot: JSON.stringify(config),
          current_cpc: evidence.cpc,
          maximum_economic_cpc: row.econ.safeMaxCpc,
          current_acos: row.acos,
          target_acos: row.econ.targetAcos,
          maximum_acquisition_spend: maxSpendWithoutSale,
          contribution_margin_per_order: row.econ.marginAmount,
          profit_after_ads_total: row.profitAfterAds,
          stock_qty: row.inventory.stock,
          stock_coverage_days: row.inventory.coverageDays,
          economic_state: row.classification,
          intervention_state: action,
          evaluation_due_at: evaluationDueAt,
          cooldown_until: evaluationDueAt,
          next_review_days: adjustment.nextReviewHours / 24,
          idempotency_key: key,
          lock_key: canonicalEntityLockKey({
            accountId,
            sku: proposal.sku,
            campaignId: row.campaignId,
            entityId,
            decisionWindow: window,
          }),
          rollback_plan: rollbackPlan,
          max_attempts: 3,
          source_function: SOURCE,
          model_version: ECONOMIC_BALANCER_VERSION,
          run_id: runId,
          currency_code: rawConfig.currency_code || 'BRL',
          currency_symbol: rawConfig.currency_symbol || 'R$',
          evaluated_at: new Date().toISOString(),
          approved_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });

        queued.push({ ...proposal, governance, decision_id: decision.id, queue_status: 'pending' });
        changesThisHour++;
      }

      const confirmation: any = { skipped: true, reason: 'queue_execution_and_confirmation_are_separate_schedules' };

      const campaignSummary = prepared.map((row) => {
        const allocation = allocationByCampaign.get(row.campaignId) || { targetShare: 0, virtualBudget: 0, segment: 'guarded' };
        return {
          campaign_id: row.campaignId,
          campaign_name: row.campaign.name || row.campaign.campaign_name,
          asin: row.product?.asin || row.campaign.asin || null,
          sku: row.product?.sku || row.campaign.sku || null,
          targeting_type: row.campaign.targeting_type,
          state: row.campaign.state || row.campaign.status,
          age_hours: roundMoney(row.age),
          classification: row.classification,
          spend: roundMoney(row.metrics.spend),
          spend_share: row.spendShare,
          target_share: allocation.targetShare,
          virtual_budget: allocation.virtualBudget,
          impressions: row.metrics.impressions,
          clicks: row.metrics.clicks,
          orders: row.metrics.orders,
          sales: roundMoney(row.metrics.sales),
          profit_after_ads: roundMoney(row.profitAfterAds),
          data_fresh: row.fresh,
          economics_available: row.econ.available,
          safe_max_cpc: row.econ.safeMaxCpc,
        };
      });

      const result = {
        amazon_account_id: accountId,
        profile_id: profileId,
        feature_enabled: featureEnabled,
        dry_run: accountDryRun,
        sync,
        account_daily_budget_limit: config.accountDailyBudgetLimit,
        account_daily_spend: roundMoney(totalSpend),
        remaining_account_budget: remainingBudget,
        classifications: classificationCounts,
        campaigns_analyzed: campaignSummary.length,
        changes_proposed: simulated.length + queued.length,
        changes_queued: queued.length,
        changes_executed: 0,
        estimated_savings: roundMoney([...simulated, ...queued].reduce((sum, row) => {
          if (row.action !== 'reduce_bid' || row.value_before <= 0) return sum;
          const campaign = prepared.find((item) => item.campaignId === row.campaign_id);
          return sum + finite(campaign?.metrics.spend) * Math.abs(finite(row.change_pct));
        }, 0)),
        proposed: simulated,
        queued,
        executed: [],
        blocked,
        campaigns: campaignSummary,
        confirmation,
      };

      await base44.asServiceRole.entities.SyncExecutionLog.create({
        amazon_account_id: accountId,
        operation: SOURCE,
        status: 'success',
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        records_processed: campaignSummary.length,
        records_success: accountDryRun ? simulated.length : queued.length,
        records_failed: 0,
        result_summary: JSON.stringify({
          dry_run: accountDryRun,
          feature_enabled: featureEnabled,
          account_daily_spend: result.account_daily_spend,
          remaining_account_budget: result.remaining_account_budget,
          classifications: classificationCounts,
          proposed: result.changes_proposed,
          queued: result.changes_queued,
          executed: 0,
        }).slice(0, 2000),
      }).catch(() => {});

      accountResults.push(result);
    }

    return Response.json({
      ok: true,
      engine: 'economic_budget_balancer',
      engine_version: ECONOMIC_BALANCER_VERSION,
      run_id: runId,
      dry_run: accountResults.every((row) => row.dry_run === true),
      mode,
      accounts: accountResults,
      totals: {
        accounts: accountResults.length,
        campaigns_analyzed: accountResults.reduce((sum, row) => sum + row.campaigns_analyzed, 0),
        proposed: accountResults.reduce((sum, row) => sum + row.changes_proposed, 0),
        queued: accountResults.reduce((sum, row) => sum + row.changes_queued, 0),
        executed: 0,
      },
    });
  } catch (error: any) {
    return Response.json({
      ok: false,
      engine: 'economic_budget_balancer',
      error: error?.response?.data?.error || error?.message || 'Falha no balanceador economico',
    }, { status: 500 });
  }
});
