import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import {
  classifyCurrentHour,
  classifyDelivery,
  productGate,
  structuralLoss,
} from '../../shared/campaignDeliveryGovernor.ts';
import {
  economicsAreActionable,
  normalizeState,
  numberValue,
  resolveBreakEvenAcos,
  resolveOperatingAcos,
  roundMoney,
} from '../../shared/profitGuardPolicy.ts';
import { isProductCampaignPauseLocked } from '../../shared/productCampaignPauseGuard.ts';
import { detectSequentialDeterioration, estimateMatureClicks } from '../../shared/decisionStatistics.ts';
import { classifyAttributionMaturity } from '../../shared/attributionMaturity.ts';

const LOOKBACK_DAYS = 30;
const METRICS_FRESH_HOURS = 48;
const ORPHAN_ARCHIVE_CONFIRM_HOURS = 72;
const AMAZON_PROPAGATION_MS = 12000;
const SOURCE = 'runCampaignDeliveryGovernor';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const norm = (value: unknown) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
const upper = (value: unknown) => String(value || '').trim().toUpperCase();
const enabled = (value: unknown) => ['enabled', 'active'].includes(normalizeState(value));
const campaignIdOf = (row: any) => String(row?.amazon_campaign_id || row?.campaign_id || '');
const ageHours = (value: unknown) => {
  const timestamp = new Date(String(value || 0)).getTime();
  return Number.isFinite(timestamp) && timestamp > 0 ? (Date.now() - timestamp) / 3600000 : Number.POSITIVE_INFINITY;
};
const remoteId = (value: unknown) => /^\d+$/.test(String(value || '')) ? String(value) : '';

function brtHour(): number {
  const value = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false,
  }).format(new Date());
  return Number(value) % 24;
}

function responseId(data: any, group: string, field: string): string | null {
  const payload = data?.payload || data || {};
  return payload?.[group]?.success?.[0]?.[field]
    || payload?.success?.[0]?.[field]
    || payload?.[group]?.[0]?.[field]
    || (Array.isArray(payload) ? payload[0]?.[field] : null)
    || null;
}

async function list(entity: any, filters: Record<string, unknown>, sort = '-updated_at', limit = 5000) {
  return entity?.filter ? entity.filter(filters, sort, limit).catch(() => []) : [];
}

async function ads(base44: any, accountId: string, operation: string, method: string, path: string, payload: any, contentType: string) {
  const response = await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
    amazon_account_id: accountId,
    operation,
    method,
    path,
    payload,
    content_type: contentType,
    accept: contentType,
    max_attempts: 3,
    _service_role: true,
  }).catch((error: any) => ({ data: { ok: false, error: error?.message || String(error), retryable: true } }));
  const data = response?.data || response || {};
  if (data.ok !== true) {
    const error: any = new Error(data.message || data.error || data.amazon_error || `${operation} falhou`);
    error.status = Number(data.status || data.amazon_status || 0);
    error.payload = data;
    throw error;
  }
  return data;
}

async function recordDecision(base44: any, payload: any) {
  const prior = await list(base44.asServiceRole.entities.OptimizationDecision, {
    amazon_account_id: payload.amazon_account_id,
    idempotency_key: payload.idempotency_key,
  }, '-created_at', 1);
  if (prior.length) return prior[0];
  return base44.asServiceRole.entities.OptimizationDecision.create({
    entity_type: 'campaign',
    requires_approval: false,
    approval_status: 'auto_approved',
    status: payload.status || 'executed',
    source_function: SOURCE,
    created_at: new Date().toISOString(),
    ...payload,
  });
}

async function updateMonitoring(base44: any, campaign: any, code: string, reason: string, nextHours = 24) {
  if (!campaign?.id) return;
  const now = new Date().toISOString();
  await base44.asServiceRole.entities.Campaign.update(campaign.id, {
    delivery_status: code.toLowerCase(),
    delivery_block_reason: `${SOURCE}|${code}|${reason}`.slice(0, 1000),
    last_serving_check_at: now,
    next_delivery_review_at: new Date(Date.now() + nextHours * 3600000).toISOString(),
    requires_attention: code.includes('REVIEW') || code.includes('REPLACE') || code.includes('STALE') || code.includes('MISSING'),
  }).catch(() => {});
}

async function changeCampaignState(base44: any, accountId: string, campaign: any, state: 'ENABLED' | 'PAUSED' | 'ARCHIVED', code: string, reason: string) {
  const campaignId = remoteId(campaignIdOf(campaign));
  if (!campaignId) throw new Error('Campanha sem ID remoto válido.');
  const key = `${SOURCE}|state|${accountId}|${campaignId}|${state}|${new Date().toISOString().slice(0, 13)}`;
  const prior = await list(base44.asServiceRole.entities.OptimizationDecision, {
    amazon_account_id: accountId,
    idempotency_key: key,
  }, '-created_at', 1);
  if (prior.length) return { ok: true, duplicate: true, decision: prior[0] };

  const amazon = await ads(base44, accountId, `deliveryGovernor${state}`, 'PUT', '/sp/campaigns', {
    campaigns: [{ campaignId, state }],
    idempotencyKey: key,
  }, 'application/vnd.spCampaign.v3+json');

  const now = new Date().toISOString();
  const patch: any = {
    state: state.toLowerCase(),
    status: state.toLowerCase(),
    amazon_status: state.toLowerCase(),
    is_operational: state === 'ENABLED',
    delivery_status: code.toLowerCase(),
    delivery_block_reason: `${SOURCE}|${code}|${reason}`.slice(0, 1000),
    last_serving_check_at: now,
    next_delivery_review_at: new Date(Date.now() + (state === 'ENABLED' ? 24 : 1) * 3600000).toISOString(),
    requires_attention: state !== 'ENABLED',
    synced_at: now,
  };
  if (state === 'ARCHIVED') {
    patch.archived = true;
    patch.archived_at = now;
    patch.archive_reason = reason;
  }
  await base44.asServiceRole.entities.Campaign.update(campaign.id, patch);

  const decision = await recordDecision(base44, {
    amazon_account_id: accountId,
    campaign_id: campaignId,
    entity_id: campaignId,
    asin: campaign.asin || null,
    sku: campaign.sku || null,
    decision_type: state === 'ENABLED' ? 'campaign_reactivate' : state === 'ARCHIVED' ? 'campaign_archive' : 'campaign_pause',
    action: state === 'ENABLED' ? 'reactivate_campaign' : state === 'ARCHIVED' ? 'archive_campaign' : 'pause_campaign',
    rationale: reason,
    rule_key: code,
    confidence: 99,
    risk: state === 'ARCHIVED' ? 'high' : 'low',
    status: 'executed',
    confirmation_required: true,
    confirmation_status: 'confirmed',
    amazon_response: JSON.stringify(amazon).slice(0, 4000),
    amazon_response_code: Number(amazon.status || 200),
    amazon_request_id: amazon.request_id || null,
    idempotency_key: key,
    executed_at: now,
  });
  return { ok: true, amazon, decision };
}

function campaignProduct(campaign: any, products: any[], productAds: any[]) {
  const campaignId = campaignIdOf(campaign);
  const linkedAd = productAds.find((ad: any) => String(ad.campaign_id || '') === campaignId);
  const asin = upper(campaign.asin || campaign.advertised_asin || linkedAd?.asin);
  const sku = upper(campaign.sku || linkedAd?.sku);
  return products.find((product: any) =>
    (asin && upper(product.asin) === asin) || (sku && upper(product.sku) === sku)
  ) || null;
}

function economicsFor(product: any, economics: any[]) {
  if (!product) return null;
  return economics.find((row: any) =>
    (product.asin && upper(row.asin) === upper(product.asin)) ||
    (product.sku && upper(row.sku || row.normalized_sku) === upper(product.sku))
  ) || null;
}

function metricTimestamp(row: any): number {
  const timestamp = new Date(`${row?.date || '1970-01-01'}T23:59:59Z`).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function aggregateMetrics(rows: any[], campaign: any, fallbackFresh: boolean) {
  const result: any = { impressions: 0, clicks: 0, orders: 0, sales: 0, spend: 0, newest: 0 };
  for (const row of rows) {
    result.impressions += numberValue(row.impressions, 0);
    result.clicks += numberValue(row.clicks, 0);
    result.orders += numberValue(row.orders ?? row.purchases, 0);
    result.sales += numberValue(row.sales ?? row.attributed_sales, 0);
    result.spend += numberValue(row.spend ?? row.cost, 0);
    result.newest = Math.max(result.newest, metricTimestamp(row));
  }
  if (!rows.length && fallbackFresh) {
    result.impressions = numberValue(campaign.impressions, 0);
    result.clicks = numberValue(campaign.clicks, 0);
    result.orders = numberValue(campaign.orders, 0);
    result.sales = numberValue(campaign.sales, 0);
    result.spend = numberValue(campaign.spend ?? campaign.current_spend, 0);
  }
  result.metricsFresh = Boolean(
    (result.newest && Date.now() - result.newest <= METRICS_FRESH_HOURS * 3600000) ||
    (!rows.length && fallbackFresh)
  );
  result.source = rows.length ? 'CampaignMetricsDaily' : fallbackFresh ? 'fresh_campaign_snapshot' : 'missing';
  result.attributionConfidence = 'unknown';
  result.sameSkuOrders = null;
  result.sameSkuSales = null;
  result.haloOrders = null;
  result.haloSales = null;
  return result;
}

function unifiedMetricKey(row: any): string {
  return [row.date, row.campaign_id, row.ad_group_id, row.advertised_product_id, row.advertised_sku].map((value) => String(value || '')).join('|');
}

function dedupeUnifiedMetrics(rows: any[]): any[] {
  const byKey = new Map<string, any>();
  for (const row of rows) {
    const key = unifiedMetricKey(row);
    const current = byKey.get(key);
    const rowTime = new Date(row.synced_at || row.updated_at || row.created_at || 0).getTime();
    const currentTime = new Date(current?.synced_at || current?.updated_at || current?.created_at || 0).getTime();
    if (!current || rowTime >= currentTime) byKey.set(key, row);
  }
  return Array.from(byKey.values());
}

function aggregateUnifiedMetrics(rows: any[]) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
  const result: any = {
    impressions: 0, clicks: 0, orders: 0, sales: 0, spend: 0, newest: 0,
    sameSkuOrders: 0, sameSkuSales: 0, haloOrders: 0, haloSales: 0,
    metricsFresh: false, source: 'UnifiedAdsMetricsDaily', attributionConfidence: 'complete',
  };
  for (const row of dedupeUnifiedMetrics(rows)) {
    result.impressions += numberValue(row.impressions, 0);
    result.clicks += numberValue(row.clicks, 0);
    result.orders += numberValue(row.promoted_purchases, 0);
    result.sales += numberValue(row.promoted_sales, 0);
    result.sameSkuOrders += numberValue(row.promoted_purchases, 0);
    result.sameSkuSales += numberValue(row.promoted_sales, 0);
    result.haloOrders += numberValue(row.halo_purchases, 0);
    result.haloSales += numberValue(row.halo_sales, 0);
    result.spend += numberValue(row.cost, 0);
    result.newest = Math.max(result.newest, metricTimestamp(row));
    if (classifyAttributionMaturity(String(row.date || ''), today) !== 'mature') result.attributionConfidence = 'partial';
  }
  result.metricsFresh = Boolean(result.newest && Date.now() - result.newest <= METRICS_FRESH_HOURS * 3600000);
  return result;
}

function normalizedConversionRate(...values: unknown[]): number {
  for (const value of values) {
    const parsed = numberValue(value, 0);
    if (parsed > 0) return Math.min(1, parsed > 1 ? parsed / 100 : parsed);
  }
  return 0.05;
}

function currentHourMetrics(rows: any[], hour: number) {
  const result: any = { sampleDays: new Set<string>(), impressions: 0, clicks: 0, orders: 0, sales: 0, spend: 0 };
  for (const row of rows) {
    if (Number(row.hour) !== hour || normalizeState(row.data_maturity) !== 'mature' || row.attribution_scope !== 'same_sku') continue;
    result.impressions += numberValue(row.impressions, 0);
    result.clicks += numberValue(row.clicks, 0);
    result.orders += numberValue(row.promoted_orders, 0);
    result.sales += numberValue(row.promoted_sales, 0);
    result.spend += numberValue(row.spend, 0);
    if (row.date) result.sampleDays.add(String(row.date));
  }
  return { ...result, sampleDays: result.sampleDays.size, attributionConfidence: result.sampleDays.size > 0 ? 'complete' : 'unknown' };
}

function manualExact(campaign: any, campaignKeywords: any[]) {
  const targeting = upper(campaign.targeting_type || campaign.targetingType);
  const name = upper(campaign.name || campaign.campaign_name);
  return targeting === 'MANUAL' && campaignKeywords.some((keyword: any) =>
    enabled(keyword.state || keyword.status) && upper(keyword.match_type || keyword.matchType) === 'EXACT'
  ) && (name.includes('EXACT') || !campaign.match_type || upper(campaign.match_type) === 'EXACT');
}

function candidateTerm(rows: any[], suggestions: any[], asin: string, excluded: Set<string>) {
  const bank = rows
    .filter((row: any) => upper(row.asin) === asin)
    .map((row: any) => ({
      term: String(row.term || row.keyword || row.term_normalized || '').trim(),
      relevance: numberValue(row.relevance_score ?? row.confidence ?? row.relevance, 0),
      status: norm(row.status || 'active'),
      source: 'TermBank',
      sourceId: row.id,
      suggestedLow: numberValue(row.suggested_bid_low, 0),
    }))
    .filter((row: any) => row.term && row.term.split(/\s+/).length >= 2 && row.relevance >= 0.90 && !['blocked', 'rejected', 'archived', 'paused'].includes(row.status) && !excluded.has(norm(row.term)))
    .sort((a: any, b: any) => b.relevance - a.relevance);
  if (bank.length) return bank[0];

  const amazon = suggestions
    .filter((row: any) => upper(row.asin) === asin)
    .map((row: any) => ({
      term: String(row.keyword || row.term || '').trim(),
      relevance: numberValue(row.confidence ?? row.relevance_score, 0),
      status: norm(row.status || 'suggested'),
      source: 'AmazonAdsSuggestions',
      sourceId: row.id,
      suggestedLow: numberValue(row.suggested_bid_low ?? row.range_lower, 0),
    }))
    .filter((row: any) => row.term && row.term.split(/\s+/).length >= 2 && row.relevance >= 0.90 && !['blocked', 'rejected', 'archived', 'applied'].includes(row.status) && !excluded.has(norm(row.term)))
    .sort((a: any, b: any) => b.relevance - a.relevance);
  return amazon[0] || null;
}

async function createExactReplacement(params: {
  base44: any; account: any; product: any; economics: any; oldCampaign: any; oldKeyword: any;
  candidate: any; settings: any; campaigns: any[]; keywords: any[]; adGroups: any[];
}) {
  const { base44, account, product, economics, oldCampaign, oldKeyword, candidate, settings, campaigns, keywords, adGroups } = params;
  const aid = account.id;
  const asin = upper(product.asin);
  const sku = String(product.sku || '').trim();
  const term = String(candidate.term).trim();
  const termNorm = norm(term);
  const duplicateKeyword = keywords.find((row: any) =>
    upper(row.asin) === asin && norm(row.keyword_text || row.keyword) === termNorm &&
    upper(row.match_type) === 'EXACT' && enabled(row.state || row.status)
  );
  if (duplicateKeyword) return { ok: true, already_exists: true, campaign_id: String(duplicateKeyword.campaign_id), term };

  const minBid = Math.max(0.10, numberValue(settings.min_bid, 0.20));
  const maxBid = Math.max(minBid, numberValue(settings.max_bid, 5));
  const safeCpc = numberValue(economics?.safe_max_cpc, 0);
  if (safeCpc <= 0) throw new Error('CPC seguro ausente; substituição bloqueada até atualizar a economia real do produto.');
  if (safeCpc < minBid) throw new Error(`CPC seguro ${safeCpc} inferior ao bid mínimo ${minBid}; substituição bloqueada.`);
  const currentBid = numberValue(oldKeyword?.current_bid ?? oldKeyword?.bid, minBid);
  const suggested = numberValue(candidate.suggestedLow, 0);
  const bid = roundMoney(Math.max(minBid, Math.min(maxBid, safeCpc, suggested > 0 ? suggested : currentBid)));
  const budget = Math.max(1, numberValue(settings.minimum_campaign_budget, 5));
  const clean = term.replace(/[^a-z0-9\sáéíóúâêôãõç-]/gi, '').trim().slice(0, 45);
  const name = `SP | MANUAL | EXACT | ${asin} | ${clean}`.slice(0, 128);
  const key = `${SOURCE}|replace|${aid}|${asin}|${termNorm}`;
  const now = new Date().toISOString();

  const campaignResult = await ads(base44, aid, 'deliveryGovernorCreateCampaign', 'POST', '/sp/campaigns', {
    campaigns: [{ name, targetingType: 'MANUAL', state: 'ENABLED', budget: { budgetType: 'DAILY', budget }, startDate: now.slice(0, 10) }],
    idempotencyKey: key,
  }, 'application/vnd.spCampaign.v3+json');
  const campaignId = responseId(campaignResult, 'campaigns', 'campaignId');
  if (!campaignId) throw new Error('Amazon não confirmou campaignId da campanha substituta.');

  await wait(AMAZON_PROPAGATION_MS);
  const adGroupResult = await ads(base44, aid, 'deliveryGovernorCreateAdGroup', 'POST', '/sp/adGroups', {
    adGroups: [{ name: `AG | EXACT | ${asin}`, campaignId, defaultBid: bid, state: 'ENABLED' }],
    idempotencyKey: `${key}|adgroup`,
  }, 'application/vnd.spAdGroup.v3+json');
  const adGroupId = responseId(adGroupResult, 'adGroups', 'adGroupId');
  if (!adGroupId) throw new Error('Amazon não confirmou Ad Group da substituta.');

  await wait(AMAZON_PROPAGATION_MS);
  const productAdResult = await ads(base44, aid, 'deliveryGovernorCreateProductAd', 'POST', '/sp/productAds', {
    productAds: [{ campaignId, adGroupId, ...(sku ? { sku } : { asin }), state: 'ENABLED' }],
    idempotencyKey: `${key}|productad`,
  }, 'application/vnd.spProductAd.v3+json');
  const productAdId = responseId(productAdResult, 'productAds', 'adId') || responseId(productAdResult, 'productAds', 'productAdId');
  if (!productAdId) throw new Error('Amazon não confirmou Product Ad da substituta.');

  await wait(AMAZON_PROPAGATION_MS);
  const keywordResult = await ads(base44, aid, 'deliveryGovernorCreateKeyword', 'POST', '/sp/keywords', {
    keywords: [{ campaignId, adGroupId, keywordText: term, matchType: 'EXACT', state: 'ENABLED', bid: { value: bid, bidType: 'DEFAULT' } }],
    idempotencyKey: `${key}|keyword`,
  }, 'application/vnd.spKeyword.v3+json');
  const keywordId = responseId(keywordResult, 'keywords', 'keywordId');
  if (!keywordId) throw new Error('Amazon não confirmou keyword EXACT da substituta.');

  const autoCampaigns = campaigns.filter((campaign: any) =>
    upper(campaign.asin) === asin && upper(campaign.targeting_type) === 'AUTO' && enabled(campaign.state || campaign.status)
  );
  const negativeResults: any[] = [];
  for (const autoCampaign of autoCampaigns) {
    const autoCampaignId = campaignIdOf(autoCampaign);
    const autoGroup = adGroups.find((group: any) => String(group.campaign_id) === autoCampaignId && enabled(group.state || group.status));
    if (!autoGroup?.ad_group_id) {
      negativeResults.push({ campaign_id: autoCampaignId, ok: false, error: 'AUTO sem Ad Group ativo para negativa exata.' });
      continue;
    }
    try {
      const negative = await ads(base44, aid, 'deliveryGovernorNegativeExact', 'POST', '/sp/negativeKeywords', {
        negativeKeywords: [{ campaignId: autoCampaignId, adGroupId: String(autoGroup.ad_group_id), keywordText: term, matchType: 'NEGATIVE_EXACT', state: 'ENABLED' }],
        idempotencyKey: `${key}|negative|${autoCampaignId}`,
      }, 'application/vnd.spNegativeKeyword.v3+json');
      negativeResults.push({ campaign_id: autoCampaignId, ok: true, request_id: negative.request_id || null });
    } catch (error: any) {
      negativeResults.push({ campaign_id: autoCampaignId, ok: false, error: error.message, status: error.status || 0 });
    }
  }
  const negativesConfirmed = autoCampaigns.length === 0 || negativeResults.every((row) => row.ok);

  const localCampaign = await base44.asServiceRole.entities.Campaign.create({
    amazon_account_id: aid,
    campaign_id: String(campaignId),
    amazon_campaign_id: String(campaignId),
    asin,
    name,
    campaign_name: name,
    campaign_type: 'SP',
    targeting_type: 'MANUAL',
    state: 'enabled',
    status: 'enabled',
    daily_budget: budget,
    created_by_app: true,
    launch_phase: 'learning',
    delivery_status: 'replacement_learning',
    delivery_block_reason: `${SOURCE}|replacement_for|${campaignIdOf(oldCampaign)}`,
    created_at: now,
    synced_at: now,
  });
  await base44.asServiceRole.entities.AdGroup.create({
    amazon_account_id: aid,
    campaign_id: String(campaignId),
    ad_group_id: String(adGroupId),
    ad_group_name: `AG | EXACT | ${asin}`,
    name: `AG | EXACT | ${asin}`,
    state: 'enabled',
    status: 'enabled',
    default_bid: bid,
    group_type: 'exact',
    primary_asin: asin,
    ...(sku ? { primary_sku: sku } : {}),
    created_by_app: true,
  });
  await base44.asServiceRole.entities.ProductAd.create({
    amazon_account_id: aid,
    product_ad_id: String(productAdId),
    campaign_id: String(campaignId),
    ad_group_id: String(adGroupId),
    asin,
    ...(sku ? { sku } : {}),
    state: 'enabled',
    status: 'enabled',
    synced_at: now,
  });
  await base44.asServiceRole.entities.Keyword.create({
    amazon_account_id: aid,
    campaign_id: String(campaignId),
    ad_group_id: String(adGroupId),
    keyword_id: String(keywordId),
    amazon_keyword_id: String(keywordId),
    asin,
    keyword_text: term,
    keyword: term,
    match_type: 'exact',
    state: 'enabled',
    status: 'enabled',
    current_bid: bid,
    bid,
    source: 'delivery_governor_replacement',
    idempotency_key: `${key}|keyword`,
    first_seen_at: now,
    last_seen_at: now,
    synced_at: now,
  });

  if (candidate.source === 'AmazonAdsSuggestions' && candidate.sourceId) {
    await base44.asServiceRole.entities.KeywordSuggestion.update(candidate.sourceId, { status: 'applied' }).catch(() => {});
  }
  return {
    ok: negativesConfirmed,
    campaign_id: String(campaignId),
    ad_group_id: String(adGroupId),
    product_ad_id: String(productAdId),
    keyword_id: String(keywordId),
    local_campaign_id: localCampaign.id,
    term,
    bid,
    negatives_confirmed: negativesConfirmed,
    negative_results: negativeResults,
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

    const accounts = body.amazon_account_id
      ? await list(base44.asServiceRole.entities.AmazonAccount, { id: body.amazon_account_id }, '-updated_at', 1)
      : await list(base44.asServiceRole.entities.AmazonAccount, { status: 'connected' }, '-updated_at', 20);
    const summary: any = {
      ok: true,
      accounts: 0,
      campaigns_analyzed: 0,
      monitored: 0,
      bids_bootstrap_requested: 0,
      replaced: 0,
      paused: 0,
      reactivated: 0,
      archived: 0,
      errors: [],
      decisions: [],
    };
    const currentHour = brtHour();
    const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString().slice(0, 10);

    for (const account of accounts) {
      const aid = account.id;
      summary.accounts++;
      try {
        const [campaigns, products, economics, assessments, metrics, unifiedMetrics, hourly, keywords, productAds, adGroups, termBank, suggestions, settingsRows, priorDecisions] = await Promise.all([
          list(base44.asServiceRole.entities.Campaign, { amazon_account_id: aid }, '-updated_at', 5000),
          list(base44.asServiceRole.entities.Product, { amazon_account_id: aid }, '-updated_at', 3000),
          list(base44.asServiceRole.entities.ProductEconomics, { amazon_account_id: aid }, '-updated_at', 3000),
          list(base44.asServiceRole.entities.DailyProductAdsAssessment, { amazon_account_id: aid }, '-assessment_date', 3000),
          list(base44.asServiceRole.entities.CampaignMetricsDaily, { amazon_account_id: aid }, '-date', 30000),
          list(base44.asServiceRole.entities.UnifiedAdsMetricsDaily, { amazon_account_id: aid }, '-date', 30000),
          list(base44.asServiceRole.entities.HourlyMetric, { amazon_account_id: aid }, '-date', 40000),
          list(base44.asServiceRole.entities.Keyword, { amazon_account_id: aid }, '-updated_at', 15000),
          list(base44.asServiceRole.entities.ProductAd, { amazon_account_id: aid }, '-synced_at', 10000),
          list(base44.asServiceRole.entities.AdGroup, { amazon_account_id: aid }, '-updated_at', 10000),
          list(base44.asServiceRole.entities.TermBank, { amazon_account_id: aid }, '-updated_at', 10000),
          list(base44.asServiceRole.entities.KeywordSuggestion, { amazon_account_id: aid }, '-updated_at', 10000),
          list(base44.asServiceRole.entities.PerformanceSettings, { amazon_account_id: aid }, '-updated_at', 1),
          list(base44.asServiceRole.entities.OptimizationDecision, { amazon_account_id: aid }, '-created_at', 10000),
        ]);
        const settings = settingsRows[0] || {};
        const minBid = Math.max(0.10, numberValue(settings.min_bid, 0.20));
        const accountTargetAcos = numberValue(settings.target_acos, 15);
        const assessmentByAsin = new Map<string, any>();
        for (const row of assessments) {
          const asin = upper(row.asin);
          if (asin && !assessmentByAsin.has(asin)) assessmentByAsin.set(asin, row);
        }

        let newestAccountMetric = 0;
        const metricsByCampaign = new Map<string, any[]>();
        for (const row of metrics) {
          if (String(row.date || '') < cutoff) continue;
          newestAccountMetric = Math.max(newestAccountMetric, metricTimestamp(row));
          const id = String(row.campaign_id || row.amazon_campaign_id || '');
          if (!id) continue;
          const rows = metricsByCampaign.get(id) || [];
          rows.push(row);
          metricsByCampaign.set(id, rows);
        }
        const accountMetricsFresh = Boolean(newestAccountMetric && Date.now() - newestAccountMetric <= METRICS_FRESH_HOURS * 3600000);

        const unifiedByCampaign = new Map<string, any[]>();
        for (const row of unifiedMetrics) {
          if (String(row.date || '') < cutoff) continue;
          const id = String(row.campaign_id || '');
          if (!id) continue;
          const rows = unifiedByCampaign.get(id) || [];
          rows.push(row);
          unifiedByCampaign.set(id, rows);
        }

        const hourlyByCampaign = new Map<string, any[]>();
        for (const row of hourly) {
          if (String(row.date || '') < cutoff) continue;
          const id = String(row.campaign_id || '');
          if (!id) continue;
          const rows = hourlyByCampaign.get(id) || [];
          rows.push(row);
          hourlyByCampaign.set(id, rows);
        }
        const keywordsByCampaign = new Map<string, any[]>();
        for (const keyword of keywords) {
          const id = String(keyword.campaign_id || '');
          if (!id) continue;
          const rows = keywordsByCampaign.get(id) || [];
          rows.push(keyword);
          keywordsByCampaign.set(id, rows);
        }
        const exactTermsByAsin = new Map<string, Set<string>>();
        for (const keyword of keywords) {
          const asin = upper(keyword.asin);
          if (!asin || upper(keyword.match_type) !== 'EXACT' || !enabled(keyword.state || keyword.status)) continue;
          const set = exactTermsByAsin.get(asin) || new Set<string>();
          set.add(norm(keyword.keyword_text || keyword.keyword));
          exactTermsByAsin.set(asin, set);
        }

        const bootstrapAsins = new Set<string>();
        const candidates = campaigns.filter((campaign: any) =>
          upper(campaign.campaign_type || 'SP') === 'SP' &&
          !['archived', 'incomplete'].includes(normalizeState(campaign.state || campaign.status)) &&
          remoteId(campaignIdOf(campaign))
        );

        for (const campaign of candidates) {
          summary.campaigns_analyzed++;
          const campaignId = campaignIdOf(campaign);
          const state = normalizeState(campaign.amazon_status || campaign.state || campaign.status);
          const product = campaignProduct(campaign, products, productAds);
          const gate = productGate(product);
          const asin = upper(product?.asin || campaign.asin);
          const sku = String(product?.sku || campaign.sku || '');
          const econ = economicsFor(product, economics);
          const assessment = assessmentByAsin.get(asin);
          const campaignKeywords = keywordsByCampaign.get(campaignId) || [];
          const isManualExact = manualExact(campaign, campaignKeywords);
          const isAuto = upper(campaign.targeting_type) === 'AUTO';

          if (product && isProductCampaignPauseLocked(product)) {
            await updateMonitoring(base44, campaign, 'USER_MANUAL_PAUSE_LOCK', 'Produto possui trava manual; o motor não reativa nem substitui campanhas.', 24);
            summary.monitored++;
            continue;
          }

          if (!gate.eligible) {
            const reason = `Produto inelegível para Ads: ${gate.code}.`;
            try {
              if (gate.code === 'PRODUCT_NOT_FOUND') {
                const earlier = priorDecisions.find((row: any) =>
                  String(row.campaign_id || row.entity_id || '') === campaignId && row.rule_key === 'PRODUCT_NOT_FOUND' && ageHours(row.created_at) >= ORPHAN_ARCHIVE_CONFIRM_HOURS
                );
                if (state === 'enabled') {
                  await changeCampaignState(base44, aid, campaign, 'PAUSED', 'PRODUCT_NOT_FOUND', `${reason} Pausa preventiva antes do arquivamento confirmado.`);
                  summary.paused++;
                } else if (earlier) {
                  await changeCampaignState(base44, aid, campaign, 'ARCHIVED', 'PRODUCT_NOT_FOUND_CONFIRMED', `${reason} Ausência confirmada em mais de uma auditoria por 72 horas.`);
                  summary.archived++;
                } else {
                  await recordDecision(base44, {
                    amazon_account_id: aid, campaign_id: campaignId, entity_id: campaignId,
                    asin: asin || null, sku: sku || null, decision_type: 'campaign_pause', action: 'monitor_orphan_campaign',
                    rationale: `${reason} Aguardando segunda confirmação antes de arquivar.`, rule_key: 'PRODUCT_NOT_FOUND',
                    confidence: 90, risk: 'medium', status: 'executed',
                    idempotency_key: `${SOURCE}|orphan|${aid}|${campaignId}|${new Date().toISOString().slice(0, 10)}`,
                  });
                  await updateMonitoring(base44, campaign, 'PRODUCT_NOT_FOUND_REVIEW', reason, 24);
                  summary.monitored++;
                }
              } else if (state === 'enabled') {
                await changeCampaignState(base44, aid, campaign, 'PAUSED', gate.code, reason);
                summary.paused++;
                if (product?.id && gate.code === 'OUT_OF_STOCK') {
                  await base44.asServiceRole.entities.Product.update(product.id, {
                    campaign_status: 'paused', pause_reason: 'out_of_stock_confirmed',
                    ads_pause_reason: 'OUT_OF_STOCK', ads_paused_at: new Date().toISOString(),
                    ads_resume_pending: false, should_activate_campaign: false,
                  }).catch(() => {});
                }
              } else {
                await updateMonitoring(base44, campaign, gate.code, reason, gate.code === 'OUT_OF_STOCK' ? 3 : 12);
                summary.monitored++;
              }
            } catch (error: any) {
              summary.errors.push({ campaign_id: campaignId, asin, stage: 'product_gate', code: gate.code, error: error.message, status: error.status || 0 });
            }
            continue;
          }

          if (!economicsAreActionable(econ, assessment)) {
            await updateMonitoring(base44, campaign, 'MOTOR_MONITORING_ECONOMICS_MISSING', 'Economia real do produto está incompleta ou desatualizada; nenhuma ação financeira será executada.', 3);
            summary.monitored++;
            continue;
          }

          const loss = structuralLoss(econ, minBid);
          if (loss.blocked) {
            try {
              if (state === 'enabled') {
                await changeCampaignState(base44, aid, campaign, 'PAUSED', 'STRUCTURAL_PRODUCT_LOSS', loss.reason);
                summary.paused++;
              } else {
                await updateMonitoring(base44, campaign, 'STRUCTURAL_PRODUCT_LOSS', loss.reason, 24);
                summary.monitored++;
              }
            } catch (error: any) {
              summary.errors.push({ campaign_id: campaignId, asin, stage: 'structural_loss', error: error.message, status: error.status || 0 });
            }
            continue;
          }

          const campaignSyncFresh = ageHours(campaign.last_api_sync_at || campaign.last_sync_at || campaign.synced_at) <= METRICS_FRESH_HOURS;
          const campaignUnifiedRows = unifiedByCampaign.get(campaignId) || [];
          const campaignLegacyRows = metricsByCampaign.get(campaignId) || [];
          const decisionRows = campaignUnifiedRows.length ? dedupeUnifiedMetrics(campaignUnifiedRows) : campaignLegacyRows;
          const agg = campaignUnifiedRows.length
            ? aggregateUnifiedMetrics(campaignUnifiedRows)
            : aggregateMetrics(campaignLegacyRows, campaign, accountMetricsFresh && campaignSyncFresh);
          const policy = resolveOperatingAcos(econ, accountTargetAcos);
          const maximumProfitableSpend = numberValue(
            assessment?.maximum_profitable_cpa ?? econ?.maximum_profitable_ad_spend ?? econ?.profit_before_ads,
            0,
          );
          const campaignAgeHours = ageHours(campaign.start_date || campaign.created_at || campaign.created_date);
          const maturity = estimateMatureClicks(decisionRows);
          const deterioration = detectSequentialDeterioration(decisionRows.map((row: any) => ({
            date: row.date,
            clicks: row.clicks,
            orders: campaignUnifiedRows.length ? row.promoted_purchases : row.orders ?? row.purchases,
            spend: row.cost ?? row.spend,
          })));
          const priorReduction = priorDecisions.some((row: any) =>
            String(row.campaign_id || row.entity_id || '') === campaignId &&
            ageHours(row.created_at || row.executed_at) <= 30 * 24 &&
            (numberValue(row.change_pct, 0) < 0 || ['reduce_soft', 'reduce_strong'].includes(String(row.intervention_state || '')) || /reduce|decrease|profit_guard/i.test(String(row.action || row.rule_key || '')))
          );
          const conversionRate = normalizedConversionRate(assessment?.cvr, product?.conversion_rate_30d, econ?.conversion_rate);
          const safeCpc = numberValue(assessment?.safe_max_cpc ?? econ?.safe_max_cpc, 0);
          const currentCpc = agg.clicks > 0 ? agg.spend / agg.clicks : numberValue(campaign.current_bid ?? campaign.default_bid, 0);
          const persistentLowRelevance = agg.impressions >= 500 && agg.clicks / Math.max(1, agg.impressions) <= 0.001;
          const delivery = classifyDelivery({
            ageHours: campaignAgeHours,
            metricsFresh: agg.metricsFresh,
            impressions: agg.impressions,
            clicks: agg.clicks,
            orders: agg.orders,
            sales: agg.sales,
            spend: agg.spend,
            isManualExact,
            isAuto,
            maximumProfitableSpend,
            breakEvenAcos: resolveBreakEvenAcos(econ),
            targetAcos: policy.target_acos || null,
            matureClicks: maturity.mature_clicks,
            conversionRate,
            fallbackConversionRate: 0.05,
            currentCpc,
            safeCpc,
            priorReduction,
            persistentLowRelevance,
            attributionConfidence: agg.attributionConfidence,
            deteriorationLevel: deterioration.level,
            isNewProduct: numberValue(product?.days_since_launch, campaignAgeHours / 24) < 30,
          });

          const hourData = currentHourMetrics(hourlyByCampaign.get(campaignId) || [], currentHour);
          const hourDecision = classifyCurrentHour({
            sampleDays: hourData.sampleDays,
            clicks: hourData.clicks,
            orders: hourData.orders,
            sales: hourData.sales,
            spend: hourData.spend,
            maximumProfitableSpend,
            breakEvenAcos: resolveBreakEvenAcos(econ),
            targetAcos: policy.target_acos || null,
            attributionConfidence: hourData.attributionConfidence,
          });
          const pausedByHour = String(campaign.delivery_block_reason || '').includes(`${SOURCE}|PROFIT_DAYPART_PAUSE`);

          try {
            if (hourDecision.action === 'pause' && state === 'enabled') {
              await changeCampaignState(base44, aid, campaign, 'PAUSED', 'PROFIT_DAYPART_PAUSE', `${hourDecision.reason} Hora BRT ${currentHour}.`);
              summary.paused++;
              summary.decisions.push({ campaign_id: campaignId, asin, code: hourDecision.code, action: 'pause_current_hour' });
              continue;
            }
            if (hourDecision.action === 'enable' && state === 'paused' && pausedByHour) {
              await changeCampaignState(base44, aid, campaign, 'ENABLED', 'PROFIT_DAYPART_ENABLE', `${hourDecision.reason} Hora BRT ${currentHour}.`);
              summary.reactivated++;
              summary.decisions.push({ campaign_id: campaignId, asin, code: hourDecision.code, action: 'enable_current_hour' });
              continue;
            }

            if (delivery.action === 'bootstrap_bid') {
              bootstrapAsins.add(asin);
              await updateMonitoring(base44, campaign, delivery.code, delivery.reason, 3);
              await recordDecision(base44, {
                amazon_account_id: aid, campaign_id: campaignId, entity_id: campaignId, asin, sku,
                decision_type: 'bid_adjustment', action: 'request_controlled_zero_impression_bootstrap',
                rationale: delivery.reason, rule_key: delivery.code, confidence: delivery.confidence, risk: 'low', status: 'executed',
                idempotency_key: `${SOURCE}|bootstrap|${aid}|${campaignId}|${new Date().toISOString().slice(0, 10)}`,
                data_used: JSON.stringify(agg),
              });
              summary.bids_bootstrap_requested++;
              summary.decisions.push({ campaign_id: campaignId, asin, code: delivery.code, action: 'bootstrap_bid' });
              continue;
            }

            if (delivery.action === 'replace_term' && isManualExact) {
              const oldKeyword = campaignKeywords.find((keyword: any) => enabled(keyword.state || keyword.status) && upper(keyword.match_type) === 'EXACT');
              const oldTerm = String(oldKeyword?.keyword_text || oldKeyword?.keyword || '').trim();
              const excluded = new Set(exactTermsByAsin.get(asin) || []);
              excluded.add(norm(oldTerm));
              const replacementCandidate = candidateTerm(termBank, suggestions, asin, excluded);
              if (!replacementCandidate) {
                await updateMonitoring(base44, campaign, 'REPLACEMENT_TERM_UNAVAILABLE', `${delivery.reason} Nenhum termo real com relevância >=90% disponível no TermBank ou Suggestions.`, 12);
                summary.monitored++;
                continue;
              }
              const replacement = await createExactReplacement({
                base44, account, product, economics: econ, oldCampaign: campaign, oldKeyword,
                candidate: replacementCandidate, settings, campaigns, keywords, adGroups,
              });
              if (!replacement.ok) {
                await updateMonitoring(base44, campaign, 'REPLACEMENT_NEGATIVE_PENDING', `Campanha substituta criada, mas a negativa exata na AUTO ainda não foi confirmada: ${replacementCandidate.term}.`, 3);
                summary.errors.push({ campaign_id: campaignId, asin, stage: 'negative_exact_confirmation', replacement });
                continue;
              }
              await changeCampaignState(base44, aid, campaign, 'PAUSED', delivery.code, `${delivery.reason} Substituída por keyword EXACT “${replacementCandidate.term}”, confirmada na Amazon.`);
              await recordDecision(base44, {
                amazon_account_id: aid, campaign_id: campaignId, entity_id: campaignId, asin, sku,
                decision_type: 'keyword_add', action: 'replace_manual_exact_campaign',
                rationale: delivery.reason, rule_key: delivery.code, confidence: delivery.confidence, risk: 'low', status: 'executed',
                current_config: oldTerm, proposed_config: replacementCandidate.term,
                idempotency_key: `${SOURCE}|replacement_decision|${aid}|${campaignId}|${norm(replacementCandidate.term)}`,
                amazon_response: JSON.stringify(replacement).slice(0, 4000),
              });
              const terms = exactTermsByAsin.get(asin) || new Set<string>();
              terms.add(norm(replacementCandidate.term));
              exactTermsByAsin.set(asin, terms);
              summary.replaced++;
              summary.paused++;
              summary.decisions.push({ campaign_id: campaignId, asin, code: delivery.code, action: 'replace_term', new_term: replacementCandidate.term });
              continue;
            }

            if (delivery.action === 'pause') {
              if (state === 'enabled') {
                await changeCampaignState(base44, aid, campaign, 'PAUSED', delivery.code, delivery.reason);
                summary.paused++;
              } else {
                await updateMonitoring(base44, campaign, delivery.code, delivery.reason, 12);
                summary.monitored++;
              }
              summary.decisions.push({ campaign_id: campaignId, asin, code: delivery.code, action: 'pause' });
              continue;
            }

            if (delivery.action === 'profit_guard') {
              const campaignAcos = agg.sales > 0 ? agg.spend / agg.sales * 100 : null;
              const productNegative = numberValue(econ?.profit_after_ads_14d ?? econ?.profit_after_ads, 0) < 0;
              const evidence: any = delivery.evidence || {};
              await recordDecision(base44, {
                amazon_account_id: aid, campaign_id: campaignId, entity_id: campaignId, asin, sku,
                decision_type: 'bid_adjustment', action: delivery.code.startsWith('NO_CONVERSION_') ? 'request_evidence_based_bid_reduction' : 'request_profit_guard',
                rationale: `${delivery.reason} Consequência esperada: limitar a velocidade de perda sem descartar aprendizado ainda válido.`,
                rule_key: delivery.code, confidence: delivery.confidence, risk: 'low', status: 'executed',
                metric_window: `last_${LOOKBACK_DAYS}_days`,
                expected_impact_pct: evidence.recommended_reduction_pct ? -Math.round(evidence.recommended_reduction_pct * 100) : null,
                intervention_state: evidence.level || 'profit_guard',
                posterior_cvr: evidence.posterior_cvr ?? null,
                posterior_cvr_low_95: evidence.posterior_cvr_low_95 ?? null,
                posterior_cvr_high_95: evidence.posterior_cvr_high_95 ?? null,
                probability_below_sustainable: evidence.probability_below_sustainable ?? null,
                raw_clicks: evidence.raw_clicks ?? agg.clicks,
                mature_clicks: evidence.mature_clicks ?? maturity.mature_clicks,
                maturity_ratio: maturity.maturity_ratio,
                same_sku_orders: agg.sameSkuOrders,
                same_sku_sales: agg.sameSkuSales,
                halo_orders: agg.haloOrders,
                halo_sales: agg.haloSales,
                attribution_confidence: agg.attributionConfidence,
                maximum_profitable_cpa: maximumProfitableSpend,
                safe_cpc: safeCpc,
                current_cpc: currentCpc,
                deterioration_level: deterioration.level,
                prior_reduction: priorReduction,
                next_review_days: delivery.code.startsWith('NO_CONVERSION_') ? 3 : 1,
                data_used: JSON.stringify({ aggregate: agg, maturity, deterioration, evidence }).slice(0, 4000),
                idempotency_key: `${SOURCE}|profit_guard|${aid}|${campaignId}|${delivery.code}|${new Date().toISOString().slice(0, 10)}`,
              });
              if (state === 'enabled' && productNegative && campaignAcos !== null && policy.break_even_acos && campaignAcos >= policy.break_even_acos) {
                await changeCampaignState(base44, aid, campaign, 'PAUSED', delivery.code, `${delivery.reason} Produto está com lucro pós-Ads negativo; campanha pausada até nova avaliação econômica.`);
                summary.paused++;
              } else {
                await updateMonitoring(base44, campaign, delivery.code, `${delivery.reason} enforceSkuProfitProtection continuará a redução controlada de bids.`, 3);
                summary.monitored++;
              }
              summary.decisions.push({ campaign_id: campaignId, asin, code: delivery.code, action: productNegative ? 'pause_or_profit_guard' : 'profit_guard' });
              continue;
            }

            if (state === 'paused' && pausedByHour && hourDecision.action !== 'pause' && delivery.code === 'HEALTHY_OR_PROTECTED') {
              await changeCampaignState(base44, aid, campaign, 'ENABLED', 'PROFIT_DAYPART_ENABLE', `Janela anterior de perda terminou; campanha voltou a um horário sem perda comprovada. Hora BRT ${currentHour}.`);
              summary.reactivated++;
              continue;
            }

            await updateMonitoring(base44, campaign, delivery.code, delivery.reason, delivery.code.includes('MONITORING') ? 3 : 24);
            summary.monitored++;
            summary.decisions.push({ campaign_id: campaignId, asin, code: delivery.code, action: 'monitor' });
          } catch (error: any) {
            summary.errors.push({ campaign_id: campaignId, asin, stage: 'campaign_decision', code: delivery.code, error: error.message, status: error.status || 0 });
          }
        }

        if (bootstrapAsins.size) {
          const bootstrap = await base44.asServiceRole.functions.invoke('runManualZeroDeliveryBootstrap', {
            amazon_account_id: aid,
            target_asins: Array.from(bootstrapAsins),
            _service_role: true,
          }).catch((error: any) => ({ data: { ok: false, error: error.message } }));
          summary.bootstrap_execution = bootstrap?.data || bootstrap || {};
        }
        await base44.asServiceRole.functions.invoke('enforceSkuProfitProtection', {
          amazon_account_id: aid,
          _service_role: true,
        }).catch((error: any) => {
          summary.errors.push({ amazon_account_id: aid, stage: 'profit_guard_followup', error: error.message });
        });
      } catch (error: any) {
        summary.errors.push({ amazon_account_id: aid, stage: 'account', error: error.message });
      }
    }

    summary.ok = summary.errors.length === 0;
    summary.policy = {
      zero_impression: 'máximo de duas recuperações controladas; depois substituição',
      zero_activity_without_report_row: 'usa apenas frescor global do relatório e snapshot persistido da campanha; não cria métricas fictícias',
      impressions_without_click: 'nunca aumentar bid; substituir após amostra mínima',
      clicks_without_sale: 'redução escalonada por posterior bayesiano, maturidade e teto econômico; pausa somente após redução anterior e atribuição completa',
      no_stock_or_inactive: 'pausa imediata e reversível',
      product_not_found: 'pausa preventiva; arquivo somente após segunda confirmação em 72h',
      structural_loss: 'todos os Ads pausados',
      profitable_products: 'dayparting usa apenas janela madura de 14 dias e pedidos same-SKU; halo permanece evidência separada',
      ai_role: 'somente revisão de casos ambíguos; ações operacionais são determinísticas',
    };
    summary.current_brt_hour = currentHour;
    summary.started_at = startedAt;
    summary.completed_at = new Date().toISOString();
    return Response.json(summary, { status: summary.ok ? 200 : 207 });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || 'Falha no governador de entrega das campanhas' }, { status: 500 });
  }
});
