/**
 * runBidDecisionEngineV2
 * Motor determinístico de bids com dados persistidos da Amazon.
 *
 * Corrige o fluxo completo:
 * - aceita execução autenticada ou por service role;
 * - cria OptimizationDecision executável, não apenas RuleExecution;
 * - agenda mudanças de baixo risco nas janelas Amazon;
 * - mantém RuleExecution como trilha de auditoria;
 * - aplica idempotência por conta + keyword + data.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const MIN_BID = 0.10;
const MAX_BID = 5.00;
const MAX_BID_CHANGE_PCT = 0.20;
const MIN_IMPRESSIONS = 100;
const MIN_CLICKS = 5;
const MATURATION_HOURS = 48;
const MAX_INVALID_CLICK_RATE = 0.08;
const MAX_DIVERGENCE_PCT = 10;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function pctChange(current: number, pct: number) {
  return Number(clamp(current * (1 + pct / 100), MIN_BID, MAX_BID).toFixed(2));
}

function brazilHour() {
  const parts = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  return Number(parts.find((part) => part.type === 'hour')?.value || 0);
}

function nextQueueHour() {
  const hour = brazilHour();
  if (hour < 4) return Math.min(3, hour + 1);
  if (hour < 13) return 13;
  return 0;
}

Deno.serve(async (request) => {
  const now = new Date().toISOString();
  const today = now.slice(0, 10);

  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    if (!authenticated && !body._service_role) {
      return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    let account: any = null;
    if (body.amazon_account_id) {
      const rows = await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id });
      account = rows[0] || null;
    }
    if (!account) {
      const rows = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      account = rows[0] || null;
    }
    if (!account) return Response.json({ ok: false, error: 'Conta não encontrada' }, { status: 404 });

    const accountId = account.id;
    const hasUnified = account.unified_reports_access === true;
    const configs = await base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: accountId }, null, 1).catch(() => []);
    const config = configs[0] || {};
    const targetAcos = Number(config.target_acos || 10);
    const targetRoas = Number(config.target_roas || 4);
    const maxCpc = Number(config.maximum_cpc || MAX_BID);
    const cutoff14 = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);

    const [keywords, campaigns, products, unifiedRaw, legacyRaw, reconciliations] = await Promise.all([
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: accountId }, '-spend', 500),
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: accountId }, null, 500),
      base44.asServiceRole.entities.Product.filter({ amazon_account_id: accountId }, null, 500),
      hasUnified
        ? base44.asServiceRole.entities.UnifiedAdsMetricsDaily.filter({ amazon_account_id: accountId }, '-date', 5000).catch(() => [])
        : Promise.resolve([]),
      base44.asServiceRole.entities.CampaignMetricsDaily.filter({ amazon_account_id: accountId }, '-date', 5000).catch(() => []),
      base44.asServiceRole.entities.UnifiedMetricsReconciliation.filter({ amazon_account_id: accountId }, '-date', 1000).catch(() => []),
    ]);

    const divergenceByCampaign = new Map<string, number>();
    for (const row of reconciliations) {
      const campaignId = String(row.campaign_id || '');
      if (!campaignId) continue;
      divergenceByCampaign.set(campaignId, Math.max(divergenceByCampaign.get(campaignId) || 0, Number(row.difference_percent || 0)));
    }

    const unifiedMetrics = new Map<string, any>();
    for (const row of unifiedRaw) {
      const campaignId = String(row.campaign_id || '');
      if (!campaignId || !row.date || row.date < cutoff14) continue;
      if (!unifiedMetrics.has(campaignId)) {
        unifiedMetrics.set(campaignId, {
          cost: 0, sales: 0, purchases: 0, clicks: 0, impressions: 0,
          promotedPurchases: 0, promotedSales: 0, haloPurchases: 0, haloSales: 0,
          invalidRateSum: 0, invalidRateCount: 0, impressionShareSum: 0,
          topSearchSum: 0, rows: 0,
        });
      }
      const metric = unifiedMetrics.get(campaignId);
      metric.cost += Number(row.cost || 0);
      metric.sales += Number(row.sales || 0);
      metric.purchases += Number(row.purchases || 0);
      metric.clicks += Number(row.clicks || 0);
      metric.impressions += Number(row.impressions || 0);
      metric.promotedPurchases += Number(row.promoted_purchases || 0);
      metric.promotedSales += Number(row.promoted_sales || 0);
      metric.haloPurchases += Number(row.halo_purchases || 0);
      metric.haloSales += Number(row.halo_sales || 0);
      if (Number(row.invalid_click_rate || 0) > 0) {
        metric.invalidRateSum += Number(row.invalid_click_rate || 0);
        metric.invalidRateCount++;
      }
      metric.impressionShareSum += Number(row.impression_share || 0);
      metric.topSearchSum += Number(row.top_of_search_impression_share || 0);
      metric.rows++;
    }

    const legacyMetrics = new Map<string, any>();
    for (const row of legacyRaw) {
      const campaignId = String(row.campaign_id || '');
      if (!campaignId || !row.date || row.date < cutoff14) continue;
      if (!legacyMetrics.has(campaignId)) {
        legacyMetrics.set(campaignId, { spend: 0, sales: 0, orders: 0, clicks: 0, impressions: 0 });
      }
      const metric = legacyMetrics.get(campaignId);
      metric.spend += Number(row.spend || 0);
      metric.sales += Number(row.sales || 0);
      metric.orders += Number(row.orders || 0);
      metric.clicks += Number(row.clicks || 0);
      metric.impressions += Number(row.impressions || 0);
    }

    const campaignMap = new Map<string, any>();
    const campaignAsinMap = new Map<string, string>();
    for (const campaign of campaigns) {
      for (const id of [campaign.campaign_id, campaign.amazon_campaign_id]) {
        if (!id) continue;
        campaignMap.set(String(id), campaign);
        if (campaign.asin) campaignAsinMap.set(String(id), campaign.asin);
      }
    }
    const productMap = new Map(products.map((product: any) => [String(product.asin || ''), product]));

    let totalClicks = 0;
    let totalImpressions = 0;
    for (const metric of unifiedMetrics.values()) {
      totalClicks += metric.clicks;
      totalImpressions += metric.impressions;
    }
    const accountAvgCtr = totalImpressions > 0 ? totalClicks / totalImpressions : 0.005;
    const queueHour = nextQueueHour();
    const queueWindow = queueHour === 13 ? '13:00-14:00' : `${String(queueHour).padStart(2, '0')}:00-${String(queueHour + 1).padStart(2, '0')}:00`;

    const decisions: any[] = [];
    const stats = { increase: 0, decrease: 0, hold: 0, skip: 0, duplicate: 0 };

    for (const keyword of keywords) {
      const keywordId = String(keyword.keyword_id || '');
      if (!keywordId) { stats.skip++; continue; }
      const campaignId = String(keyword.campaign_id || '');
      const campaign = campaignMap.get(campaignId);
      const currentBid = Number(keyword.current_bid || keyword.bid || 0.25);
      const asin = String(keyword.asin || campaignAsinMap.get(campaignId) || '');
      const product = productMap.get(asin);
      const campaignState = String(campaign?.state || campaign?.status || '').toLowerCase();

      if (['archived', 'incomplete', 'paused'].includes(campaignState)) { stats.skip++; continue; }
      if (product && (product.inventory_status === 'out_of_stock' || Number(product.fba_inventory || 0) <= 0)) { stats.skip++; continue; }
      if ((divergenceByCampaign.get(campaignId) || 0) > MAX_DIVERGENCE_PCT) { stats.skip++; continue; }

      const unified = unifiedMetrics.get(campaignId);
      const legacy = legacyMetrics.get(campaignId);
      const useUnified = hasUnified && !!unified;
      const metrics = useUnified ? {
        cost: unified.cost,
        sales: unified.promotedSales > 0 ? unified.promotedSales : unified.sales,
        purchases: unified.promotedPurchases > 0 ? unified.promotedPurchases : unified.purchases,
        clicks: unified.clicks,
        impressions: unified.impressions,
        roas: unified.cost > 0 ? (unified.promotedSales > 0 ? unified.promotedSales : unified.sales) / unified.cost : 0,
        acos: (unified.promotedSales > 0 ? unified.promotedSales : unified.sales) > 0
          ? unified.cost / (unified.promotedSales > 0 ? unified.promotedSales : unified.sales) * 100 : 0,
        haloPurchases: unified.haloPurchases,
        ctr: unified.impressions > 0 ? unified.clicks / unified.impressions : 0,
        impressionShare: unified.rows > 0 ? unified.impressionShareSum / unified.rows : 0,
        topSearch: unified.rows > 0 ? unified.topSearchSum / unified.rows : 0,
        invalidRate: unified.invalidRateCount > 0 ? unified.invalidRateSum / unified.invalidRateCount : 0,
      } : legacy ? {
        cost: legacy.spend,
        sales: legacy.sales,
        purchases: legacy.orders,
        clicks: legacy.clicks,
        impressions: legacy.impressions,
        roas: legacy.spend > 0 ? legacy.sales / legacy.spend : 0,
        acos: legacy.sales > 0 ? legacy.spend / legacy.sales * 100 : 0,
        haloPurchases: 0,
        ctr: legacy.impressions > 0 ? legacy.clicks / legacy.impressions : 0,
        impressionShare: 0,
        topSearch: 0,
        invalidRate: 0,
      } : null;

      if (!metrics || metrics.impressions < MIN_IMPRESSIONS || metrics.clicks < MIN_CLICKS) { stats.hold++; continue; }
      if (campaign?.created_at) {
        const ageHours = (Date.now() - new Date(campaign.created_at).getTime()) / 3600000;
        if (ageHours < MATURATION_HOURS) { stats.hold++; continue; }
      }
      if (metrics.invalidRate > MAX_INVALID_CLICK_RATE) { stats.hold++; continue; }

      const cpc = metrics.clicks > 0 ? metrics.cost / metrics.clicks : 0;
      const goodCtr = metrics.ctr >= accountAvgCtr * 0.8;
      let action: 'increase_bid' | 'reduce_bid' | null = null;
      let newBid = currentBid;
      let reason = '';

      if (
        metrics.roas >= targetRoas && metrics.acos > 0 && metrics.acos <= targetAcos &&
        metrics.purchases >= 1 && cpc < maxCpc &&
        ((metrics.impressionShare > 0 && metrics.impressionShare < 0.30) || (metrics.topSearch > 0 && metrics.topSearch < 0.20))
      ) {
        action = 'increase_bid';
        newBid = pctChange(currentBid, 15);
        reason = `ROAS ${metrics.roas.toFixed(2)}x, ACoS ${metrics.acos.toFixed(1)}%, baixa parcela de impressões. Bid +15%.`;
        stats.increase++;
      } else if (
        (metrics.acos > targetAcos * 1.2 && metrics.clicks >= MIN_CLICKS) ||
        (metrics.cost > 5 && metrics.purchases === 0 && metrics.haloPurchases === 0) ||
        (!goodCtr && metrics.impressionShare > 0.50)
      ) {
        action = 'reduce_bid';
        const pct = metrics.acos > targetAcos * 1.5 ? -20 : -10;
        newBid = pctChange(currentBid, pct);
        reason = `ACoS ${metrics.acos.toFixed(1)}%, compras ${metrics.purchases}, CTR ${(metrics.ctr * 100).toFixed(3)}%. Bid ${pct}%.`;
        stats.decrease++;
      } else {
        stats.hold++;
      }

      if (!action || Math.abs(newBid - currentBid) < 0.01) continue;
      const idempotencyKey = `bidv2|${accountId}|${keywordId}|${today}`;
      const existing = await base44.asServiceRole.entities.OptimizationDecision.filter({
        amazon_account_id: accountId,
        idempotency_key: idempotencyKey,
      }, '-created_at', 1).catch(() => []);
      if (existing.length) { stats.duplicate++; continue; }

      decisions.push({
        amazon_account_id: accountId,
        decision_type: 'bid_change',
        entity_type: 'keyword',
        entity_id: keywordId,
        keyword_id: keywordId,
        keyword_text: keyword.keyword_text || keyword.keyword || '',
        campaign_id: campaignId,
        asin: asin || null,
        action,
        value_before: currentBid,
        value_after: newBid,
        change_pct: Number((((newBid - currentBid) / currentBid) * 100).toFixed(2)),
        objective: action === 'increase_bid' ? 'growth' : 'profitability',
        rationale: reason,
        data_used: JSON.stringify({ source: useUnified ? 'unified_reports' : 'legacy', metrics }).slice(0, 4000),
        period_analyzed: '14d',
        confidence: 90,
        risk: 'low',
        reversible: true,
        requires_approval: false,
        status: 'approved',
        queue_status: 'scheduled',
        queue_hour: queueHour,
        queue_window: queueWindow,
        queued_at: now,
        idempotency_key: idempotencyKey,
        trigger: 'deterministic_bid_engine_v2',
        source_function: 'runBidDecisionEngineV2',
        created_at: now,
        updated_at: now,
      });
    }

    for (const decision of decisions) {
      const created = await base44.asServiceRole.entities.OptimizationDecision.create(decision);
      await base44.asServiceRole.entities.RuleExecution.create({
        amazon_account_id: accountId,
        rule_key: `bid_v2_${decision.action}`,
        entity_type: decision.entity_type,
        entity_id: decision.entity_id,
        campaign_id: decision.campaign_id,
        keyword_id: decision.keyword_id,
        asin: decision.asin,
        action_type: 'set_bid',
        value_before: decision.value_before,
        value_after: decision.value_after,
        idempotency_key: decision.idempotency_key,
        status: 'scheduled',
        reason: decision.rationale,
        seasonal_context: JSON.stringify({ optimization_decision_id: created.id, queue_hour: queueHour }),
      }).catch(() => {});
    }

    return Response.json({
      ok: true,
      data_source: hasUnified ? 'unified_reports' : 'legacy_fallback',
      keywords_evaluated: keywords.length,
      decisions_created: decisions.length,
      decisions_scheduled: decisions.length,
      queue_hour: queueHour,
      queue_window: queueWindow,
      stats,
      target_acos: targetAcos,
      target_roas: targetRoas,
      max_bid_change_pct: MAX_BID_CHANGE_PCT * 100,
    });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || 'Falha no motor de bids' }, { status: 500 });
  }
});
