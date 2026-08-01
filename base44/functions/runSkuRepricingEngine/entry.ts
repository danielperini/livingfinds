import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import {
  decideSkuRepricing,
  normalizeSku,
  roundMoney,
  type RepricingPolicyConfig,
} from '../../shared/skuRepricingPolicy.ts';

const SOURCE = 'runSkuRepricingEngine';
const LOOKBACK_DAYS = 30;
const MAX_PENDING_REPAIRS = 20;
const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504, 524]);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const nowIso = () => new Date().toISOString();
const n = (value: unknown, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const upper = (value: unknown) => String(value || '').trim().toUpperCase();
const lower = (value: unknown) => String(value || '').trim().toLowerCase();
const dateDaysAgo = (days: number) => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
const ageHours = (value: unknown) => {
  const timestamp = new Date(String(value || 0)).getTime();
  return Number.isFinite(timestamp) && timestamp > 0 ? (Date.now() - timestamp) / 3600000 : Number.POSITIVE_INFINITY;
};

const DEFAULT_POLICY: any = {
  enabled: true,
  auto_execute: true,
  strategy: 'profit_balanced',
  minimum_confidence: 0.90,
  minimum_profit_amount: 5,
  minimum_profit_percent: 8,
  floor_buffer_percent: 1,
  undercut_amount: 0.01,
  max_decrease_percent_per_cycle: 3,
  max_increase_percent_per_cycle: 5,
  max_daily_change_percent: 8,
  max_reprices_per_day: 4,
  cooldown_hours: 6,
  low_stock_days: 14,
  excess_stock_days: 90,
  target_acos: 15,
  require_validation_preview: true,
};

let tokenCache: { refresh: string; value: string; expiresAt: number } | null = null;

function apiBase(region: unknown): string {
  const value = upper(region || 'NA');
  if (value.includes('EU')) return 'https://sellingpartnerapi-eu.amazon.com';
  if (value.includes('FE')) return 'https://sellingpartnerapi-fe.amazon.com';
  return 'https://sellingpartnerapi-na.amazon.com';
}

async function spAccessToken(account: any): Promise<string> {
  const accountRefresh = String(
    account?.sp_refresh_token ||
    account?.spapi_refresh_token ||
    account?.selling_partner_refresh_token ||
    '',
  ).trim();
  const refresh = accountRefresh || Deno.env.get('AMAZON_SP_REFRESH_TOKEN') || Deno.env.get('SP_REFRESH_TOKEN') || '';
  const clientId = Deno.env.get('AMAZON_LWA_CLIENT_ID') || Deno.env.get('SP_CLIENT_ID') || '';
  const clientSecret = Deno.env.get('AMAZON_LWA_CLIENT_SECRET') || Deno.env.get('SP_CLIENT_SECRET') || '';
  if (!refresh || !clientId || !clientSecret) throw new Error('Credenciais SP-API incompletas para repricing.');
  if (tokenCache?.refresh === refresh && tokenCache.expiresAt > Date.now() + 60000) return tokenCache.value;

  const response = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refresh,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.access_token) {
    throw new Error(payload?.error_description || payload?.error || 'Falha ao renovar token SP-API.');
  }
  tokenCache = {
    refresh,
    value: payload.access_token,
    expiresAt: Date.now() + Math.max(60, n(payload.expires_in, 3600) - 120) * 1000,
  };
  return tokenCache.value;
}

function unwrap(value: any): any {
  let current = value;
  for (let index = 0; index < 4; index += 1) {
    if (current?.payload && typeof current.payload === 'object') current = current.payload;
    else break;
  }
  return current || {};
}

async function spCall(
  base44: any,
  account: any,
  accessToken: string,
  operation: string,
  method: string,
  path: string,
  payload: any = null,
  timeoutMs = 30000,
): Promise<any> {
  const response = await base44.asServiceRole.functions.invoke('amazonApiGateway', {
    amazon_account_id: account.id,
    api_family: 'SP_API_PRICING',
    operation,
    endpoint: `${apiBase(account.region)}${path}`,
    method,
    payload,
    headers: {
      'x-amz-access-token': accessToken,
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': 'LivingFinds-Repricing/1.0 (Language=TypeScript)',
    },
    queue_type: method === 'GET' ? 'READ' : 'WRITE',
    max_attempts: 5,
    timeout_ms: timeoutMs,
    skip_outside_window_delay: true,
    _service_role: true,
  }).catch((error: any) => ({ data: { ok: false, status: 0, errors: [{ code: 'SDK_ERROR', message: error?.message || String(error) }] } }));
  return response?.data || response || {};
}

async function list(entity: any, filters: Record<string, unknown>, sort = '-updated_at', limit = 5000): Promise<any[]> {
  if (!entity?.filter) return [];
  return entity.filter(filters, sort, limit).catch(() => []);
}

function listingPrice(payload: any): number {
  const body = unwrap(payload);
  const offerPrice = body?.offers?.find((row: any) => lower(row?.offerType || 'b2c') === 'b2c')?.price;
  const attrPrice = body?.attributes?.purchasable_offer?.[0]?.our_price?.[0]?.schedule?.[0]?.value_with_tax;
  return roundMoney(n(offerPrice?.amount ?? offerPrice?.Amount ?? attrPrice, 0));
}

function listingProductType(payload: any): string {
  const body = unwrap(payload);
  return String(body?.summaries?.[0]?.productType || body?.productType || 'PRODUCT').trim() || 'PRODUCT';
}

function listingIsBuyable(payload: any): boolean {
  const body = unwrap(payload);
  const statuses = body?.summaries?.flatMap((row: any) => row?.status || []) || [];
  if (!statuses.length) return true;
  return statuses.map(upper).includes('BUYABLE');
}

function issueErrors(payload: any): any[] {
  const body = unwrap(payload);
  return (body?.issues || []).filter((issue: any) => upper(issue?.severity) === 'ERROR');
}

async function getListing(base44: any, account: any, token: string, sku: string): Promise<any> {
  const sellerId = encodeURIComponent(String(account.seller_id || '').trim());
  const encodedSku = encodeURIComponent(sku);
  const marketplace = encodeURIComponent(String(account.marketplace_id || 'A2Q3Y263D00KWC'));
  return spCall(
    base44,
    account,
    token,
    'getListingsItemForRepricing',
    'GET',
    `/listings/2021-08-01/items/${sellerId}/${encodedSku}?marketplaceIds=${marketplace}&issueLocale=pt_BR&includedData=summaries,attributes,issues,offers,fulfillmentAvailability`,
  );
}

function landedPrice(offer: any): number {
  const listing = n(offer?.ListingPrice?.Amount ?? offer?.listingPrice?.amount, 0);
  const shipping = n(offer?.Shipping?.Amount ?? offer?.shipping?.amount, 0);
  const points = n(offer?.Points?.PointsMonetaryValue?.Amount ?? offer?.points?.pointsMonetaryValue?.amount, 0);
  return roundMoney(listing + shipping - points);
}

function parseListingOffers(payload: any, sellerId: string): any {
  const body = unwrap(payload);
  const offers = body?.Offers || body?.offers || [];
  const normalized = offers.map((offer: any) => ({
    sellerId: String(offer?.SellerId || offer?.sellerId || ''),
    price: landedPrice(offer),
    own: offer?.MyOffer === true || String(offer?.SellerId || offer?.sellerId || '') === sellerId,
    featured: offer?.IsBuyBoxWinner === true || offer?.isFeaturedOffer === true,
    fba: offer?.IsFulfilledByAmazon === true || upper(offer?.fulfillmentType) === 'AFN',
    prime: offer?.PrimeInformation?.IsPrime === true || offer?.primeInformation?.isPrime === true,
    feedback: n(offer?.SellerFeedbackRating?.SellerPositiveFeedbackRating ?? offer?.sellerFeedbackRating?.sellerPositiveFeedbackRating, 0),
    feedbackCount: n(offer?.SellerFeedbackRating?.FeedbackCount ?? offer?.sellerFeedbackRating?.feedbackCount, 0),
  })).filter((offer: any) => offer.price > 0);
  const own = normalized.find((offer: any) => offer.own) || null;
  const featured = normalized.find((offer: any) => offer.featured) || null;
  const competitors = normalized.filter((offer: any) => !offer.own).sort((a: any, b: any) => a.price - b.price);
  return {
    own,
    featured,
    lowestCompetitor: competitors[0] || null,
    offerCount: normalized.length,
    competitors,
  };
}

async function getListingOffers(base44: any, account: any, token: string, sku: string): Promise<any> {
  const marketplace = encodeURIComponent(String(account.marketplace_id || 'A2Q3Y263D00KWC'));
  return spCall(
    base44,
    account,
    token,
    'getListingOffersForRepricing',
    'GET',
    `/products/pricing/v0/listings/${encodeURIComponent(sku)}/offers?MarketplaceId=${marketplace}&ItemCondition=New&CustomerType=Consumer`,
  );
}

async function competitiveSummaryBatch(base44: any, account: any, token: string, asins: string[]): Promise<Map<string, any>> {
  const result = new Map<string, any>();
  for (let offset = 0; offset < asins.length; offset += 20) {
    const chunk = asins.slice(offset, offset + 20);
    const response = await spCall(
      base44,
      account,
      token,
      'getCompetitiveSummaryForRepricing',
      'POST',
      '/batches/products/pricing/2022-05-01/items/competitiveSummary',
      {
        requests: chunk.map((asin) => ({
          asin,
          marketplaceId: account.marketplace_id || 'A2Q3Y263D00KWC',
          includedData: ['featuredBuyingOptions', 'referencePrices'],
          uri: '/products/pricing/2022-05-01/items/competitiveSummary',
          method: 'GET',
        })),
      },
      45000,
    );
    if (!response.ok) continue;
    const rows = unwrap(response)?.responses || [];
    for (const row of rows) {
      const body = row?.body || {};
      const asin = upper(body?.asin || row?.request?.asin);
      if (asin) result.set(asin, body);
    }
    if (offset + 20 < asins.length) await wait(31000);
  }
  return result;
}

function parseCompetitiveSummary(body: any, sellerId: string): any {
  const featuredRows = (body?.featuredBuyingOptions || []).flatMap((option: any) => option?.segmentedFeaturedOffers || []);
  const weighted = featuredRows.map((offer: any) => ({
    sellerId: String(offer?.sellerId || ''),
    price: roundMoney(n(offer?.listingPrice?.amount, 0) + n(offer?.shippingOptions?.[0]?.price?.amount, 0) - n(offer?.points?.pointsMonetaryValue?.amount, 0)),
    fulfillmentType: String(offer?.fulfillmentType || ''),
    weight: Math.max(0, ...(offer?.featuredOfferSegments || []).map((segment: any) => n(segment?.segmentDetails?.glanceViewWeightPercentage, 0))),
    sampleLocation: offer?.featuredOfferSegments?.[0]?.segmentDetails?.sampleLocation || null,
  })).filter((offer: any) => offer.price > 0).sort((a: any, b: any) => b.weight - a.weight);
  const featured = weighted[0] || null;
  const references: Record<string, number> = {};
  for (const reference of body?.referencePrices || []) {
    references[lower(reference?.name)] = roundMoney(n(reference?.price?.amount, 0));
  }
  return {
    featured,
    ownFeatured: Boolean(featured?.sellerId && featured.sellerId === sellerId),
    competitivePrice: references.competitiveprice || references.competitivepricethreshold || null,
    wasPrice: references.wasprice || null,
    averageSellingPrice: references.averagesellingprice || null,
    retailOfferPrice: references.retailofferprice || null,
    sampleLocation: featured?.sampleLocation || null,
  };
}

async function foepBatch(base44: any, account: any, token: string, skus: Array<{ sku: string; sampleLocation?: any }>): Promise<Map<string, number>> {
  const output = new Map<string, number>();
  if (!skus.length) return output;
  const response = await spCall(
    base44,
    account,
    token,
    'getFeaturedOfferExpectedPriceForRepricing',
    'POST',
    '/batches/products/pricing/2022-05-01/offer/featuredOfferExpectedPrice',
    {
      requests: skus.slice(0, 40).map((row) => ({
        uri: '/products/pricing/2022-05-01/offer/featuredOfferExpectedPrice',
        method: 'GET',
        headers: {
          marketplaceId: account.marketplace_id || 'A2Q3Y263D00KWC',
          sku: row.sku,
        },
        ...(row.sampleLocation ? { body: JSON.stringify({ segment: { segmentDetails: { sampleLocation: row.sampleLocation } } }) } : {}),
      })),
    },
    45000,
  );
  if (!response.ok) return output;
  for (const row of unwrap(response)?.responses || []) {
    const sku = normalizeSku(row?.request?.sku || row?.request?.headers?.sku || row?.body?.offerIdentifier?.sku);
    const body = row?.body || {};
    const value = n(
      body?.featuredOfferExpectedPrice?.listingPrice?.amount ??
      body?.featuredOfferExpectedPrice?.landedPrice?.amount ??
      body?.featuredOfferExpectedPrice?.amount ??
      body?.expectedPrice?.amount,
      0,
    );
    if (sku && value > 0) output.set(sku, roundMoney(value));
  }
  return output;
}

function refPrice(summary: any, key: string): number | null {
  const value = n(summary?.[key], 0);
  return value > 0 ? value : null;
}

function policyForSku(rows: any[], sku: string): any {
  const normalized = normalizeSku(sku);
  const accountPolicy = rows.find((row: any) => !normalizeSku(row.sku) && !String(row.asin || '').trim()) || {};
  const skuPolicy = rows.find((row: any) => normalizeSku(row.sku) === normalized) || {};
  return { ...DEFAULT_POLICY, ...accountPolicy, ...skuPolicy };
}

function policyConfig(policy: any, economics: any): RepricingPolicyConfig {
  return {
    strategy: policy.strategy || 'profit_balanced',
    minimumConfidence: n(policy.minimum_confidence, 0.90),
    minimumProfitAmount: n(policy.minimum_profit_amount, 5),
    minimumProfitPercent: n(policy.minimum_profit_percent, 8),
    floorBufferPercent: n(policy.floor_buffer_percent, 1),
    minimumPrice: n(policy.minimum_price, 0) || null,
    maximumPrice: n(policy.maximum_price, 0) || null,
    undercutAmount: n(policy.undercut_amount, 0.01),
    maxDecreasePercentPerCycle: n(policy.max_decrease_percent_per_cycle, 3),
    maxIncreasePercentPerCycle: n(policy.max_increase_percent_per_cycle, 5),
    maxDailyChangePercent: n(policy.max_daily_change_percent, 8),
    lowStockDays: n(policy.low_stock_days, 14),
    excessStockDays: n(policy.excess_stock_days, 90),
    targetAcos: n(policy.target_acos, 0) || n(economics?.target_acos, 0) || 15,
  };
}

function exactEconomics(productsEconomics: any[], sku: string): any | null {
  const normalized = normalizeSku(sku);
  return productsEconomics.find((row: any) => normalizeSku(row.sku || row.normalized_sku) === normalized) || null;
}

function inventoryQuantity(product: any): number {
  return Math.max(0, n(product?.available_quantity, -1), n(product?.fba_inventory, -1), n(product?.fulfillable_quantity, -1));
}

function aggregatePerformance(
  sku: string,
  productAds: any[],
  metrics: any[],
  sales: any[],
): any {
  const normalized = normalizeSku(sku);
  const campaignIds = new Set(
    productAds
      .filter((ad: any) => normalizeSku(ad.sku) === normalized)
      .map((ad: any) => String(ad.campaign_id || ''))
      .filter(Boolean),
  );
  const ads = metrics.filter((row: any) => campaignIds.has(String(row.campaign_id || '')));
  const salesRows = sales.filter((row: any) => normalizeSku(row.sku) === normalized);
  const aggregate = (rows: any[], field: string) => rows.reduce((sum, row) => sum + n(row?.[field], 0), 0);
  const adSpend = ads.reduce((sum, row) => sum + n(row.spend ?? row.cost, 0), 0);
  const adSales = ads.reduce((sum, row) => sum + n(row.sales ?? row.attributed_sales, 0), 0);
  const adOrders = ads.reduce((sum, row) => sum + n(row.orders ?? row.purchases, 0), 0);
  const units = aggregate(salesRows, 'units_ordered');
  const revenue = salesRows.reduce((sum, row) => sum + n(row.gross_revenue || row.ordered_product_sales, 0), 0);
  return {
    adSpend: roundMoney(adSpend),
    adSales: roundMoney(adSales),
    adOrders,
    units,
    revenue: roundMoney(revenue),
    currentAcos: adSales > 0 ? roundMoney((adSpend / adSales) * 100) : null,
    daysObserved: new Set([...ads, ...salesRows].map((row: any) => row.date).filter(Boolean)).size,
    metricRows: ads.length,
    salesRows: salesRows.length,
  };
}

function freshness(account: any, product: any): any {
  return {
    inventoryFresh: ageHours(product?.synced_at || product?.last_catalog_sync_at) <= 36,
    adsFresh: ageHours(account?.ads_data_fresh_at || account?.ads_metrics_last_sync_at || account?.last_sync_at) <= 48,
    spFresh: ageHours(account?.sp_data_last_sync_at || product?.synced_at || account?.last_sync_at) <= 48,
  };
}

function changesToday(decisions: any[], sku: string): { count: number; percent: number; latest: any | null } {
  const normalized = normalizeSku(sku);
  const today = new Date().toISOString().slice(0, 10);
  const rows = decisions.filter((row: any) =>
    normalizeSku(row.sku) === normalized &&
    String(row.executed_at || row.created_at || '').slice(0, 10) === today &&
    ['executed', 'executing'].includes(lower(row.status)),
  );
  rows.sort((a: any, b: any) => new Date(b.executed_at || b.created_at || 0).getTime() - new Date(a.executed_at || a.created_at || 0).getTime());
  return {
    count: rows.length,
    percent: rows.reduce((sum: number, row: any) => sum + Math.abs(n(row.change_pct, 0)), 0),
    latest: rows[0] || null,
  };
}

function acceptedSubmission(result: any): boolean {
  if (!result?.ok) return false;
  const body = unwrap(result);
  const status = upper(body?.status || body?.submissionStatus || 'ACCEPTED');
  if (['INVALID', 'REJECTED', 'ERROR'].includes(status)) return false;
  return issueErrors(body).length === 0;
}

function pricePatch(account: any, productType: string, price: number): any {
  return {
    productType: productType || 'PRODUCT',
    patches: [{
      op: 'replace',
      path: '/attributes/purchasable_offer',
      value: [{
        marketplace_id: account.marketplace_id || 'A2Q3Y263D00KWC',
        currency: account.currency_code || 'BRL',
        our_price: [{ schedule: [{ value_with_tax: roundMoney(price) }] }],
      }],
    }],
  };
}

async function patchListingPrice(base44: any, account: any, token: string, sku: string, productType: string, price: number, preview: boolean): Promise<any> {
  const sellerId = encodeURIComponent(String(account.seller_id || '').trim());
  const marketplace = encodeURIComponent(String(account.marketplace_id || 'A2Q3Y263D00KWC'));
  const mode = preview ? '&mode=VALIDATION_PREVIEW' : '';
  return spCall(
    base44,
    account,
    token,
    preview ? 'previewSkuPriceUpdate' : 'updateSkuPrice',
    'PATCH',
    `/listings/2021-08-01/items/${sellerId}/${encodeURIComponent(sku)}?marketplaceIds=${marketplace}&issueLocale=pt_BR${mode}`,
    pricePatch(account, productType, price),
    preview ? 30000 : 45000,
  );
}

async function persistSnapshot(base44: any, payload: any): Promise<any> {
  const prior = await list(base44.asServiceRole.entities.RepricingSnapshot, {
    amazon_account_id: payload.amazon_account_id,
    snapshot_key: payload.snapshot_key,
  }, '-created_at', 1);
  if (prior.length) return prior[0];
  return base44.asServiceRole.entities.RepricingSnapshot.create(payload).catch(() => null);
}

async function persistDecision(base44: any, payload: any): Promise<any> {
  const prior = await list(base44.asServiceRole.entities.OptimizationDecision, {
    amazon_account_id: payload.amazon_account_id,
    idempotency_key: payload.idempotency_key,
  }, '-created_at', 1);
  if (prior.length) return prior[0];
  return base44.asServiceRole.entities.OptimizationDecision.create({
    entity_type: 'product',
    decision_type: 'price_change',
    requires_approval: false,
    approval_status: 'auto_approved',
    source_function: SOURCE,
    created_at: nowIso(),
    ...payload,
  });
}

async function confirmPrice(base44: any, account: any, token: string, sku: string, expected: number): Promise<{ confirmed: boolean; listing: any; price: number }> {
  let listing: any = null;
  let price = 0;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await wait(4000 * attempt);
    listing = await getListing(base44, account, token, sku);
    if (!listing?.ok) continue;
    price = listingPrice(listing);
    if (Math.abs(price - expected) <= 0.01) return { confirmed: true, listing, price };
  }
  return { confirmed: false, listing, price };
}

async function updateConfirmedLocalPrice(base44: any, product: any, economics: any, price: number, decisionId: string | null): Promise<void> {
  const now = nowIso();
  if (product?.id) {
    await base44.asServiceRole.entities.Product.update(product.id, {
      price,
      synced_at: now,
    }).catch(() => {});
  }
  if (economics?.id) {
    await base44.asServiceRole.entities.ProductEconomics.update(economics.id, {
      current_price: price,
      price_source: 'sp_api_listings_confirmed',
      price_confidence: 1,
      updated_at: now,
      last_calculated_at: now,
    }).catch(() => {});
  }
}

async function repairPending(base44: any, account: any, token: string, products: any[], economicsRows: any[]): Promise<any> {
  const rows = (await list(base44.asServiceRole.entities.OptimizationDecision, {
    amazon_account_id: account.id,
    decision_type: 'price_change',
  }, '-created_at', 200))
    .filter((row: any) => row.confirmation_status === 'pending' && lower(row.status) === 'executing')
    .slice(0, MAX_PENDING_REPAIRS);
  let confirmed = 0;
  let expired = 0;
  for (const row of rows) {
    const expected = n(row.proposed_value ?? row.value_after, 0);
    if (!row.sku || expected <= 0) continue;
    const check = await confirmPrice(base44, account, token, row.sku, expected);
    if (check.confirmed) {
      const product = products.find((item: any) => normalizeSku(item.sku) === normalizeSku(row.sku));
      const economics = exactEconomics(economicsRows, row.sku);
      await updateConfirmedLocalPrice(base44, product, economics, expected, row.id || null);
      await base44.asServiceRole.entities.OptimizationDecision.update(row.id, {
        status: 'executed',
        queue_status: 'completed',
        confirmation_status: 'confirmed',
        confirmed_at: nowIso(),
        executed_at: row.executed_at || nowIso(),
        value_after: expected,
        attempt_count: n(row.attempt_count, 0) + 1,
        last_attempt_at: nowIso(),
      }).catch(() => {});
      confirmed += 1;
    } else if (ageHours(row.created_at) > 24 || n(row.attempt_count, 0) >= 3) {
      await base44.asServiceRole.entities.OptimizationDecision.update(row.id, {
        status: 'failed',
        queue_status: 'failed',
        confirmation_status: 'divergent',
        confirmation_error: `Preço Amazon ${check.price || 'não disponível'} divergente do esperado ${expected}.`,
        attempt_count: n(row.attempt_count, 0) + 1,
        last_attempt_at: nowIso(),
      }).catch(() => {});
      expired += 1;
    } else {
      await base44.asServiceRole.entities.OptimizationDecision.update(row.id, {
        attempt_count: n(row.attempt_count, 0) + 1,
        last_attempt_at: nowIso(),
        next_retry_at: new Date(Date.now() + 30 * 60000).toISOString(),
      }).catch(() => {});
    }
  }
  return { checked: rows.length, confirmed, expired };
}

Deno.serve(async (request) => {
  const startedAt = nowIso();
  const startedMs = Date.now();
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    if (!body._service_role) {
      const authenticated = await base44.auth.isAuthenticated().catch(() => false);
      if (!authenticated) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    const accounts = body.amazon_account_id
      ? await list(base44.asServiceRole.entities.AmazonAccount, { id: body.amazon_account_id }, '-created_at', 1)
      : await list(base44.asServiceRole.entities.AmazonAccount, { status: 'connected' }, '-created_at', 10);
    if (!accounts.length) return Response.json({ ok: false, error: 'Conta Amazon conectada não encontrada.' }, { status: 404 });

    const dryRun = body.dry_run === true;
    const maxSkus = Math.max(1, Math.min(n(body.max_skus, 20), 40));
    const maxChanges = Math.max(0, Math.min(n(body.max_changes, 5), 20));
    const accountResults: any[] = [];

    for (const account of accounts) {
      if (!account.seller_id || !account.marketplace_id) {
        accountResults.push({ account_id: account.id, ok: false, error: 'seller_id ou marketplace_id ausente.' });
        continue;
      }
      const token = await spAccessToken(account);
      const cutoff = dateDaysAgo(LOOKBACK_DAYS);
      const [products, economicsRows, policies, productAds, metrics, sales, previousDecisions] = await Promise.all([
        list(base44.asServiceRole.entities.Product, { amazon_account_id: account.id }, '-updated_at', 5000),
        list(base44.asServiceRole.entities.ProductEconomics, { amazon_account_id: account.id }, '-updated_at', 5000),
        list(base44.asServiceRole.entities.RepricingPolicy, { amazon_account_id: account.id }, '-updated_at', 5000),
        list(base44.asServiceRole.entities.ProductAd, { amazon_account_id: account.id }, '-updated_at', 10000),
        list(base44.asServiceRole.entities.CampaignMetricsDaily, { amazon_account_id: account.id }, '-date', 20000),
        list(base44.asServiceRole.entities.SalesDaily, { amazon_account_id: account.id }, '-date', 20000),
        list(base44.asServiceRole.entities.OptimizationDecision, { amazon_account_id: account.id, decision_type: 'price_change' }, '-created_at', 5000),
      ]);

      const repair = await repairPending(base44, account, token, products, economicsRows);
      const metricsWindow = metrics.filter((row: any) => !row.date || row.date >= cutoff);
      const salesWindow = sales.filter((row: any) => !row.date || row.date >= cutoff);
      const productGroups = new Map<string, any[]>();
      for (const product of products) {
        const key = normalizeSku(product.sku);
        if (!key) continue;
        if (!productGroups.has(key)) productGroups.set(key, []);
        productGroups.get(key)!.push(product);
      }

      const candidates = [...productGroups.entries()]
        .map(([sku, rows]) => ({ sku, rows, product: rows[0] }))
        .filter(({ product }) =>
          product &&
          String(product.asin || '').trim() &&
          !['inactive', 'archived'].includes(lower(product.status)) &&
          product.offer_active !== false &&
          product.listing_suppressed !== true,
        )
        .sort((a, b) => ageHours(b.product?.last_catalog_sync_at || b.product?.synced_at) - ageHours(a.product?.last_catalog_sync_at || a.product?.synced_at))
        .slice(0, maxSkus);

      const uniqueAsins = [...new Set(candidates.map((row) => upper(row.product.asin)).filter(Boolean))];
      const competitiveMap = await competitiveSummaryBatch(base44, account, token, uniqueAsins);
      const summaries = new Map<string, any>();
      for (const [asin, raw] of competitiveMap.entries()) summaries.set(asin, parseCompetitiveSummary(raw, String(account.seller_id)));
      const foepMap = await foepBatch(base44, account, token, candidates.map((row) => ({
        sku: row.sku,
        sampleLocation: summaries.get(upper(row.product.asin))?.sampleLocation || undefined,
      })));

      let executed = 0;
      let held = 0;
      let blocked = 0;
      let failed = 0;
      const details: any[] = [];

      for (const candidate of candidates) {
        const { sku, rows, product } = candidate;
        const policy = policyForSku(policies, sku);
        const economics = exactEconomics(economicsRows, sku);
        const current = changesToday(previousDecisions, sku);
        const fresh = freshness(account, product);
        const stock = inventoryQuantity(product);
        const uniqueSkuMapping = rows.length === 1 && normalizeSku(product.sku) === sku;
        const performance = aggregatePerformance(sku, productAds, metricsWindow, salesWindow);
        const summary = summaries.get(upper(product.asin)) || {};

        if (policy.enabled === false) {
          details.push({ sku, action: 'blocked', reason: 'policy_disabled' });
          blocked += 1;
          continue;
        }
        if (current.count >= n(policy.max_reprices_per_day, 4)) {
          details.push({ sku, action: 'blocked', reason: 'max_reprices_per_day' });
          blocked += 1;
          continue;
        }
        if (current.latest && ageHours(current.latest.executed_at || current.latest.created_at) < n(policy.cooldown_hours, 6)) {
          details.push({ sku, action: 'hold', reason: 'cooldown_active' });
          held += 1;
          continue;
        }

        const listing = await getListing(base44, account, token, sku);
        const listingOk = listing?.ok === true;
        const apiCurrentPrice = listingOk ? listingPrice(listing) : 0;
        const currentPrice = apiCurrentPrice || n(product.price, 0) || n(economics?.current_price, 0);
        const productType = listingOk ? listingProductType(listing) : 'PRODUCT';
        const listingBuyable = listingOk && listingIsBuyable(listing);
        const offersResponse = listingOk ? await getListingOffers(base44, account, token, sku) : null;
        const offers = offersResponse?.ok ? parseListingOffers(offersResponse, String(account.seller_id)) : {};
        const econActionable = Boolean(
          economics &&
          ['complete', 'partial'].includes(lower(economics.economics_status)) &&
          (n(economics.unit_cost, 0) > 0 || n(economics.total_variable_cost_per_unit, 0) > 0) &&
          (n(economics.final_economic_confidence, 0) >= 0.65 || n(economics.final_economic_confidence, 0) >= 65 || product.cost_confirmed === true),
        );
        const competitiveFresh = Boolean(summary.featured || summary.competitivePrice || offersResponse?.ok);
        const noAnomalies = Boolean(
          currentPrice > 0 &&
          (!n(product.price, 0) || Math.abs(currentPrice - n(product.price)) / Math.max(1, currentPrice) <= 0.30) &&
          issueErrors(listing).length === 0,
        );

        const commonInput: any = {
          sku,
          asin: upper(product.asin),
          policy: policyConfig(policy, economics),
          economics: {
            currentPrice,
            unitCost: n(economics?.unit_cost || product.product_cost, 0),
            totalVariableCostPerUnit: n(economics?.total_variable_cost_per_unit, 0),
            amazonFeeAmount: n(economics?.amazon_fee_amount || product.amazon_fees, 0),
            amazonFeePercent: n(economics?.amazon_fee_percent, 0),
            breakEvenAcos: n(economics?.break_even_acos || product.break_even_acos_pct, 0),
            targetAcos: n(economics?.target_acos || policy.target_acos, 0),
            profitAfterAds: n(economics?.profit_after_ads || product.profit_after_ads, 0),
          },
          market: {
            featuredOfferPrice: offers?.featured?.price || summary?.featured?.price || null,
            featuredOfferSellerId: offers?.featured?.sellerId || summary?.featured?.sellerId || null,
            ownSellerId: String(account.seller_id),
            lowestCompetitorPrice: offers?.lowestCompetitor?.price || null,
            featuredOfferExpectedPrice: foepMap.get(sku) || null,
            competitivePrice: refPrice(summary, 'competitivePrice'),
            wasPrice: refPrice(summary, 'wasPrice'),
            averageSellingPrice: refPrice(summary, 'averageSellingPrice'),
            retailOfferPrice: refPrice(summary, 'retailOfferPrice'),
          },
          performance,
          inventory: {
            availableQuantity: stock,
            daysOfSupply: product.days_of_supply ?? product.stock_days ?? null,
            signalQuality: product.inventory_signal_quality || 'insufficient_history',
          },
          confidenceSignals: {
            uniqueSkuMapping,
            listingFresh: listingOk && listingBuyable,
            economicsActionable: econActionable,
            inventoryFresh: fresh.inventoryFresh,
            salesAndAdsFresh: fresh.adsFresh && fresh.spFresh && (performance.metricRows > 0 || performance.salesRows > 0),
            competitiveSummaryFresh: competitiveFresh,
            foepAvailable: foepMap.has(sku),
            validationPreviewAccepted: true,
            noAnomalies,
          },
          changesTodayPercent: current.percent,
        };

        const preliminary = decideSkuRepricing(commonInput);
        const snapshotKey = `${account.id}|${sku}|${new Date().toISOString().slice(0, 13)}`;
        const baseSnapshot: any = {
          amazon_account_id: account.id,
          marketplace_id: account.marketplace_id,
          seller_id: account.seller_id,
          sku,
          asin: upper(product.asin),
          product_id: product.id,
          snapshot_key: snapshotKey,
          current_price: currentPrice,
          economic_floor: preliminary.economicFloor,
          price_ceiling: preliminary.priceCeiling,
          proposed_price: preliminary.proposedPrice,
          featured_offer_price: commonInput.market.featuredOfferPrice,
          featured_offer_seller_id: commonInput.market.featuredOfferSellerId,
          featured_offer_expected_price: commonInput.market.featuredOfferExpectedPrice,
          lowest_competitor_price: commonInput.market.lowestCompetitorPrice,
          competitive_price: commonInput.market.competitivePrice,
          was_price: commonInput.market.wasPrice,
          stock_qty: stock,
          stock_coverage_days: commonInput.inventory.daysOfSupply,
          ad_spend: performance.adSpend,
          ad_sales: performance.adSales,
          ad_orders: performance.adOrders,
          current_acos: preliminary.currentAcos,
          target_acos: preliminary.targetAcos,
          projected_acos: preliminary.projectedAcos,
          projected_profit_per_unit: preliminary.projectedProfitPerUnit,
          confidence: preliminary.confidence,
          action: preliminary.action,
          blockers: preliminary.blockers,
          reasons: preliminary.reasons,
          data_fresh: listingOk && fresh.inventoryFresh && fresh.adsFresh && fresh.spFresh && competitiveFresh,
          source: 'amazon_sp_api',
          evaluated_at: nowIso(),
          created_at: nowIso(),
        };

        if (preliminary.action === 'blocked') {
          await persistSnapshot(base44, baseSnapshot);
          details.push({ sku, action: 'blocked', blockers: preliminary.blockers, confidence: preliminary.confidence });
          blocked += 1;
          continue;
        }
        if (preliminary.action === 'hold') {
          await persistSnapshot(base44, baseSnapshot);
          details.push({ sku, action: 'hold', reasons: preliminary.reasons, confidence: preliminary.confidence });
          held += 1;
          continue;
        }
        if (executed >= maxChanges) {
          await persistSnapshot(base44, { ...baseSnapshot, action: 'hold', reasons: [...preliminary.reasons, 'run_change_limit_reached'] });
          details.push({ sku, action: 'hold', reason: 'run_change_limit_reached' });
          held += 1;
          continue;
        }

        let previewAccepted = !policy.require_validation_preview;
        let previewResult: any = null;
        if (policy.require_validation_preview) {
          previewResult = await patchListingPrice(base44, account, token, sku, productType, preliminary.proposedPrice, true);
          previewAccepted = acceptedSubmission(previewResult);
        }
        const finalDecision = decideSkuRepricing({
          ...commonInput,
          confidenceSignals: { ...commonInput.confidenceSignals, validationPreviewAccepted: previewAccepted },
        });
        await persistSnapshot(base44, {
          ...baseSnapshot,
          proposed_price: finalDecision.proposedPrice,
          confidence: finalDecision.confidence,
          action: finalDecision.action,
          blockers: finalDecision.blockers,
          reasons: finalDecision.reasons,
          validation_preview_status: previewAccepted ? 'accepted' : 'rejected',
          validation_preview_response: JSON.stringify(previewResult || {}).slice(0, 4000),
        });

        if (finalDecision.action === 'blocked') {
          details.push({ sku, action: 'blocked', blockers: finalDecision.blockers, confidence: finalDecision.confidence });
          blocked += 1;
          continue;
        }
        if (dryRun || policy.auto_execute === false) {
          details.push({ sku, action: finalDecision.action, proposed_price: finalDecision.proposedPrice, dry_run: true, confidence: finalDecision.confidence });
          held += 1;
          continue;
        }

        const idempotencyKey = `${SOURCE}|${account.id}|${sku}|${currentPrice.toFixed(2)}|${finalDecision.proposedPrice.toFixed(2)}|${new Date().toISOString().slice(0, 13)}`;
        const prior = await list(base44.asServiceRole.entities.OptimizationDecision, {
          amazon_account_id: account.id,
          idempotency_key: idempotencyKey,
        }, '-created_at', 1);
        if (prior.length) {
          details.push({ sku, action: 'hold', reason: 'duplicate_idempotency_key' });
          held += 1;
          continue;
        }

        const changePct = currentPrice > 0 ? roundMoney(((finalDecision.proposedPrice - currentPrice) / currentPrice) * 100) : 0;
        const decision = await persistDecision(base44, {
          amazon_account_id: account.id,
          marketplace_id: account.marketplace_id,
          entity_id: product.id,
          asin: upper(product.asin),
          sku,
          action: finalDecision.action === 'increase' ? 'increase_price' : 'decrease_price',
          rationale: finalDecision.reasons.join('|'),
          rule_key: 'SKU_REPRICING_PROFIT_ACOS_V1',
          current_value: currentPrice,
          proposed_value: finalDecision.proposedPrice,
          value_before: currentPrice,
          change_pct: changePct,
          confidence: Math.round(finalDecision.confidence * 100),
          decision_confidence_level: finalDecision.confidence >= 0.9 ? 'high' : finalDecision.confidence >= 0.75 ? 'medium' : 'low',
          risk: Math.abs(changePct) <= 5 ? 'low' : 'medium',
          status: 'executing',
          queue_status: 'processing',
          execution_mode: 'EXECUTE_NOW',
          execution_channel: 'amazon_sp_api_listings_items',
          confirmation_required: true,
          confirmation_status: 'pending',
          target_acos: finalDecision.targetAcos,
          current_acos: finalDecision.currentAcos,
          profit_after_ads_total: n(economics?.profit_after_ads, 0),
          stock_qty: stock,
          stock_coverage_days: commonInput.inventory.daysOfSupply,
          data_scope_validated: true,
          data_scope_status: 'VALID',
          metric_window: `${cutoff}:${new Date().toISOString().slice(0, 10)}`,
          data_used: JSON.stringify({
            product_type: productType,
            economic_floor: finalDecision.economicFloor,
            price_ceiling: finalDecision.priceCeiling,
            projected_acos: finalDecision.projectedAcos,
            projected_profit_per_unit: finalDecision.projectedProfitPerUnit,
            market: commonInput.market,
            performance,
            inventory: commonInput.inventory,
          }).slice(0, 12000),
          precondition_snapshot: JSON.stringify({ current_price: currentPrice, sku, asin: upper(product.asin), listing_buyable: listingBuyable }).slice(0, 4000),
          idempotency_key: idempotencyKey,
          evaluated_at: nowIso(),
          attempt_count: 1,
          last_attempt_at: nowIso(),
        });

        const amazon = await patchListingPrice(base44, account, token, sku, productType, finalDecision.proposedPrice, false);
        const status = n(amazon?.status, amazon?.ok ? 200 : 0);
        const accepted = acceptedSubmission(amazon);
        const transient = TRANSIENT_STATUSES.has(status) || amazon?.retryable === true;
        if (!accepted && status !== 409) {
          await base44.asServiceRole.entities.OptimizationDecision.update(decision.id, {
            status: transient ? 'executing' : 'failed',
            queue_status: transient ? 'pending' : 'failed',
            confirmation_status: 'pending',
            amazon_response: JSON.stringify(amazon).slice(0, 4000),
            amazon_response_code: status,
            amazon_request_id: amazon?.request_id || null,
            execution_error: String(amazon?.errors?.[0]?.message || amazon?.error || 'Amazon não aceitou a alteração.').slice(0, 1000),
            next_retry_at: transient ? new Date(Date.now() + 30 * 60000).toISOString() : null,
          }).catch(() => {});
          details.push({ sku, action: 'failed', status, retryable: transient });
          failed += 1;
          continue;
        }

        const confirmation = await confirmPrice(base44, account, token, sku, finalDecision.proposedPrice);
        if (confirmation.confirmed) {
          await updateConfirmedLocalPrice(base44, product, economics, finalDecision.proposedPrice, decision.id || null);
          await base44.asServiceRole.entities.OptimizationDecision.update(decision.id, {
            status: 'executed',
            queue_status: 'completed',
            confirmation_status: 'confirmed',
            confirmed_at: nowIso(),
            executed_at: nowIso(),
            value_after: finalDecision.proposedPrice,
            amazon_response: JSON.stringify(amazon).slice(0, 4000),
            amazon_response_code: status || 200,
            amazon_request_id: amazon?.request_id || null,
          }).catch(() => {});
          details.push({ sku, action: finalDecision.action, old_price: currentPrice, new_price: finalDecision.proposedPrice, confidence: finalDecision.confidence, confirmed: true });
          executed += 1;
        } else {
          await base44.asServiceRole.entities.OptimizationDecision.update(decision.id, {
            status: 'executing',
            queue_status: 'pending',
            confirmation_status: 'pending',
            confirmation_error: `Amazon ainda não refletiu o preço ${finalDecision.proposedPrice}; último valor lido ${confirmation.price || 'indisponível'}.`,
            amazon_response: JSON.stringify(amazon).slice(0, 4000),
            amazon_response_code: status || 200,
            amazon_request_id: amazon?.request_id || null,
            next_retry_at: new Date(Date.now() + 30 * 60000).toISOString(),
          }).catch(() => {});
          details.push({ sku, action: finalDecision.action, pending_confirmation: true, expected_price: finalDecision.proposedPrice });
          executed += 1;
        }
      }

      const completedAt = nowIso();
      await base44.asServiceRole.entities.SyncExecutionLog.create({
        amazon_account_id: account.id,
        operation: 'sku_repricing_engine',
        status: failed > 0 ? 'partial' : 'success',
        trigger_type: body.trigger_type || 'scheduler',
        started_at: startedAt,
        completed_at: completedAt,
        records_processed: candidates.length,
        result_summary: JSON.stringify({ evaluated: candidates.length, executed, held, blocked, failed, repair }).slice(0, 4000),
        error_message: failed ? `${failed} alterações não foram concluídas.` : null,
      }).catch(() => {});

      accountResults.push({
        account_id: account.id,
        ok: failed === 0,
        evaluated: candidates.length,
        executed,
        held,
        blocked,
        failed,
        repair,
        details,
      });
    }

    return Response.json({
      ok: accountResults.every((row) => row.ok !== false),
      source: SOURCE,
      dry_run: dryRun,
      duration_ms: Date.now() - startedMs,
      accounts: accountResults,
    });
  } catch (error: any) {
    return Response.json({
      ok: false,
      source: SOURCE,
      error: error?.message || 'Falha no motor de repricing por SKU.',
      duration_ms: Date.now() - startedMs,
    }, { status: 500 });
  }
});
