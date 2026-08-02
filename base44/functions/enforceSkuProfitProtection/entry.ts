import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import {
  availableInventory,
  bidAfterProfitGuard,
  classifyProfitPressure,
  economicsAreActionable,
  isProtectedWinner,
  normalizeSku,
  normalizeState,
  numberValue,
  resolveOperatingAcos,
  resolveSafeMaxCpc,
  roundMoney,
  zeroSalesCircuitBreaker,
} from '../../shared/profitGuardPolicy.ts';

const RULE_VERSION = 3;
const LOOKBACK_DAYS = 14;
const BID_COOLDOWN_HOURS = 24;
const PAUSE_AFTER_REDUCTION_HOURS = 72;
const REACTIVATION_COOLDOWN_HOURS = 72;
const MAX_ACTIONS_PER_ACCOUNT = 80;
const INTRADAY_MIN_SPEND = 5;
const INTRADAY_MIN_CLICKS = 3;
const INTRADAY_VELOCITY_MULTIPLIER = 2;
const INTRADAY_SPEND_MULTIPLIER = 2.5;
const TERM_ATTRIBUTION_LAG_DAYS = 3;
const TERM_MIN_SPEND = 8;
const TERM_MIN_CLICKS = 6;
const MAX_TERM_ACTIONS_PER_ACCOUNT = 20;

const nowIso = () => new Date().toISOString();
const todayBrt = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());
const cutoffDate = (days: number) => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
const hoursSince = (value: unknown) => {
  if (!value) return Number.POSITIVE_INFINITY;
  const timestamp = new Date(String(value)).getTime();
  return Number.isFinite(timestamp) ? (Date.now() - timestamp) / 3600000 : Number.POSITIVE_INFINITY;
};
const remoteId = (value: unknown) => /^\d+$/.test(String(value || '')) ? String(value) : '';
const campaignIdOf = (campaign: any) => String(campaign?.amazon_campaign_id || campaign?.campaign_id || '');
const campaignState = (campaign: any) => normalizeState(campaign?.amazon_status || campaign?.state || campaign?.status);
const isAutoCampaign = (campaign: any) => {
  const targeting = String(campaign?.targeting_type || '').toUpperCase();
  const name = String(campaign?.name || campaign?.campaign_name || '').toUpperCase();
  return targeting.includes('AUTO') || /^AUTO\s*\|/.test(name) || /\|\s*AUTO\s*\|/.test(name);
};
const normalizeTarget = (value: unknown) => String(value || '').normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  .replace(/^(keyword|search term|targeting)\s+/, '');

function unwrap(response: any): any {
  return response?.data || response || {};
}

function latestByProduct(rows: any[]): Map<string, any> {
  const index = new Map<string, any>();
  for (const row of rows) {
    if (['failed', 'stale', 'reconciliation_pending'].includes(normalizeState(row?.data_status))) continue;
    for (const key of [row?.asin, normalizeSku(row?.sku)].filter(Boolean)) {
      const existing = index.get(String(key));
      const rowTime = new Date(row?.assessment_date || row?.updated_at || row?.created_at || 0).getTime();
      const existingTime = new Date(existing?.assessment_date || existing?.updated_at || existing?.created_at || 0).getTime();
      if (!existing || rowTime >= existingTime) index.set(String(key), row);
    }
  }
  return index;
}

function metricsByCampaign(rows: any[]): Map<string, any> {
  const map = new Map<string, any>();
  for (const row of rows) {
    const id = String(row?.campaign_id || '');
    if (!id) continue;
    const current = map.get(id) || { spend: 0, sales: 0, orders: 0, clicks: 0, impressions: 0, last_sale_at: null };
    current.spend += numberValue(row.spend);
    current.sales += numberValue(row.sales);
    current.orders += numberValue(row.orders);
    current.clicks += numberValue(row.clicks);
    current.impressions += numberValue(row.impressions);
    if (numberValue(row.orders) > 0 && row.date && (!current.last_sale_at || row.date > current.last_sale_at)) {
      current.last_sale_at = `${row.date}T23:59:59-03:00`;
    }
    map.set(id, current);
  }
  return map;
}

async function invokeAds(base44: any, accountId: string, path: string, payload: any, contentType: string, method = 'PUT') {
  const response = await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
    amazon_account_id: accountId,
    _service_role: true,
    method,
    path,
    payload,
    content_type: contentType,
    accept: contentType,
    max_attempts: 3,
  });
  return unwrap(response);
}

async function enqueueRetry(base44: any, params: {
  accountId: string;
  operation: string;
  entityType: 'campaign' | 'keyword';
  entityId: string;
  campaignId?: string;
  keywordId?: string;
  payload: any;
  idempotencyKey: string;
  retryAfterSeconds?: number;
}) {
  const existing = await base44.asServiceRole.entities.AmazonActionQueue.filter({
    amazon_account_id: params.accountId,
    idempotency_key: params.idempotencyKey,
  }, null, 1).catch(() => []);
  if (existing.length) return existing[0];
  const scheduledAt = new Date(Date.now() + Math.max(60, params.retryAfterSeconds || 300) * 1000).toISOString();
  return base44.asServiceRole.entities.AmazonActionQueue.create({
    amazon_account_id: params.accountId,
    operation: params.operation,
    entity_type: params.entityType,
    entity_id: params.entityId,
    campaign_id: params.campaignId || null,
    keyword_id: params.keywordId || null,
    payload: params.payload,
    idempotency_key: params.idempotencyKey,
    priority: 'high',
    status: 'pending',
    scheduled_at: scheduledAt,
    attempt_count: 0,
    max_attempts: 3,
    source: 'enforceSkuProfitProtection',
  }).catch(() => null);
}

async function recordExecution(base44: any, data: any) {
  const existing = await base44.asServiceRole.entities.RuleExecution.filter({
    amazon_account_id: data.amazon_account_id,
    idempotency_key: data.idempotency_key,
  }, null, 1).catch(() => []);
  if (existing.length) return existing[0];
  return base44.asServiceRole.entities.RuleExecution.create({
    rule_version: RULE_VERSION,
    rollback_available: true,
    ...data,
  }).catch(() => null);
}

Deno.serve(async (request) => {
  const startedAt = nowIso();
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    if (!authenticated && !body._service_role) {
      return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    const accounts = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1)
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-updated_at', 20);
    const dryRun = body.dry_run === true;
    const day = todayBrt();
    const results: any[] = [];

    for (const account of accounts) {
      const aid = account.id;
      const cutoff = cutoffDate(LOOKBACK_DAYS);
      const [products, economics, assessments, campaigns, keywords, searchTerms, metricsRows, hourlyRows, settingsRows, priorExecutions] = await Promise.all([
        base44.asServiceRole.entities.Product.filter({ amazon_account_id: aid }, null, 2000).catch(() => []),
        base44.asServiceRole.entities.ProductEconomics.filter({ amazon_account_id: aid }, '-updated_at', 2000).catch(() => []),
        base44.asServiceRole.entities.DailyProductAdsAssessment.filter({ amazon_account_id: aid }, '-assessment_date', 3000).catch(() => []),
        base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid }, '-updated_at', 5000).catch(() => []),
        base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: aid }, '-updated_at', 10000).catch(() => []),
        base44.asServiceRole.entities.SearchTerm.filter({ amazon_account_id: aid }, '-date', 20000).catch(() => []),
        base44.asServiceRole.entities.CampaignMetricsDaily.filter({ amazon_account_id: aid }, '-date', 15000).catch(() => []),
        base44.asServiceRole.entities.UnifiedAdsMetricsHourly.filter({ amazon_account_id: aid }, '-date', 20000).catch(() => []),
        base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id: aid }, '-updated_at', 1).catch(() => []),
        base44.asServiceRole.entities.RuleExecution.filter({ amazon_account_id: aid }, '-executed_at', 5000).catch(() => []),
      ]);

      const settings = settingsRows[0] || {};
      let invalidZeroRevenueMarginsRepaired = 0;
      for (const economic of economics) {
        const imported = economic.analytics_import_metrics;
        if (!imported || numberValue(imported.revenue) > 0 || numberValue(imported.ads_cost) <= 0) continue;
        if (imported.margin_after_ads_pct == null && imported.margin_after_ads_not_calculable === true) continue;
        const repairedMetrics = {
          ...imported,
          margin_after_ads_pct: null,
          economic_status: 'no_sales_with_spend',
          margin_after_ads_not_calculable: true,
        };
        if (!dryRun) {
          await base44.asServiceRole.entities.ProductEconomics.update(economic.id, {
            analytics_import_metrics: repairedMetrics,
            updated_at: nowIso(),
          }).catch(() => {});
        }
        economic.analytics_import_metrics = repairedMetrics;
        invalidZeroRevenueMarginsRepaired++;
      }
      const minBid = numberValue(settings.min_bid, 0.20);
      const maxBid = numberValue(settings.max_bid, 5.00);
      const accountTargetAcos = numberValue(settings.target_acos, 15);
      const economicsByAsin = new Map(economics.filter((e: any) => e.asin).map((e: any) => [String(e.asin), e]));
      const economicsBySku = new Map(economics.filter((e: any) => e.sku).map((e: any) => [normalizeSku(e.sku), e]));
      const latestAssessment = latestByProduct(assessments);
      const campaignMetrics = metricsByCampaign(metricsRows.filter((row: any) => String(row.date || '') >= cutoff));
      const campaignsByAsin = new Map<string, any[]>();
      for (const campaign of campaigns) {
        if (!campaign.asin) continue;
        const list = campaignsByAsin.get(String(campaign.asin)) || [];
        list.push(campaign);
        campaignsByAsin.set(String(campaign.asin), list);
      }
      const keywordsByCampaign = new Map<string, any[]>();
      for (const keyword of keywords) {
        const id = String(keyword.campaign_id || '');
        if (!id) continue;
        const list = keywordsByCampaign.get(id) || [];
        list.push(keyword);
        keywordsByCampaign.set(id, list);
      }

      const actions: any[] = [];
      const skipped: any[] = [];
      let budget = MAX_ACTIONS_PER_ACCOUNT;
      const intradayAdjustedKeywordIds = new Set<string>();

      // Search terms de AUTO nao possuem bid proprio. Com atribuicao madura,
      // desperdicio vira somente NEGATIVE_EXACT; termos que converteram nunca
      // sao negativados e recebem apenas reducao granular da keyword de origem.
      const attributionCutoff = cutoffDate(TERM_ATTRIBUTION_LAG_DAYS);
      const campaignById = new Map(campaigns.map((campaign: any) => [campaignIdOf(campaign), campaign]));
      const termAggregates = new Map<string, any>();
      const seenTermRows = new Set<string>();
      for (const row of searchTerms) {
        if (String(row.date || '') > attributionCutoff) continue;
        const campaignId = String(row.campaign_id || '');
        const adGroupId = String(row.ad_group_id || '');
        const term = normalizeTarget(row.normalized_search_term || row.search_term);
        if (!campaignId || !adGroupId || !term) continue;
        const identity = String(row.id || [campaignId, adGroupId, term, row.date, row.spend, row.clicks, row.orders_14d].join('|'));
        if (seenTermRows.has(identity)) continue;
        seenTermRows.add(identity);
        const key = `${campaignId}|${adGroupId}|${term}`;
        const aggregate = termAggregates.get(key) || {
          campaignId, adGroupId, term, spend: 0, clicks: 0, orders: 0, sales: 0,
          dates: new Set<string>(), keywordId: '', maxProfitableCpc: 0,
        };
        aggregate.spend += numberValue(row.spend);
        aggregate.clicks += numberValue(row.clicks);
        aggregate.orders += numberValue(row.orders_14d ?? row.orders_7d ?? row.orders_30d ?? row.orders_1d);
        aggregate.sales += numberValue(row.sales_14d ?? row.sales_7d ?? row.sales_30d ?? row.sales_1d);
        if (row.date) aggregate.dates.add(String(row.date));
        aggregate.keywordId ||= remoteId(row.keyword_id);
        aggregate.maxProfitableCpc = Math.max(aggregate.maxProfitableCpc, numberValue(row.maximum_profitable_cpc));
        termAggregates.set(key, aggregate);
      }

      let termActions = 0;
      for (const metric of [...termAggregates.values()].sort((a: any, b: any) => b.spend - a.spend)) {
        if (budget <= 0 || termActions >= MAX_TERM_ACTIONS_PER_ACCOUNT) break;
        const campaign = campaignById.get(metric.campaignId);
        if (!campaign || !['enabled', 'active'].includes(campaignState(campaign))) continue;
        const actualAcos = metric.sales > 0 ? metric.spend / metric.sales * 100 : Number.POSITIVE_INFINITY;
        const genericHighRisk = /\b(lixeira|ventilador(?: de teto)?|headset|fone|interruptor|moedor)\b/.test(metric.term);
        const spendFloor = Math.max(TERM_MIN_SPEND, metric.maxProfitableCpc * 8) * (genericHighRisk ? 1.5 : 1);
        const clicksFloor = genericHighRisk ? 10 : TERM_MIN_CLICKS;

        if (isAutoCampaign(campaign) && metric.orders === 0 && metric.sales === 0 &&
          metric.spend >= spendFloor && metric.clicks >= clicksFloor && metric.dates.size >= 2) {
          const idempotencyKey = `auto_term_negative_exact_v1|${aid}|${metric.campaignId}|${metric.adGroupId}|${metric.term}|${day}`;
          if (priorExecutions.some((event: any) => event.idempotency_key === idempotencyKey)) continue;
          const action = { type: 'negative_exact', campaign_id: metric.campaignId, ad_group_id: metric.adGroupId,
            term: metric.term, spend: roundMoney(metric.spend), clicks: metric.clicks,
            reason: 'mature_zero_sales_search_term' };
          if (!dryRun) {
            const amazon = await invokeAds(base44, aid, '/sp/negativeKeywords', { negativeKeywords: [{
              campaignId: metric.campaignId, adGroupId: metric.adGroupId, keywordText: metric.term,
              matchType: 'NEGATIVE_EXACT', state: 'ENABLED',
            }] }, 'application/vnd.spNegativeKeyword.v3+json', 'POST');
            await recordExecution(base44, {
              amazon_account_id: aid, rule_key: 'auto_search_term_negative_exact', entity_type: 'search_term',
              entity_id: `${metric.campaignId}|${metric.adGroupId}|${metric.term}`, campaign_id: metric.campaignId,
              action_type: 'negative_exact', value_before: metric.spend, value_after: 0,
              idempotency_key: idempotencyKey, status: amazon.ok === true ? 'completed' : 'failed', executed_at: nowIso(),
              error_message: amazon.ok === true ? null : String(amazon.message || amazon.error || 'amazon_not_confirmed').slice(0, 500),
              metrics_before: JSON.stringify(action).slice(0, 2000),
            });
          }
          actions.push(action); budget--; termActions++;
          continue;
        }

        if (metric.orders <= 0 || metric.sales <= 0 || actualAcos <= accountTargetAcos * 1.2) continue;
        const keyword = keywords.find((item: any) => {
          const keywordId = remoteId(item.amazon_keyword_id || item.keyword_id);
          return String(item.campaign_id || '') === metric.campaignId &&
            ['enabled', 'active'].includes(normalizeState(item.state || item.status)) &&
            (keywordId === metric.keywordId || normalizeTarget(item.keyword_text || item.keyword) === metric.term);
        });
        if (!keyword) continue;
        const keywordId = remoteId(keyword.amazon_keyword_id || keyword.keyword_id);
        const currentBid = numberValue(keyword.current_bid || keyword.bid);
        if (!keywordId || currentBid <= minBid || intradayAdjustedKeywordIds.has(keywordId)) continue;
        const reductionPct = actualAcos > accountTargetAcos * 2 ? 25 : 15;
        const newBid = roundMoney(Math.max(minBid, currentBid * (1 - reductionPct / 100)));
        const idempotencyKey = `profitable_term_high_acos_bid_v1|${aid}|${keywordId}|${day}`;
        if (priorExecutions.some((event: any) => event.idempotency_key === idempotencyKey)) continue;
        const action = { type: 'update_bid', keyword_id: keywordId, campaign_id: metric.campaignId,
          term: metric.term, old_bid: currentBid, new_bid: newBid, acos: roundMoney(actualAcos),
          orders: metric.orders, reason: 'converting_term_above_economic_acos' };
        if (!dryRun) {
          const amazon = await invokeAds(base44, aid, '/sp/keywords', { keywords: [{ keywordId, bid: newBid }] }, 'application/vnd.spKeyword.v3+json');
          if (amazon.ok === true) await base44.asServiceRole.entities.Keyword.update(keyword.id, { bid: newBid, current_bid: newBid, last_bid_change_at: nowIso() }).catch(() => {});
          await recordExecution(base44, {
            amazon_account_id: aid, rule_key: 'converting_term_high_acos_bid_reduction', entity_type: 'keyword',
            entity_id: keywordId, keyword_id: keywordId, campaign_id: metric.campaignId, action_type: 'update_bid',
            value_before: currentBid, value_after: newBid, idempotency_key: idempotencyKey,
            status: amazon.ok === true ? 'completed' : 'failed', executed_at: nowIso(),
            error_message: amazon.ok === true ? null : String(amazon.message || amazon.error || 'amazon_not_confirmed').slice(0, 500),
            metrics_before: JSON.stringify(action).slice(0, 2000),
          });
        }
        intradayAdjustedKeywordIds.add(keywordId); actions.push(action); budget--; termActions++;
      }

      // Circuito de perda intradiária por termo/targeting. Atua antes da regra
      // agregada de campanha e reduz apenas a keyword responsável pelo gasto.
      const currentHour = Number(new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Sao_Paulo', hour: '2-digit', hourCycle: 'h23',
      }).format(new Date()));
      const hourlyByTarget = new Map<string, any>();
      const uniqueHourlyRows = new Map<string, any>();
      for (const row of hourlyRows) {
        const identity = [row.campaign_id, row.ad_group_id, row.targeting, row.date, row.hour].join('|');
        if (!uniqueHourlyRows.has(identity)) uniqueHourlyRows.set(identity, row);
      }
      for (const row of uniqueHourlyRows.values()) {
        const campaignId = String(row.campaign_id || '');
        const target = normalizeTarget(row.targeting);
        if (!campaignId || !target) continue;
        const key = `${campaignId}|${target}`;
        const aggregate = hourlyByTarget.get(key) || {
          campaignId, target, todaySpend: 0, todayClicks: 0, todayOrders: 0,
          todaySales: 0, recentSpend: 0, historicalSpend: 0, historicalHours: new Set(),
        };
        const spend = numberValue(row.cost ?? row.spend);
        const clicks = numberValue(row.clicks);
        const orders = numberValue(row.purchases ?? row.orders);
        const sales = numberValue(row.sales);
        if (String(row.date || '') === day) {
          aggregate.todaySpend += spend;
          aggregate.todayClicks += clicks;
          aggregate.todayOrders += orders;
          aggregate.todaySales += sales;
          if (numberValue(row.hour, -1) >= Math.max(0, currentHour - 1)) aggregate.recentSpend += spend;
        } else if (String(row.date || '') >= cutoffDate(7)) {
          aggregate.historicalSpend += spend;
          aggregate.historicalHours.add(`${row.date}|${row.hour}`);
        }
        hourlyByTarget.set(key, aggregate);
      }

      for (const metric of hourlyByTarget.values()) {
        if (budget <= 0 || metric.todayOrders > 0 || metric.todaySales > 0) continue;
        const baselineHourly = metric.historicalSpend / Math.max(1, metric.historicalHours.size);
        const spendThreshold = Math.max(INTRADAY_MIN_SPEND, baselineHourly * INTRADAY_SPEND_MULTIPLIER);
        const velocityThreshold = Math.max(2, baselineHourly * INTRADAY_VELOCITY_MULTIPLIER);
        const fastLoss = metric.todaySpend >= spendThreshold &&
          (metric.recentSpend >= velocityThreshold || metric.todaySpend >= 12) &&
          metric.todayClicks >= INTRADAY_MIN_CLICKS;
        if (!fastLoss) continue;

        const keyword = (keywordsByCampaign.get(metric.campaignId) || []).find((item: any) =>
          ['enabled', 'active'].includes(normalizeState(item.state || item.status)) &&
          normalizeTarget(item.keyword_text || item.keyword) === metric.target
        );
        if (!keyword) {
          skipped.push({ campaign_id: metric.campaignId, targeting: metric.target, reason: 'intraday_target_without_editable_keyword' });
          continue;
        }
        const keywordId = remoteId(keyword.amazon_keyword_id || keyword.keyword_id);
        const currentBid = numberValue(keyword.current_bid || keyword.bid, 0);
        if (!keywordId || currentBid <= 0) continue;
        const decreasePct = Math.max(20, Math.min(40, numberValue(settings.max_bid_decrease_pct, 25)));
        const newBid = roundMoney(Math.max(minBid, currentBid * (1 - decreasePct / 100)));
        if (newBid >= currentBid) continue;
        const twoHourBucket = Math.floor(currentHour / 2);
        const idempotencyKey = `intraday_zero_sales_velocity_v1|${aid}|${keywordId}|${day}|${twoHourBucket}`;
        if (priorExecutions.some((event: any) => event.idempotency_key === idempotencyKey)) continue;

        const action = {
          type: 'update_bid', keyword_id: keywordId, campaign_id: metric.campaignId,
          old_bid: currentBid, new_bid: newBid, reduction_pct: decreasePct,
          today_spend: roundMoney(metric.todaySpend), recent_spend_velocity: roundMoney(metric.recentSpend),
          baseline_hourly_spend: roundMoney(baselineHourly), clicks: metric.todayClicks,
          reason: 'intraday_high_velocity_zero_sales',
        };
        if (!dryRun) {
          const amazon = await invokeAds(base44, aid, '/sp/keywords', { keywords: [{ keywordId, bid: newBid }] }, 'application/vnd.spKeyword.v3+json');
          const completed = amazon.ok === true;
          const retryScheduled = !completed && Boolean(amazon.retryable || amazon.rate_limited || amazon.reschedule_async);
          if (completed) {
            await base44.asServiceRole.entities.Keyword.update(keyword.id, {
              bid: newBid, current_bid: newBid, last_bid_change_at: nowIso(),
            }).catch(() => {});
          } else if (retryScheduled) {
            await enqueueRetry(base44, {
              accountId: aid, operation: 'keyword_bid_update', entityType: 'keyword', entityId: keywordId,
              campaignId: metric.campaignId, keywordId,
              payload: { bid: newBid, bid_before: currentBid, reason: 'intraday_high_velocity_zero_sales' },
              idempotencyKey: `retry|${idempotencyKey}`, retryAfterSeconds: amazon.retry_after_seconds,
            });
          }
          await recordExecution(base44, {
            amazon_account_id: aid, rule_key: 'intraday_zero_sales_velocity_bid_reduction',
            entity_type: 'keyword', entity_id: keywordId, keyword_id: keywordId,
            campaign_id: metric.campaignId, action_type: 'update_bid', value_before: currentBid,
            value_after: newBid, idempotency_key: idempotencyKey,
            status: completed ? 'completed' : retryScheduled ? 'scheduled' : 'failed',
            executed_at: nowIso(),
            error_message: completed ? null : String(amazon.message || amazon.error || 'scheduled_retry').slice(0, 500),
            amazon_response: JSON.stringify({ status: amazon.status, request_id: amazon.request_id, errors: amazon.errors }).slice(0, 2000),
            metrics_before: JSON.stringify(action).slice(0, 2000),
          });
        }
        intradayAdjustedKeywordIds.add(keywordId);
        actions.push(action);
        budget--;
      }

      for (const product of products) {
        if (budget <= 0) break;
        const asin = String(product.asin || '');
        const sku = normalizeSku(product.sku);
        if (!asin && !sku) continue;
        const econ = economicsByAsin.get(asin) || economicsBySku.get(sku);
        const assessment = latestAssessment.get(asin) || latestAssessment.get(sku);
        const inventory = availableInventory(product);

        if (inventory === 0) {
          skipped.push({ asin, sku, reason: 'stock_zero_delegated_to_autoStockCampaignGuard' });
          continue;
        }
        if (!economicsAreActionable(econ, assessment)) {
          skipped.push({ asin, sku, reason: 'economics_not_actionable' });
          continue;
        }

        const policy = resolveOperatingAcos(econ, accountTargetAcos);
        const pressure = classifyProfitPressure(assessment, econ);
        const productCampaigns = (campaignsByAsin.get(asin) || []).filter((campaign: any) =>
          !campaign.archived && campaignState(campaign) !== 'archived'
        );
        if (!productCampaigns.length) continue;

        const activeCampaigns = productCampaigns.filter((campaign: any) => ['enabled', 'active'].includes(campaignState(campaign)));
        const protectedDiscoveryId = (() => {
          const autoCandidates = activeCampaigns.filter(isAutoCampaign);
          const candidates = autoCandidates.length ? autoCandidates : activeCampaigns;
          const ranked = candidates
            .map((campaign: any) => ({ campaign, metrics: campaignMetrics.get(campaignIdOf(campaign)) || {} }))
            .sort((a: any, b: any) => numberValue(b.metrics.orders) - numberValue(a.metrics.orders) || numberValue(b.metrics.sales) - numberValue(a.metrics.sales));
          return ranked[0]?.campaign ? campaignIdOf(ranked[0].campaign) : '';
        })();

        if (['watch', 'defensive', 'critical'].includes(pressure)) {
          for (const campaign of activeCampaigns) {
            if (budget <= 0) break;
            const campaignId = campaignIdOf(campaign);
            if (!campaignId) continue;
            const metrics = campaignMetrics.get(campaignId) || { spend: 0, sales: 0, orders: 0, clicks: 0, impressions: 0, last_sale_at: null };
            const winner = isProtectedWinner({
              orders: numberValue(metrics.orders), sales: numberValue(metrics.sales), spend: numberValue(metrics.spend),
              targetAcos: policy.target_acos, lastSaleAt: metrics.last_sale_at,
              protectedFlag: campaign.ads_protected === true || campaign.protected_high_performance === true,
            });
            if (winner.protected) {
              skipped.push({ asin, sku, campaign_id: campaignId, reason: winner.reason });
              continue;
            }

            const clicks = numberValue(metrics.clicks);
            const spend = numberValue(metrics.spend);
            const orders = numberValue(metrics.orders);
            const maxProfitableCpa = numberValue(assessment?.maximum_profitable_cpa, 0) || numberValue(econ?.profit_before_ads, 0);
            const evidenceSpend = Math.max(6, maxProfitableCpa > 0 ? maxProfitableCpa * 0.50 : 6);
            const observedCvr = clicks > 0 ? orders / clicks : 0;
            const observedAov = orders > 0 ? numberValue(metrics.sales) / orders : numberValue(econ?.current_price, 0);
            const safeMaxCpc = resolveSafeMaxCpc({ economics: econ, observedCvr, observedAov, operatingAcos: policy.target_acos });
            const campaignAcos = numberValue(metrics.sales) > 0 ? spend / numberValue(metrics.sales) * 100 : null;
            const structuralLoss =
              numberValue(econ?.profit_before_ads, 0) <= 0 ||
              (policy.break_even_acos !== null && policy.break_even_acos <= 3) ||
              (safeMaxCpc !== null && safeMaxCpc < minBid);

            if ((clicks >= 10 || spend >= evidenceSpend) && budget > 0) {
              for (const keyword of (keywordsByCampaign.get(campaignId) || [])) {
                if (budget <= 0) break;
                if (!['enabled', 'active'].includes(normalizeState(keyword.state || keyword.status))) continue;
                const keywordId = remoteId(keyword.amazon_keyword_id || keyword.keyword_id);
                const currentBid = numberValue(keyword.current_bid || keyword.bid, 0);
                if (!keywordId || currentBid <= 0) continue;
                if (intradayAdjustedKeywordIds.has(keywordId)) continue;
                const idempotencyKey = `sku_profit_bid_v2|${aid}|${keywordId}|${day}`;
                if (priorExecutions.some((event: any) => event.idempotency_key === idempotencyKey)) continue;
                if (hoursSince(keyword.last_bid_change_at) < BID_COOLDOWN_HOURS) continue;
                const newBid = bidAfterProfitGuard({
                  currentBid, minBid, maxBid,
                  pressure: pressure as 'watch' | 'defensive' | 'critical',
                  safeMaxCpc,
                });
                if (newBid >= currentBid) continue;

                const action = { type: 'update_bid', asin, sku, campaign_id: campaignId, keyword_id: keywordId, old_bid: currentBid, new_bid: newBid, pressure, target_acos: policy.target_acos, break_even_acos: policy.break_even_acos };
                if (!dryRun) {
                  const amazon = await invokeAds(base44, aid, '/sp/keywords', { keywords: [{ keywordId, bid: newBid }] }, 'application/vnd.spKeyword.v3+json');
                  const completed = amazon.ok === true;
                  const retryScheduled = !completed && Boolean(amazon.retryable || amazon.rate_limited || amazon.reschedule_async);
                  if (completed) {
                    await base44.asServiceRole.entities.Keyword.update(keyword.id, { bid: newBid, current_bid: newBid, last_bid_change_at: nowIso() }).catch(() => {});
                  } else if (retryScheduled) {
                    await enqueueRetry(base44, {
                      accountId: aid, operation: 'keyword_bid_update', entityType: 'keyword', entityId: keywordId,
                      campaignId, keywordId, payload: { bid: newBid, bid_before: currentBid, reason: 'sku_profit_guard_v2' },
                      idempotencyKey: `retry|${idempotencyKey}`, retryAfterSeconds: amazon.retry_after_seconds,
                    });
                  }
                  await recordExecution(base44, {
                    amazon_account_id: aid, rule_key: 'sku_profit_bid_reduction', entity_type: 'keyword', entity_id: keywordId,
                    keyword_id: keywordId, campaign_id: campaignId, asin, action_type: 'update_bid', value_before: currentBid,
                    value_after: newBid, idempotency_key: idempotencyKey, status: completed ? 'completed' : retryScheduled ? 'scheduled' : 'failed',
                    executed_at: nowIso(), error_message: completed ? null : String(amazon.message || amazon.error || amazon.errors?.[0]?.message || 'scheduled_retry').slice(0, 500),
                    amazon_response: JSON.stringify({ status: amazon.status, request_id: amazon.request_id, errors: amazon.errors }).slice(0, 2000),
                    metrics_before: JSON.stringify({ pressure, target_acos: policy.target_acos, break_even_acos: policy.break_even_acos, campaign_metrics: metrics, assessment_date: assessment?.assessment_date }).slice(0, 2000),
                  });
                }
                actions.push(action);
                budget--;
              }
            }

            const previousReduction = priorExecutions
              .filter((event: any) => event.rule_key === 'sku_profit_bid_reduction' && event.campaign_id === campaignId && event.status === 'completed')
              .sort((a: any, b: any) => new Date(b.executed_at || 0).getTime() - new Date(a.executed_at || 0).getTime())[0];
            const standardLossConfirmed =
              (orders === 0 || (campaignAcos !== null && policy.break_even_acos !== null && campaignAcos >= policy.break_even_acos)) &&
              clicks >= 20 &&
              spend >= Math.max(12, maxProfitableCpa > 0 ? maxProfitableCpa : 12) &&
              campaignId !== protectedDiscoveryId &&
              activeCampaigns.length > 1 &&
              previousReduction &&
              hoursSince(previousReduction.executed_at) >= PAUSE_AFTER_REDUCTION_HOURS;
            const structuralLossConfirmed =
              structuralLoss &&
              clicks >= 5 &&
              spend >= Math.max(5, maxProfitableCpa > 0 ? maxProfitableCpa : 5);
            // Circuit breaker para campanha única/de descoberta: não permite
            // acumular gasto indefinido sem qualquer pedido. O teto de evidência
            // é metade do CPA lucrável, limitado a R$12 e nunca abaixo de R$5.
            const zeroSalesGuard = zeroSalesCircuitBreaker({
              orders, sales: numberValue(metrics.sales), clicks, spend,
              maximumProfitableCpa: maxProfitableCpa,
            });
            const zeroSalesSpendLimit = zeroSalesGuard.spendLimit;
            const zeroSalesCircuitOpen = zeroSalesGuard.triggered;
            const canPause = pressure === 'critical' &&
              (standardLossConfirmed || structuralLossConfirmed || zeroSalesCircuitOpen);

            if (canPause && budget > 0) {
              const idempotencyKey = `sku_profit_pause_v2|${aid}|${campaignId}|${day}`;
              if (!priorExecutions.some((event: any) => event.idempotency_key === idempotencyKey)) {
                const action = {
                  type: 'pause_campaign', asin, sku, campaign_id: campaignId, pressure,
                  spend_14d: roundMoney(spend), clicks_14d: clicks,
                  campaign_acos: campaignAcos === null ? null : roundMoney(campaignAcos),
                  structural_loss: structuralLoss,
                  zero_sales_circuit_breaker: zeroSalesCircuitOpen,
                  zero_sales_spend_limit: roundMoney(zeroSalesSpendLimit),
                  preserved_campaign_id: structuralLoss || zeroSalesCircuitOpen ? null : protectedDiscoveryId,
                };
                if (!dryRun) {
                  const amazon = await invokeAds(base44, aid, '/sp/campaigns', { campaigns: [{ campaignId, state: 'PAUSED' }] }, 'application/vnd.spCampaign.v3+json');
                  const completed = amazon.ok === true;
                  const conflicted = amazon.status === 409;
                  if (completed) {
                    await base44.asServiceRole.entities.Campaign.update(campaign.id, { state: 'paused', status: 'paused', amazon_status: 'paused', synced_at: nowIso(), last_activity_at: nowIso() }).catch(() => {});
                  }
                  await recordExecution(base44, {
                    amazon_account_id: aid, rule_key: 'sku_profit_campaign_pause', entity_type: 'campaign', entity_id: campaignId,
                    campaign_id: campaignId, asin, action_type: 'pause_campaign', idempotency_key: idempotencyKey,
                    status: completed ? 'completed' : conflicted ? 'scheduled' : 'failed', executed_at: nowIso(),
                    error_message: completed ? null : String(amazon.message || amazon.error || amazon.errors?.[0]?.message || (conflicted ? 'amazon_conflict_requires_sync_confirmation' : 'amazon_error')).slice(0, 500),
                    amazon_response: JSON.stringify({ status: amazon.status, request_id: amazon.request_id, errors: amazon.errors }).slice(0, 2000),
                    metrics_before: JSON.stringify({ pressure, metrics, policy, structural_loss: structuralLoss, zero_sales_circuit_breaker: zeroSalesCircuitOpen, zero_sales_spend_limit: zeroSalesSpendLimit, assessment_date: assessment?.assessment_date }).slice(0, 2000),
                  });
                }
                actions.push(action);
                budget--;
              }
            }
          }
        }

        const assessmentConfidence = numberValue(assessment?.confidence, 0);
        const assessmentConfident = assessmentConfidence >= 0.8 || assessmentConfidence >= 80;
        if (pressure === 'healthy' && assessmentConfident) {
          for (const campaign of productCampaigns.filter((item: any) => campaignState(item) === 'paused')) {
            if (budget <= 0) break;
            const campaignId = campaignIdOf(campaign);
            const priorPause = priorExecutions
              .filter((event: any) => event.rule_key === 'sku_profit_campaign_pause' && event.campaign_id === campaignId && event.status === 'completed')
              .sort((a: any, b: any) => new Date(b.executed_at || 0).getTime() - new Date(a.executed_at || 0).getTime())[0];
            if (!priorPause || hoursSince(priorPause.executed_at) < REACTIVATION_COOLDOWN_HOURS) continue;
            const idempotencyKey = `sku_profit_reactivate_v2|${aid}|${campaignId}|${day}`;
            if (priorExecutions.some((event: any) => event.idempotency_key === idempotencyKey)) continue;
            const action = { type: 'reactivate_campaign', asin, sku, campaign_id: campaignId, reason: 'latest_economic_assessment_healthy' };
            if (!dryRun) {
              const amazon = await invokeAds(base44, aid, '/sp/campaigns', { campaigns: [{ campaignId, state: 'ENABLED' }] }, 'application/vnd.spCampaign.v3+json');
              const completed = amazon.ok === true;
              if (completed) {
                await base44.asServiceRole.entities.Campaign.update(campaign.id, { state: 'enabled', status: 'enabled', amazon_status: 'enabled', synced_at: nowIso(), last_activity_at: nowIso() }).catch(() => {});
              }
              await recordExecution(base44, {
                amazon_account_id: aid, rule_key: 'sku_profit_campaign_reactivation', entity_type: 'campaign', entity_id: campaignId,
                campaign_id: campaignId, asin, action_type: 'enable_campaign', idempotency_key: idempotencyKey,
                status: completed ? 'completed' : 'failed', executed_at: nowIso(),
                error_message: completed ? null : String(amazon.message || amazon.error || amazon.errors?.[0]?.message || 'blocked_or_failed').slice(0, 500),
                amazon_response: JSON.stringify({ status: amazon.status, request_id: amazon.request_id, errors: amazon.errors }).slice(0, 2000),
                metrics_before: JSON.stringify({ pressure, policy, assessment_date: assessment?.assessment_date }).slice(0, 2000),
              });
            }
            actions.push(action);
            budget--;
          }
        }
      }

      const summary = {
        products_evaluated: products.length,
        actions: actions.length,
        bid_reductions: actions.filter((action) => action.type === 'update_bid').length,
        intraday_zero_sales_velocity_reductions: actions.filter((action) => action.reason === 'intraday_high_velocity_zero_sales').length,
        pauses: actions.filter((action) => action.type === 'pause_campaign').length,
        structural_pauses: actions.filter((action) => action.type === 'pause_campaign' && action.structural_loss).length,
        zero_sales_circuit_breaker_pauses: actions.filter((action) => action.type === 'pause_campaign' && action.zero_sales_circuit_breaker).length,
        reactivations: actions.filter((action) => action.type === 'reactivate_campaign').length,
        skipped: skipped.length,
        invalid_zero_revenue_margins_repaired: invalidZeroRevenueMarginsRepaired,
        hardcoded_sku_rules: 0,
        dry_run: dryRun,
      };
      if (!dryRun) {
        await base44.asServiceRole.entities.SyncExecutionLog.create({
          amazon_account_id: aid,
          operation: 'sku_profit_protection_v2',
          trigger_type: body._service_role ? 'scheduler' : 'manual',
          status: 'success',
          execution_date: day,
          started_at: startedAt,
          completed_at: nowIso(),
          records_processed: actions.length,
          result_summary: JSON.stringify(summary),
        }).catch(() => {});
      }
      results.push({ amazon_account_id: aid, date: day, summary, actions, skipped: skipped.slice(0, 100) });
    }

    return Response.json({
      ok: true,
      policy_version: RULE_VERSION,
      dry_run: dryRun,
      policy: {
        hardcoded_skus: false,
        account_economics_required: true,
        bid_reduction_before_pause: true,
        structural_loss_can_pause_immediately: true,
        zero_sales_single_campaign_can_pause: true,
        zero_sales_minimum_clicks: 8,
        zero_sales_max_evidence_spend: 12,
        preserve_discovery_campaign_when_economically_viable: true,
        winner_protection: true,
        max_bid_reduction_per_cycle_pct: 20,
        intraday_zero_sales_max_bid_reduction_pct: 40,
        intraday_minimum_spend: INTRADAY_MIN_SPEND,
        intraday_minimum_clicks: INTRADAY_MIN_CLICKS,
      },
      results,
    });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || 'Falha na proteção econômica por SKU' }, { status: 500 });
  }
});
