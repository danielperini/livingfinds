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
const AI_OPPORTUNITY_CONFIDENCE = 0.85;

function confidenceRatio(value: unknown): number {
  const raw = numberValue(value, 0);
  return raw > 1 ? raw / 100 : raw;
}

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
  requestedStrategy: 'down_only' | 'up_and_down';
}): { strategy: 'down_only' | 'up_and_down' | 'fixed'; tosBoost: number; reason: string; acos: number | null } {
  const { campaign, economics, assessment, metrics, targetAcos, inventory, requestedStrategy } = params;
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
  const aiConfidence = confidenceRatio(assessment?.confidence);
  const positiveEconomics = numberValue(assessment?.profit_after_ads, 0) > 0;
  if (requestedStrategy === 'up_and_down' && orders >= 2 && positiveEconomics && aiConfidence >= AI_OPPORTUNITY_CONFIDENCE) {
    return {
      strategy: 'up_and_down',
      tosBoost: proposedBoost,
      reason: `IA aprovou aumento dinâmico com confiança ${Math.round(aiConfidence * 100)}%: ${orders} pedidos, ACoS ${roundMoney(acos)}% e lucro pós-Ads positivo.`,
      acos,
    };
  }
  return {
    strategy: 'down_only',
    tosBoost: proposedBoost,
    reason: requestedStrategy === 'up_and_down'
      ? `Proteção: aumento dinâmico exige confiança IA ≥ ${Math.round(AI_OPPORTUNITY_CONFIDENCE * 100)}%, pelo menos 2 pedidos e lucro pós-Ads positivo. ${exceptional ? 'Campanha vencedora preservada com Down Only.' : 'Down Only aplicado.'}`
      : exceptional
        ? `Vencedora comprovada: ${orders} pedidos, ACoS ${roundMoney(acos)}% e lucro pós-Ads positivo. Down Only preservado para impedir aumentos dinâmicos acima de 20%; Top of Search ${proposedBoost}%.`
        : `Campanha rentável: ${orders} pedidos, ACoS ${roundMoney(acos)}% abaixo da meta segura ${targetAcos}%. Down Only com Top of Search ${proposedBoost}%.`,
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

    const requestedStrategy = body.strategy_mode === 'up_and_down' ? 'up_and_down' : 'down_only';
    const candidateById = new Map<string, any>();
    for (const campaign of campaigns.filter((candidate: any) =>
      campaignState(candidate) === 'enabled' &&
      candidate.archived !== true &&
      ['MANUAL', 'AUTO'].includes(String(candidate.targeting_type || '').toUpperCase()) &&
      String(candidate.campaign_type || 'SP').toUpperCase() === 'SP' &&
      candidate.ads_protected !== true &&
      campaignIdOf(candidate)
    )) {
      const id = campaignIdOf(campaign);
      if (!candidateById.has(id)) candidateById.set(id, campaign);
    }
    const candidates = [...candidateById.values()];

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
        requestedStrategy,
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
        requested_strategy: requestedStrategy,
        ai_confidence: confidenceRatio(assessment?.confidence),
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

      if (strategyResponse.ok !== true) {
        errors++;
        results.push({ ...preview, status: 'strategy_error', amazon_status: strategyResponse.status, error: strategyResponse.message || strategyResponse.error || strategyResponse.errors?.[0]?.message });
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

      if (placementResponse.ok !== true) {
        errors++;
        results.push({ ...preview, status: 'placement_error', amazon_status: placementResponse.status, error: placementResponse.message || placementResponse.error || placementResponse.errors?.[0]?.message });
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
        requested_strategy: requestedStrategy,
        automatic_up_and_down_requires_ai_confidence: AI_OPPORTUNITY_CONFIDENCE,
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
