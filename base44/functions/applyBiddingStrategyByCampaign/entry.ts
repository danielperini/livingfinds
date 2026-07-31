import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import {
  availableInventory,
  classifyProfitPressure,
  economicsAreActionable,
  normalizeState,
  numberValue,
  resolveOperatingAcos,
  roundMoney,
} from '../../shared/profitGuardPolicy.ts';

const STRATEGY_MAP: Record<string, string> = {
  down_only: 'LEGACY_FOR_SALES',
  up_and_down: 'AUTO_FOR_SALES',
  fixed: 'MANUAL',
};
const MAX_TOP_OF_SEARCH_BOOST = 20;
const COOLDOWN_HOURS = 24;
const LOOKBACK_DAYS = 14;

const campaignIdOf = (campaign: any) => String(campaign?.amazon_campaign_id || campaign?.campaign_id || '');
const campaignState = (campaign: any) => normalizeState(campaign?.amazon_status || campaign?.state || campaign?.status);
const hoursSince = (value: unknown) => {
  if (!value) return Number.POSITIVE_INFINITY;
  const timestamp = new Date(String(value)).getTime();
  return Number.isFinite(timestamp) ? (Date.now() - timestamp) / 3600000 : Number.POSITIVE_INFINITY;
};
const unwrap = (value: any) => value?.data || value || {};

function latestAssessments(rows: any[]): Map<string, any> {
  const map = new Map<string, any>();
  for (const row of rows) {
    if (!row.asin || ['failed', 'stale', 'reconciliation_pending'].includes(normalizeState(row.data_status))) continue;
    const current = map.get(String(row.asin));
    const rowTime = new Date(row.assessment_date || row.updated_at || row.created_at || 0).getTime();
    const currentTime = new Date(current?.assessment_date || current?.updated_at || current?.created_at || 0).getTime();
    if (!current || rowTime >= currentTime) map.set(String(row.asin), row);
  }
  return map;
}

function aggregateCampaignMetrics(rows: any[]): Map<string, any> {
  const map = new Map<string, any>();
  for (const row of rows) {
    const id = String(row.campaign_id || '');
    if (!id) continue;
    const current = map.get(id) || { spend: 0, sales: 0, orders: 0, clicks: 0, impressions: 0 };
    current.spend += numberValue(row.spend);
    current.sales += numberValue(row.sales);
    current.orders += numberValue(row.orders);
    current.clicks += numberValue(row.clicks);
    current.impressions += numberValue(row.impressions);
    map.set(id, current);
  }
  return map;
}

function decideStrategy(params: {
  campaign: any;
  economics: any;
  assessment: any;
  metrics: any;
  targetAcos: number;
  inventory: number;
}): { strategy: 'down_only' | 'up_and_down' | 'fixed'; tosBoost: number; reason: string; acos: number | null } {
  const { campaign, economics, assessment, metrics, targetAcos, inventory } = params;
  const ageHours = hoursSince(campaign.start_date || campaign.created_at);
  const spend = numberValue(metrics.spend);
  const sales = numberValue(metrics.sales);
  const orders = numberValue(metrics.orders);
  const acos = sales > 0 ? spend / sales * 100 : null;

  if (inventory === 0) return { strategy: 'down_only', tosBoost: 0, reason: 'Estoque zero: nenhuma ampliação de lance ou placement.', acos };
  if (ageHours < 72 && spend < 5) return { strategy: 'fixed', tosBoost: 0, reason: 'Campanha com menos de 72h e pouca evidência: lance fixo sem placement.', acos };
  if (!economicsAreActionable(economics, assessment)) return { strategy: 'down_only', tosBoost: 0, reason: 'Economia do SKU incompleta: somente redução dinâmica.', acos };

  const pressure = classifyProfitPressure(assessment, economics);
  if (['critical', 'defensive', 'watch'].includes(pressure)) {
    return { strategy: 'down_only', tosBoost: 0, reason: `Proteção econômica ${pressure}: Down Only e Top of Search zerado.`, acos };
  }
  if (orders === 0 || acos === null) return { strategy: 'down_only', tosBoost: 0, reason: 'Sem conversão atribuída: Down Only, sem boost.', acos };
  if (acos > targetAcos) return { strategy: 'down_only', tosBoost: 0, reason: `ACoS ${roundMoney(acos)}% acima da meta segura ${targetAcos}%.`, acos };

  const headroom = Math.max(0, (targetAcos - acos) / Math.max(targetAcos, 1));
  const proposedBoost = Math.min(MAX_TOP_OF_SEARCH_BOOST, Math.max(5, Math.round(5 + headroom * 15)));
  const exceptional = orders >= 5 && acos <= targetAcos * 0.70 && numberValue(assessment?.profit_after_ads, 0) > 0;
  if (exceptional) {
    return {
      strategy: 'up_and_down',
      tosBoost: Math.min(10, proposedBoost),
      reason: `Vencedora comprovada: ${orders} pedidos, ACoS ${roundMoney(acos)}% e lucro pós-Ads positivo. Up & Down limitado e Top of Search até 10%.`,
      acos,
    };
  }
  return {
    strategy: 'down_only',
    tosBoost: proposedBoost,
    reason: `Campanha rentável: ${orders} pedidos, ACoS ${roundMoney(acos)}% abaixo da meta segura ${targetAcos}%. Down Only com Top of Search ${proposedBoost}%.`,
    acos,
  };
}

Deno.serve(async (req) => {
  const startedAt = new Date().toISOString();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    if (!body._service_role) {
      const authenticated = await base44.auth.isAuthenticated().catch(() => false);
      if (!authenticated) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    const accountRows = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1)
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-updated_at', 1);
    const account = accountRows[0];
    if (!account) return Response.json({ ok: true, skipped: true, reason: 'Nenhuma conta conectada' });
    const aid = account.id;
    const dryRun = body.dry_run === true;
    const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString().slice(0, 10);

    const [campaigns, products, economics, assessments, metricsRows, settingsRows, histories] = await Promise.all([
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid }, '-updated_at', 5000).catch(() => []),
      base44.asServiceRole.entities.Product.filter({ amazon_account_id: aid }, null, 2000).catch(() => []),
      base44.asServiceRole.entities.ProductEconomics.filter({ amazon_account_id: aid }, '-updated_at', 2000).catch(() => []),
      base44.asServiceRole.entities.DailyProductAdsAssessment.filter({ amazon_account_id: aid }, '-assessment_date', 3000).catch(() => []),
      base44.asServiceRole.entities.CampaignMetricsDaily.filter({ amazon_account_id: aid }, '-date', 15000).catch(() => []),
      base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id: aid }, '-updated_at', 1).catch(() => []),
      base44.asServiceRole.entities.CampaignChangeHistory.filter({ amazon_account_id: aid, change_type: 'bidding_strategy_auto' }, '-created_at', 3000).catch(() => []),
    ]);

    const accountTargetAcos = numberValue(settingsRows[0]?.target_acos, 15);
    const productByAsin = new Map(products.filter((p: any) => p.asin).map((p: any) => [String(p.asin), p]));
    const economicsByAsin = new Map(economics.filter((e: any) => e.asin).map((e: any) => [String(e.asin), e]));
    const assessmentByAsin = latestAssessments(assessments);
    const metricsByCampaign = aggregateCampaignMetrics(metricsRows.filter((row: any) => String(row.date || '') >= cutoff));

    const candidates = campaigns.filter((campaign: any) =>
      campaignState(campaign) === 'enabled' &&
      campaign.archived !== true &&
      String(campaign.targeting_type || '').toUpperCase() === 'MANUAL' &&
      String(campaign.campaign_type || 'SP').toUpperCase() === 'SP' &&
      campaign.ads_protected !== true &&
      campaignIdOf(campaign)
    );

    const results: any[] = [];
    let applied = 0;
    let errors = 0;
    let skippedCooldown = 0;

    for (const campaign of candidates) {
      const campaignId = campaignIdOf(campaign);
      const recent = histories.find((history: any) =>
        String(history.campaign_id || '') === campaignId &&
        hoursSince(history.applied_at || history.created_at || history.created_date) < COOLDOWN_HOURS
      );
      if (recent) {
        skippedCooldown++;
        continue;
      }

      const asin = String(campaign.asin || '');
      const product = productByAsin.get(asin);
      const econ = economicsByAsin.get(asin);
      const assessment = assessmentByAsin.get(asin);
      const policy = resolveOperatingAcos(econ, accountTargetAcos);
      const metrics = metricsByCampaign.get(campaignId) || { spend: 0, sales: 0, orders: 0, clicks: 0, impressions: 0 };
      const decision = decideStrategy({
        campaign,
        economics: econ,
        assessment,
        metrics,
        targetAcos: policy.target_acos,
        inventory: product ? availableInventory(product) : -1,
      });

      const previousStrategy = String(campaign.bidding_strategy || '').toLowerCase().includes('auto') || campaign.bidding_strategy === 'up_and_down'
        ? 'up_and_down'
        : ['manual', 'fixed'].includes(String(campaign.bidding_strategy || '').toLowerCase()) ? 'fixed' : 'down_only';
      const previousTos = numberValue(campaign.top_of_search_adjustment, 0);
      const changed = previousStrategy !== decision.strategy || previousTos !== decision.tosBoost;
      const preview = {
        campaign_id: campaignId,
        asin,
        name: campaign.name || campaign.campaign_name,
        strategy_before: previousStrategy,
        strategy_after: decision.strategy,
        top_of_search_before: previousTos,
        top_of_search_after: decision.tosBoost,
        orders_14d: numberValue(metrics.orders),
        spend_14d: roundMoney(metrics.spend),
        sales_14d: roundMoney(metrics.sales),
        acos_14d: decision.acos === null ? null : roundMoney(decision.acos),
        operating_target_acos: policy.target_acos,
        break_even_acos: policy.break_even_acos,
        reason: decision.reason,
        changed,
      };
      if (dryRun || !changed) {
        results.push({ ...preview, status: dryRun ? 'dry_run' : 'no_change' });
        continue;
      }

      const strategyResponse = unwrap(await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
        amazon_account_id: aid,
        _service_role: true,
        method: 'PUT',
        path: '/sp/campaigns',
        content_type: 'application/vnd.spCampaign.v3+json',
        accept: 'application/vnd.spCampaign.v3+json',
        payload: { campaigns: [{ campaignId, dynamicBidding: { strategy: STRATEGY_MAP[decision.strategy] } }] },
      }).catch((error: any) => ({ ok: false, error: error.message })));

      if (!(strategyResponse.ok === true || strategyResponse.status === 207)) {
        errors++;
        results.push({ ...preview, status: 'strategy_error', amazon_status: strategyResponse.status, error: strategyResponse.message || strategyResponse.error });
        continue;
      }

      const placementResponse = unwrap(await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
        amazon_account_id: aid,
        _service_role: true,
        method: 'PUT',
        path: '/sp/campaigns',
        content_type: 'application/vnd.spCampaign.v3+json',
        accept: 'application/vnd.spCampaign.v3+json',
        payload: {
          campaigns: [{
            campaignId,
            placement: { placementBidAdjustment: [{ predicate: 'PLACEMENT_TOP', percentage: decision.tosBoost }] },
          }],
        },
      }).catch((error: any) => ({ ok: false, error: error.message })));

      if (!(placementResponse.ok === true || placementResponse.status === 207)) {
        errors++;
        results.push({ ...preview, status: 'placement_error', amazon_status: placementResponse.status, error: placementResponse.message || placementResponse.error });
        continue;
      }

      const now = new Date().toISOString();
      await base44.asServiceRole.entities.Campaign.update(campaign.id, {
        bidding_strategy: decision.strategy,
        top_of_search_adjustment: decision.tosBoost,
        last_activity_at: now,
      }).catch(() => {});
      await base44.asServiceRole.entities.CampaignChangeHistory.create({
        amazon_account_id: aid,
        campaign_id: campaignId,
        asin,
        change_type: 'bidding_strategy_auto',
        field_changed: 'bidding_strategy + top_of_search_adjustment',
        old_value: `${previousStrategy} / ToS ${previousTos}%`,
        new_value: `${decision.strategy} / ToS ${decision.tosBoost}%`,
        reason: decision.reason,
        acos_at_change: decision.acos || 0,
        target_acos_at_change: policy.target_acos,
        multiplier_applied: decision.tosBoost,
        applied_at: now,
        created_at: now,
        source: 'applyBiddingStrategyByCampaign',
      }).catch(() => {});
      applied++;
      results.push({ ...preview, status: 'applied' });
    }

    return Response.json({
      ok: true,
      dry_run: dryRun,
      policy: {
        max_top_of_search_boost_pct: MAX_TOP_OF_SEARCH_BOOST,
        up_and_down_only_for_exceptional_winners: true,
        product_economics_required: true,
        lookback_days: LOOKBACK_DAYS,
      },
      evaluated: candidates.length,
      applied,
      skipped_cooldown: skippedCooldown,
      errors,
      results,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
    });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || 'Falha ao aplicar estratégia de lance' }, { status: 500 });
  }
});
