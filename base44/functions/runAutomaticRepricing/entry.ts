/**
 * Motor único de repricing.
 *
 * Operações aceitas:
 * - evaluate: consulta dados reais, calcula e registra recomendações.
 * - full_evaluation: evaluate + atualização obrigatória de tarifas.
 * - process_queue: publica/reconcilia a fila idempotente de preço.
 * - reconcile: confirma preços submetidos consultando a Amazon.
 * - apply_suggested: reavalia um SKU e enfileira a sugestão aprovada pelo usuário.
 * - save_settings: valida e persiste a configuração global.
 */
import { createClientFromRequest } from "npm:@base44/sdk@0.8.40";
import { secrets } from "base44:runtime";
import {
  decideRepricing,
  economicsAtPrice,
  estimateObservedElasticity,
  normalizeSku,
  resolveMargins,
  validateRepricingEconomics,
} from "../../shared/repricingPolicy.ts";

const DEFAULTS = {
  default_minimum_margin_pct: 15,
  default_target_margin_pct: 20,
  normal_max_change_pct: 3,
  daily_max_change_pct: 10,
  minimum_effective_change_pct: 1,
  cooldown_hours: 6,
  learning_window_hours: 72,
  minimum_confidence: 75,
  automation_mode: "recommendation_only",
  max_changes_per_cycle: 20,
  competition_max_age_minutes: 30,
  fees_max_age_hours: 24,
  enabled: true,
};
const MAX_QUEUE_ATTEMPTS = 5;
const CURRENCY_BY_MARKETPLACE: Record<string, string> = {
  A2Q3Y263D00KWC: "BRL",
  ATVPDKIKX0DER: "USD",
};

const nowIso = () => new Date().toISOString();
const finite = (value: unknown): value is number =>
  value !== null && value !== undefined && value !== "" &&
  Number.isFinite(Number(value));
const numberValue = (value: unknown, fallback = 0) =>
  finite(value) ? Number(value) : fallback;
const roundMoney = (value: number) =>
  Math.round((value + Number.EPSILON) * 100) / 100;
const hoursSince = (value: unknown) => {
  if (!value) return Number.POSITIVE_INFINITY;
  const time = new Date(String(value)).getTime();
  return Number.isFinite(time)
    ? (Date.now() - time) / 3600000
    : Number.POSITIVE_INFINITY;
};
const unwrap = (value: any) => value?.data || value || {};

function spBase(region: unknown) {
  const normalized = String(region || "NA").toUpperCase();
  if (normalized.includes("EU")) {
    return "https://sellingpartnerapi-eu.amazon.com";
  }
  if (normalized.includes("FE")) {
    return "https://sellingpartnerapi-fe.amazon.com";
  }
  return "https://sellingpartnerapi-na.amazon.com";
}

async function getSpAccessToken() {
  const refreshToken = secrets.get("AMAZON_SP_REFRESH_TOKEN") ||
    secrets.get("SP_REFRESH_TOKEN");
  const clientId = secrets.get("AMAZON_LWA_CLIENT_ID") ||
    secrets.get("SP_CLIENT_ID");
  const clientSecret = secrets.get("AMAZON_LWA_CLIENT_SECRET") ||
    secrets.get("SP_CLIENT_SECRET");
  if (!refreshToken || !clientId || !clientSecret) {
    throw Object.assign(
      new Error(
        "Repricing bloqueado: autorização OAuth SP-API não configurada.",
      ),
      { status: 401 },
    );
  }
  const response = await fetch("https://api.amazon.com/auth/o2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
    signal: AbortSignal.timeout(15000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) {
    throw Object.assign(
      new Error(
        payload.error_description || payload.error ||
          `OAuth SP-API HTTP ${response.status}`,
      ),
      { status: response.status },
    );
  }
  return String(payload.access_token);
}

async function amazonCall(
  base44: any,
  accountId: string,
  operation: string,
  endpoint: string,
  accessToken: string,
  method = "GET",
  payload: any = null,
) {
  const response = await base44.asServiceRole.functions.invoke(
    "amazonApiGatewayCore",
    {
      amazon_account_id: accountId,
      api_family: "SP_API_REPRICING",
      operation,
      endpoint,
      method,
      headers: {
        "x-amz-access-token": accessToken,
        "Content-Type": "application/json",
        Accept: "application/json",
        "user-agent": "LivingFinds-Repricing/1.0 (Language=TypeScript)",
      },
      payload,
      queue_type: method === "GET" || operation.includes("pricing")
        ? "READ"
        : "WRITE",
      max_attempts: 1,
      timeout_ms: 30000,
      _service_role: true,
    },
  ).catch((error: any) => ({
    ok: false,
    status: 0,
    retryable: true,
    errors: [{
      code: "FUNCTION_ERROR",
      message: error?.message || String(error),
    }],
  }));
  return unwrap(response);
}

function amazonPayload(result: any) {
  return result?.payload?.payload || result?.payload || {};
}

function amazonError(result: any) {
  const errors = result?.errors || result?.payload?.errors || [];
  return String(
    errors?.[0]?.message || result?.error ||
      `Amazon HTTP ${result?.status || 0}`,
  ).slice(0, 1000);
}

function listingPrice(listing: any): number | null {
  const candidates = [
    listing?.offers?.[0]?.price?.listingPrice?.amount,
    listing?.offers?.[0]?.price?.amount,
    listing?.attributes?.purchasable_offer?.[0]?.our_price?.[0]?.schedule?.[0]
      ?.value_with_tax,
  ];
  const found = candidates.find((value) => finite(value) && Number(value) > 0);
  return found === undefined ? null : roundMoney(Number(found));
}

function listingSignals(listing: any) {
  const summaries = Array.isArray(listing?.summaries) ? listing.summaries : [];
  const summary = summaries[0] || {};
  const states = summaries.flatMap((item: any) =>
    Array.isArray(item?.status) ? item.status : [item?.status]
  ).map((status: any) => String(status || "").toUpperCase()).filter(Boolean);
  const issues = Array.isArray(listing?.issues) ? listing.issues : [];
  const blockingIssues = issues.filter((issue: any) =>
    String(issue?.severity || "").toUpperCase() === "ERROR"
  );
  const suppressed = issues.some((issue: any) => {
    const actions = [
      ...(Array.isArray(issue?.enforcementActions)
        ? issue.enforcementActions
        : []),
      ...(Array.isArray(issue?.enforcements?.actions)
        ? issue.enforcements.actions.map((item: any) => item?.action)
        : []),
    ].filter(Boolean).join("|").toUpperCase();
    return actions.includes("LISTING_SUPPRESSED") ||
      actions.includes("SEARCH_SUPPRESSED");
  });
  const offerActive = states.some((state: string) =>
    ["ACTIVE", "BUYABLE", "DISCOVERABLE"].includes(state)
  );
  const productType = listing?.productTypes?.[0]?.productType ||
    listing?.productTypes?.[0]?.productTypeName ||
    summary?.productType ||
    summary?.itemClassification ||
    listing?.productType ||
    "";
  const fulfillment = String(
    listing?.offers?.[0]?.fulfillmentType ||
      listing?.fulfillmentAvailability?.[0]?.fulfillmentChannelCode ||
      listing?.fulfillmentAvailability?.[0]?.fulfillment_channel_code ||
      "",
  ).toUpperCase();
  const sellerFulfillmentType =
    fulfillment.includes("AMAZON") || fulfillment === "AFN"
      ? "AFN"
      : fulfillment
      ? "MFN"
      : "";
  return {
    currentPrice: listingPrice(listing),
    productType,
    sellerFulfillmentType,
    offerActive,
    suppressed,
    buyable: offerActive && !suppressed && blockingIssues.length === 0,
    issues,
    blockingIssues,
  };
}

async function fetchListing(
  base44: any,
  account: any,
  accessToken: string,
  sku: string,
) {
  const endpoint = spBase(account.region);
  const sellerId = account.seller_id || secrets.get("AMAZON_SELLER_ID") || "";
  const marketplaceId = account.marketplace_id ||
    secrets.get("AMAZON_MARKETPLACE_ID") || "";
  if (!sellerId) {
    return {
      ok: false,
      status: 400,
      error: "Repricing bloqueado: Seller ID ausente.",
    };
  }
  if (!marketplaceId) {
    return {
      ok: false,
      status: 400,
      error: "Repricing bloqueado: Marketplace ID ausente.",
    };
  }
  const url = `${endpoint}/listings/2021-08-01/items/${
    encodeURIComponent(sellerId)
  }/${encodeURIComponent(sku)}?marketplaceIds=${
    encodeURIComponent(marketplaceId)
  }&includedData=summaries,attributes,issues,offers,fulfillmentAvailability,productTypes`;
  const result = await amazonCall(
    base44,
    account.id,
    "repricing_get_listing",
    url,
    accessToken,
  );
  if (!result.ok) {
    return {
      ok: false,
      status: result.status,
      error: amazonError(result),
      amazon: result,
    };
  }
  return { ok: true, listing: amazonPayload(result), amazon: result };
}

function totalOfferPrice(offer: any) {
  const listing = numberValue(offer?.listingPrice?.amount, 0);
  const shipping = numberValue(
    offer?.shippingOptions?.[0]?.price?.amount ?? offer?.shippingPrice?.amount,
    0,
  );
  return listing > 0 ? roundMoney(listing + shipping) : null;
}

function parseCompetitiveBody(body: any) {
  const offers: any[] = [];
  let featuredOfferPrice: number | null = null;
  for (const option of body?.featuredBuyingOptions || []) {
    for (const offer of option?.segmentedFeaturedOffers || []) {
      const total = totalOfferPrice(offer);
      if (total && featuredOfferPrice === null) featuredOfferPrice = total;
      if (total) {
        offers.push({
          totalPrice: total,
          listingPrice: numberValue(offer?.listingPrice?.amount, 0),
          shippingPrice: numberValue(
            offer?.shippingOptions?.[0]?.price?.amount,
            0,
          ),
          condition: offer?.condition || option?.buyingOptionType || "New",
          fulfillmentType: offer?.fulfillmentType || "",
          sellerId: offer?.sellerId || "",
          available: true,
          deliveryEquivalent: null,
          isFeatured: true,
        });
      }
    }
  }
  for (const group of body?.lowestPricedOffers || []) {
    for (const offer of group?.offers || []) {
      const total = totalOfferPrice(offer);
      if (!total) continue;
      offers.push({
        totalPrice: total,
        listingPrice: numberValue(offer?.listingPrice?.amount, 0),
        shippingPrice: numberValue(
          offer?.shippingOptions?.[0]?.price?.amount,
          0,
        ),
        condition: group?.lowestPricedOffersInput?.itemCondition ||
          offer?.subCondition || "New",
        fulfillmentType: offer?.fulfillmentType || "",
        sellerId: offer?.sellerId || "",
        available: true,
        deliveryEquivalent: null,
        isFeatured: false,
      });
    }
  }
  return { offers, featuredOfferPrice };
}

function parseFoepBody(body: any) {
  const results = Array.isArray(body?.featuredOfferExpectedPriceResults)
    ? body.featuredOfferExpectedPriceResults
    : [];
  const valid = results.find((result: any) =>
    result?.resultStatus === "VALID_FOEP" &&
    finite(result?.featuredOfferExpectedPrice?.listingPrice?.amount)
  );
  const expected = valid
    ? roundMoney(Number(valid.featuredOfferExpectedPrice.listingPrice.amount))
    : null;
  const featured = valid?.currentFeaturedOffer?.price
    ? totalOfferPrice({
      listingPrice: valid.currentFeaturedOffer.price.listingPrice,
      shippingOptions: [{
        price: valid.currentFeaturedOffer.price.shippingPrice,
      }],
    })
    : null;
  return { expected, featured };
}

async function fetchPricingBatches(
  base44: any,
  account: any,
  accessToken: string,
  targets: Array<{ asin: string; sku: string }>,
) {
  const bySku = new Map<string, any>();
  const endpoint = spBase(account.region);
  const marketplaceId = account.marketplace_id ||
    secrets.get("AMAZON_MARKETPLACE_ID") || "";
  for (let offset = 0; offset < targets.length; offset += 20) {
    const batch = targets.slice(offset, offset + 20);
    const competitiveRequest = {
      requests: batch.map((target) => ({
        asin: target.asin,
        marketplaceId,
        includedData: [
          "featuredBuyingOptions",
          "lowestPricedOffers",
          "referencePrices",
        ],
        lowestPricedOffersInputs: [{
          itemCondition: "New",
          offerType: "Consumer",
        }],
        method: "GET",
        uri: "/products/pricing/2022-05-01/items/competitiveSummary",
      })),
    };
    const foepRequest = {
      requests: batch.map((target) => ({
        marketplaceId,
        sku: target.sku,
        method: "GET",
        uri: "/products/pricing/2022-05-01/offer/featuredOfferExpectedPrice",
      })),
    };
    const [competitive, foep] = await Promise.all([
      amazonCall(
        base44,
        account.id,
        "repricing_pricing_competitive_summary",
        `${endpoint}/batches/products/pricing/2022-05-01/items/competitiveSummary`,
        accessToken,
        "POST",
        competitiveRequest,
      ),
      amazonCall(
        base44,
        account.id,
        "repricing_pricing_foep",
        `${endpoint}/batches/products/pricing/2022-05-01/offer/featuredOfferExpectedPrice`,
        accessToken,
        "POST",
        foepRequest,
      ),
    ]);
    const competitiveResponses = amazonPayload(competitive)?.responses || [];
    const foepResponses = amazonPayload(foep)?.responses || [];
    batch.forEach((target, index) => {
      const competitiveResponse = competitiveResponses[index] || {};
      const foepResponse = foepResponses.find((response: any) =>
        normalizeSku(response?.request?.sku) === normalizeSku(target.sku)
      ) || foepResponses[index] || {};
      const competitiveParsed = parseCompetitiveBody(
        competitiveResponse?.body || {},
      );
      const foepParsed = parseFoepBody(foepResponse?.body || {});
      bySku.set(normalizeSku(target.sku), {
        ok: competitive.ok === true &&
          Number(competitiveResponse?.status?.statusCode || 200) < 400,
        offers: competitiveParsed.offers,
        featuredOfferPrice: foepParsed.featured ||
          competitiveParsed.featuredOfferPrice,
        featuredOfferExpectedPrice: foepParsed.expected,
        checkedAt: nowIso(),
        errors: [amazonError(competitive), amazonError(foep)].filter((
          message,
        ) =>
          !message.includes("HTTP 200")
        ),
      });
    });
  }
  return bySku;
}

function parseFees(payload: any, price: number) {
  const root = payload?.payload || payload;
  const result = root?.FeesEstimateResult || root?.feesEstimateResult || root;
  const estimate = result?.FeesEstimate || result?.feesEstimate || {};
  const details = estimate?.FeeDetailList || estimate?.feeDetailList || [];
  const total = numberValue(
    estimate?.TotalFeesEstimate?.Amount ?? estimate?.totalFeesEstimate?.amount,
    0,
  );
  let referral = 0;
  let fba = 0;
  let fixed = 0;
  for (const detail of details) {
    const type = String(detail?.FeeType || detail?.feeType || "").toLowerCase();
    const amount = numberValue(
      detail?.FinalFee?.Amount ?? detail?.finalFee?.amount ??
        detail?.FeeAmount?.Amount ?? detail?.feeAmount?.amount,
      0,
    );
    if (type.includes("referral")) referral += amount;
    else if (
      type.includes("fba") || type.includes("fulfillment") ||
      type.includes("pickandpack")
    ) fba += amount;
    else fixed += amount;
  }
  if (fixed <= 0 && total > 0) fixed = Math.max(0, total - referral - fba);
  if (total <= 0 || price <= 0 || referral < 0 || fba < 0 || fixed < 0) {
    return null;
  }
  return {
    referralFeePct: referral > 0 ? roundMoney(referral / price * 100) : null,
    referralFeeAmount: roundMoney(referral),
    fbaFee: roundMoney(fba),
    fixedFee: roundMoney(fixed),
    totalFee: roundMoney(total),
    details,
  };
}

async function fetchFees(
  base44: any,
  account: any,
  accessToken: string,
  sku: string,
  price: number,
  isFba: boolean,
  currency: string,
) {
  const marketplaceId = account.marketplace_id ||
    secrets.get("AMAZON_MARKETPLACE_ID") || "";
  const endpoint = `${spBase(account.region)}/products/fees/v0/listings/${
    encodeURIComponent(sku)
  }/feesEstimate`;
  const request = {
    FeesEstimateRequest: {
      MarketplaceId: marketplaceId,
      IsAmazonFulfilled: isFba,
      PriceToEstimateFees: {
        ListingPrice: { CurrencyCode: currency, Amount: price },
      },
      Identifier: `repricing:${normalizeSku(sku)}:${
        price.toFixed(2)
      }:${Date.now()}`,
    },
  };
  const result = await amazonCall(
    base44,
    account.id,
    "repricing_product_fees",
    endpoint,
    accessToken,
    "POST",
    request,
  );
  if (!result.ok) {
    return {
      ok: false,
      status: result.status,
      error: amazonError(result),
      request,
      amazon: result,
    };
  }
  const fees = parseFees(amazonPayload(result), price);
  return fees ? { ok: true, fees, request, amazon: result } : {
    ok: false,
    status: 422,
    error: "A Amazon não retornou uma estimativa de tarifas utilizável.",
    request,
    amazon: result,
  };
}

function groupSales(rows: any[]) {
  const byProduct = new Map<string, any>();
  for (const row of rows) {
    for (
      const key of [String(row.asin || "").toUpperCase(), normalizeSku(row.sku)]
        .filter(Boolean)
    ) {
      const current = byProduct.get(key) ||
        { units: 0, sales: 0, sessions: 0, days: new Set<string>() };
      current.units += numberValue(row.units_ordered);
      current.sales += numberValue(
        row.ordered_product_sales || row.gross_revenue,
      );
      current.sessions += numberValue(row.sessions);
      if (row.date) current.days.add(String(row.date));
      byProduct.set(key, current);
    }
  }
  return byProduct;
}

function groupAds(rows: any[]) {
  const byProduct = new Map<string, any>();
  for (const row of rows) {
    if (
      row.data_status !== "complete" ||
      numberValue(row.confidence, 0) < 0.7
    ) continue;
    for (
      const key of [String(row.asin || "").toUpperCase(), normalizeSku(row.sku)]
        .filter(Boolean)
    ) {
      const current = byProduct.get(key) ||
        { spend: 0, orders: 0, clicks: 0, impressions: 0, latest: null };
      current.spend += numberValue(row.spend);
      current.orders += numberValue(row.orders_ads);
      current.clicks += numberValue(row.clicks);
      current.impressions += numberValue(row.impressions);
      if (
        !current.latest ||
        String(row.assessment_date || "") >
          String(current.latest.assessment_date || "")
      ) current.latest = row;
      byProduct.set(key, current);
    }
  }
  return byProduct;
}

function productMetric<T>(map: Map<string, T>, product: any): T | null {
  return map.get(String(product.asin || "").toUpperCase()) ||
    map.get(normalizeSku(product.sku)) || null;
}

function realAdsCost(ads: any, economics: any) {
  if (ads && ads.orders >= 2 && ads.spend >= 0) {
    return {
      value: roundMoney(ads.spend / ads.orders),
      source: "daily_product_ads_assessment_30d",
      verifiedAt: nowIso(),
    };
  }
  if (
    finite(economics?.estimated_ads_cost_per_order) &&
    economics?.ads_cost_verified_at &&
    economics?.ads_cost_source &&
    economics.ads_cost_source !== "missing" &&
    hoursSince(economics.ads_cost_verified_at) <= 24 * 30
  ) {
    return {
      value: Number(economics.estimated_ads_cost_per_order),
      source: economics.ads_cost_source,
      verifiedAt: economics.ads_cost_verified_at,
    };
  }
  return { value: null, source: "missing", verifiedAt: null };
}

function settingsValues(record: any) {
  return { ...DEFAULTS, ...(record || {}) };
}

async function loadSettings(base44: any, accountId: string) {
  const rows = await base44.asServiceRole.entities.RepricingSettings.filter(
    { amazon_account_id: accountId },
    "-updated_at",
    1,
  ).catch(() => []);
  return settingsValues(rows[0]);
}

function policyInputs(economics: any, adsCost: any, settings: any) {
  const margins = resolveMargins(
    economics.minimum_margin_pct ?? settings.default_minimum_margin_pct,
    economics.target_margin_pct ?? settings.default_target_margin_pct,
  );
  return {
    unitProductCost: finite(economics.unit_cost)
      ? Number(economics.unit_cost)
      : null,
    inboundFreight: numberValue(economics.inbound_freight_per_unit),
    packagingCost: numberValue(economics.packaging_cost_per_unit),
    additionalTax: numberValue(economics.tax_per_unit),
    otherCost: numberValue(economics.logistics_cost_per_unit) +
      numberValue(economics.other_variable_cost_per_unit),
    fbaFee: finite(economics.fba_fee) ? Number(economics.fba_fee) : null,
    fixedAmazonFee: finite(economics.amazon_fixed_fee)
      ? Number(economics.amazon_fixed_fee)
      : null,
    estimatedReturnCost: numberValue(economics.estimated_return_cost),
    adsCostPerOrder: finite(adsCost.value) ? Number(adsCost.value) : null,
    referralFeePct: finite(economics.amazon_fee_percent)
      ? Number(economics.amazon_fee_percent)
      : null,
    costsConfirmed: economics.costs_confirmed_by_user === true,
    feesConfirmed: Boolean(
      economics.fees_verified_at &&
        String(economics.fees_source || "").startsWith("sp_api"),
    ),
    adsCostConfirmed: finite(adsCost.value) && adsCost.source !== "missing",
    minimumMarginPct: margins.minimumMarginPct,
    targetMarginPct: margins.targetMarginPct,
    manualMinPrice: economics.manual_min_price,
    manualMaxPrice: economics.manual_max_price,
  };
}

function recentPriceChangePct(history: any[]) {
  const cutoff = Date.now() - 24 * 3600000;
  return history
    .filter((row) =>
      row.history_type === "price_confirmed" &&
      new Date(row.changed_at || 0).getTime() >= cutoff &&
      finite(row.price_before) && Number(row.price_before) > 0 &&
      finite(row.price_after)
    )
    .reduce(
      (sum, row) =>
        sum +
        Math.abs(
          (Number(row.price_after) - Number(row.price_before)) /
            Number(row.price_before) * 100,
        ),
      0,
    );
}

async function cancelPendingPriceActions(
  base44: any,
  accountId: string,
  sku: string,
  reason: string,
) {
  const actions = await base44.asServiceRole.entities.AmazonActionQueue.filter(
    { amazon_account_id: accountId, entity_type: "product_price", sku },
    "-created_at",
    100,
  ).catch(() => []);
  for (
    const action of actions.filter((item: any) =>
      ["pending", "submitted", "processing"].includes(String(item.status || ""))
    )
  ) {
    await base44.asServiceRole.entities.AmazonActionQueue.update(action.id, {
      status: "cancelled",
      last_error: reason,
      completed_at: nowIso(),
      updated_at: nowIso(),
    }).catch(() => {});
  }
}

async function queuePriceAction(base44: any, params: any) {
  const oldPrice = Number(params.oldPrice);
  const newPrice = Number(params.newPrice);
  const profitableFloor = Number(params.decision?.minimumProfitablePrice);
  if (
    !Number.isFinite(oldPrice) || oldPrice <= 0 ||
    !Number.isFinite(newPrice) || newPrice <= 0 ||
    !Number.isFinite(profitableFloor) || profitableFloor <= 0 ||
    newPrice + 0.001 < profitableFloor
  ) {
    return { created: false, action: null, blocked: true };
  }
  const day = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
  const baseKey = `repricing:${params.sellerId}:${params.marketplaceId}:${
    normalizeSku(params.product?.sku)
  }:${day}`;
  const sameSkuActions = await base44.asServiceRole.entities.AmazonActionQueue
    .filter(
      {
        amazon_account_id: params.accountId,
        entity_type: "product_price",
        sku: params.product.sku,
      },
      "-created_at",
      50,
    ).catch(() => []);
  const concurrent = sameSkuActions.find((action: any) =>
    ["pending", "submitted", "processing"].includes(
      String(action.status || ""),
    )
  );
  if (concurrent) return { created: false, action: concurrent };
  const automaticAlreadyHandledToday = !params.manual && sameSkuActions.find(
    (action: any) =>
      (String(action.idempotency_key || "").endsWith(`:${day}`) ||
        (action.created_at &&
          new Date(new Date(action.created_at).getTime() - 3 * 3600000)
              .toISOString().slice(0, 10) === day)) &&
      ["pending", "submitted", "processing", "confirmed"].includes(
        String(action.status || ""),
      ),
  );
  if (automaticAlreadyHandledToday) {
    return { created: false, action: automaticAlreadyHandledToday };
  }
  const existing = await base44.asServiceRole.entities.AmazonActionQueue.filter(
    {
      amazon_account_id: params.accountId,
      entity_type: "product_price",
      idempotency_key: baseKey,
    },
    "-created_at",
    20,
  ).catch(() => []);
  const active = existing.find((action: any) =>
    ["pending", "submitted", "processing", "confirmed"].includes(
      String(action.status || ""),
    ) && hoursSince(action.created_at) < 24
  );
  if (active) return { created: false, action: active };

  const history = await base44.asServiceRole.entities.ProductEconomicsHistory
    .create({
      amazon_account_id: params.accountId,
      product_id: params.product.id,
      asin: params.product.asin,
      sku: params.product.sku,
      normalized_sku: normalizeSku(params.product.sku),
      history_type: "price_submission",
      price_before: params.oldPrice,
      price_after: params.newPrice,
      minimum_profitable_price: params.decision.minimumProfitablePrice,
      target_margin_price: params.decision.targetMarginPrice,
      margin_before: params.decision.currentEconomics?.marginPct,
      margin_after: params.decision.projectedEconomics?.marginPct,
      unit_profit_before: params.decision.currentEconomics?.unitProfit,
      unit_profit_after: params.decision.projectedEconomics?.unitProfit,
      expected_daily_profit: params.decision.expectedDailyProfit,
      sales_before: params.metrics.sales,
      units_before: params.metrics.units,
      conversion_before: params.metrics.conversionRate,
      ads_cost_before: params.adsCost.value,
      stock_before: params.stock,
      featured_offer_before: params.pricing.featuredOfferPrice,
      decision_reason: params.decision.decisionReason,
      decision_evidence: params.evidence,
      source: params.manual ? "manual_suggested_price" : "automatic_repricing",
      reason: params.decision.decisionReason,
      changed_by: params.changedBy,
      changed_at: nowIso(),
      status: "pending",
      next_evaluation_at: new Date(Date.now() + 5 * 60000).toISOString(),
    });
  const action = await base44.asServiceRole.entities.AmazonActionQueue.create({
    amazon_account_id: params.accountId,
    operation: "update_listing_price",
    entity_type: "product_price",
    entity_id: params.product.id,
    sku: params.product.sku,
    asin: params.product.asin,
    marketplace_id: params.marketplaceId,
    seller_id: params.sellerId,
    old_price: params.oldPrice,
    new_price: params.newPrice,
    reason: params.decision.decisionReason,
    expected_margin: params.decision.projectedEconomics?.marginPct,
    expected_unit_profit: params.decision.projectedEconomics?.unitProfit,
    expected_daily_profit: params.decision.expectedDailyProfit,
    payload: {
      product_type: params.productType,
      currency: params.currency,
      manual_apply: params.manual === true,
      minimum_profitable_price: params.decision.minimumProfitablePrice,
      target_margin_price: params.decision.targetMarginPrice,
      evidence: params.evidence,
    },
    idempotency_key: baseKey,
    priority: params.decision.emergencyMarginRecovery
      ? "critical"
      : params.manual
      ? "high"
      : "normal",
    status: "pending",
    attempt_count: 0,
    max_attempts: MAX_QUEUE_ATTEMPTS,
    next_retry_at: nowIso(),
    history_id: history?.id || null,
    source: params.manual ? "manual_suggested_price" : "automatic_repricing",
    confidence: Math.round(numberValue(params.decision.confidence) * 100),
    created_at: nowIso(),
    updated_at: nowIso(),
  });
  if (history?.id && action?.id) {
    await base44.asServiceRole.entities.ProductEconomicsHistory.update(
      history.id,
      { action_queue_id: action.id },
    ).catch(() => {});
  }
  return { created: true, action };
}

async function evaluateAccount(
  base44: any,
  account: any,
  accessToken: string,
  options: any,
) {
  const settings = await loadSettings(base44, account.id);
  const cutoff = new Date(Date.now() - 30 * 86400000).toISOString().slice(
    0,
    10,
  );
  const [products, economicsRows, salesRows, adsRows, historyRows] =
    await Promise.all([
      base44.asServiceRole.entities.Product.filter(
        { amazon_account_id: account.id },
        "-last_sync_at",
        5000,
      ).catch(() => []),
      base44.asServiceRole.entities.ProductEconomics.filter(
        { amazon_account_id: account.id },
        "-updated_at",
        5000,
      ).catch(() => []),
      base44.asServiceRole.entities.SalesDaily.filter(
        { amazon_account_id: account.id },
        "-date",
        5000,
      ).catch(() => []),
      base44.asServiceRole.entities.DailyProductAdsAssessment.filter(
        { amazon_account_id: account.id },
        "-assessment_date",
        5000,
      ).catch(() => []),
      base44.asServiceRole.entities.ProductEconomicsHistory.filter(
        { amazon_account_id: account.id },
        "-changed_at",
        5000,
      ).catch(() => []),
    ]);
  const salesMap = groupSales(
    salesRows.filter((row: any) => !row.date || row.date >= cutoff),
  );
  const adsMap = groupAds(
    adsRows.filter((row: any) =>
      !row.assessment_date || row.assessment_date >= cutoff
    ),
  );
  const latestEconomicsBySku = new Map<string, any>();
  for (const economics of economicsRows) {
    const key = normalizeSku(economics.sku);
    if (key && !latestEconomicsBySku.has(key)) {
      latestEconomicsBySku.set(key, economics);
    }
  }
  let eligible = products.filter((product: any) => {
    if (product.status === "archived" || !product.sku || !product.asin) {
      return false;
    }
    if (options.product_id && product.id !== options.product_id) return false;
    const economics = latestEconomicsBySku.get(normalizeSku(product.sku));
    return Boolean(economics?.costs_confirmed_by_user || options.product_id);
  });
  eligible = eligible
    .sort((a: any, b: any) => {
      const ae = latestEconomicsBySku.get(normalizeSku(a.sku));
      const be = latestEconomicsBySku.get(normalizeSku(b.sku));
      return new Date(ae?.next_evaluation_at || 0).getTime() -
        new Date(be?.next_evaluation_at || 0).getTime();
    })
    .slice(
      0,
      Math.max(1, Math.min(numberValue(options.max_products, 50), 200)),
    );

  const listingBySku = new Map<string, any>();
  const pricingTargets: Array<{ asin: string; sku: string }> = [];
  for (const product of eligible) {
    const listingResult = await fetchListing(
      base44,
      account,
      accessToken,
      product.sku,
    );
    listingBySku.set(normalizeSku(product.sku), listingResult);
    if (listingResult.ok) {
      pricingTargets.push({ asin: product.asin, sku: product.sku });
    }
  }
  const pricingBySku = await fetchPricingBatches(
    base44,
    account,
    accessToken,
    pricingTargets,
  );
  const results: any[] = [];
  let queued = 0;

  for (const product of eligible) {
    const key = normalizeSku(product.sku);
    const economics = latestEconomicsBySku.get(key);
    if (!economics) {
      results.push({
        sku: product.sku,
        status: "blocked",
        reason: "Repricing bloqueado: custo do produto não informado.",
      });
      continue;
    }
    const stock = numberValue(
      product.available_quantity ?? product.fba_inventory,
      0,
    );
    if (stock <= 0) {
      await cancelPendingPriceActions(
        base44,
        account.id,
        product.sku,
        "Produto sem estoque; ação de preço cancelada.",
      );
      await base44.asServiceRole.entities.ProductEconomics.update(
        economics.id,
        {
          repricing_status: "blocked",
          repricing_block_reason: "Repricing bloqueado: produto sem estoque.",
          next_evaluation_at: new Date(Date.now() + 6 * 3600000).toISOString(),
          updated_at: nowIso(),
        },
      ).catch(() => {});
      results.push({
        sku: product.sku,
        status: "blocked",
        reason: "Repricing bloqueado: produto sem estoque.",
      });
      continue;
    }

    const listingResult = listingBySku.get(key);
    if (!listingResult?.ok) {
      const auth = [401, 403].includes(Number(listingResult?.status));
      const reason = auth
        ? "Repricing bloqueado: token inválido ou permissão Product Listing/Pricing ausente."
        : `Repricing bloqueado: falha ao consultar listing real (${
          listingResult?.error || "erro Amazon"
        }).`;
      await base44.asServiceRole.entities.ProductEconomics.update(
        economics.id,
        {
          repricing_status: "blocked",
          repricing_block_reason: reason,
          updated_at: nowIso(),
        },
      ).catch(() => {});
      results.push({ sku: product.sku, status: "blocked", reason });
      continue;
    }
    const listing = listingSignals(listingResult.listing);
    const currentPrice = listing.currentPrice;
    const requirements: string[] = [];
    if (product.status !== "active") {
      requirements.push("Repricing bloqueado: produto inativo.");
    }
    if (!listing.offerActive) {
      requirements.push("Repricing bloqueado: oferta inativa na Amazon.");
    }
    if (!listing.buyable) {
      requirements.push(
        "Repricing bloqueado: listing não comprável ou com issue de erro.",
      );
    }
    if (!listing.productType) {
      requirements.push("Repricing bloqueado: Product Type ausente.");
    }
    if (!currentPrice) {
      requirements.push(
        "Repricing bloqueado: preço atual não retornado pela Amazon.",
      );
    }
    if (requirements.length) {
      const reason = requirements.join(" ");
      await base44.asServiceRole.entities.ProductEconomics.update(
        economics.id,
        {
          repricing_status: "blocked",
          repricing_block_reason: reason,
          product_type: listing.productType || null,
          updated_at: nowIso(),
        },
      ).catch(() => {});
      results.push({ sku: product.sku, status: "blocked", reason });
      continue;
    }
    const confirmedPrice = Number(currentPrice);

    const pricing = pricingBySku.get(key) || {
      ok: false,
      offers: economics.competitor_offers || [],
      featuredOfferPrice: economics.featured_offer_price,
      featuredOfferExpectedPrice: economics.featured_offer_expected_price,
      checkedAt: economics.competition_checked_at,
    };
    const sellerId = account.seller_id ||
      secrets.get("AMAZON_SELLER_ID") || "";
    const competitorOffers = (pricing.offers || []).filter((offer: any) =>
      !sellerId || !offer.sellerId ||
      String(offer.sellerId) !== String(sellerId)
    );
    const competitionFresh = pricing.ok === true ||
      (economics.competition_checked_at &&
        hoursSince(economics.competition_checked_at) * 60 <=
          numberValue(settings.competition_max_age_minutes, 30));
    const currency = account.currency_code ||
      CURRENCY_BY_MARKETPLACE[account.marketplace_id] || "BRL";
    let feesPatch: any = {};
    const refreshFees = options.full === true || !economics.fees_verified_at ||
      hoursSince(economics.fees_verified_at) >
        numberValue(settings.fees_max_age_hours, 24);
    if (refreshFees) {
      const feeResult = await fetchFees(
        base44,
        account,
        accessToken,
        product.sku,
        confirmedPrice,
        listing.sellerFulfillmentType === "AFN",
        currency,
      );
      if (feeResult.ok && feeResult.fees) {
        feesPatch = {
          amazon_fee_percent: feeResult.fees.referralFeePct,
          amazon_fee_amount: feeResult.fees.totalFee,
          fba_fee: feeResult.fees.fbaFee,
          amazon_fixed_fee: feeResult.fees.fixedFee,
          fees_source: "sp_api_product_fees",
          fees_verified_at: nowIso(),
          fees_confidence: 0.95,
        };
      } else {
        feesPatch = {
          fees_source: `sp_api_error_${feeResult.status}`,
          repricing_block_reason:
            `Repricing bloqueado: tarifas Amazon indisponíveis (${feeResult.error}).`,
        };
      }
    }
    const mergedEconomics = {
      ...economics,
      ...feesPatch,
      current_price: confirmedPrice,
      price_source: "sp_api_listings_items",
    };
    const ads = productMetric(adsMap, product);
    const adsCost = realAdsCost(ads, mergedEconomics);
    const sales = productMetric(salesMap, product) ||
      {
        units: numberValue(product.total_units_30d),
        sales: numberValue(product.total_sales_30d),
        sessions: numberValue(product.sessions_30d),
        days: new Set(),
      };
    const dailyUnits = numberValue(sales.units) / 30;
    const conversionRate = numberValue(sales.sessions) > 0
      ? numberValue(sales.units) / numberValue(sales.sessions)
      : numberValue(product.conversion_rate_30d);
    const productHistory = historyRows.filter((row: any) =>
      normalizeSku(row.sku) === key
    );
    const learningHours = numberValue(settings.learning_window_hours, 72);
    for (
      const history of productHistory.filter((row: any) =>
        row.history_type === "price_confirmed" &&
        row.decision_evidence?.observation_completed !== true &&
        hoursSince(row.changed_at) >= learningHours
      )
    ) {
      const observationStart = String(history.changed_at || "").slice(0, 10);
      const observedRows = salesRows.filter((row: any) =>
        String(row.date || "") >= observationStart &&
        (normalizeSku(row.sku) === key ||
          String(row.asin || "").toUpperCase() ===
            String(product.asin || "").toUpperCase())
      );
      const observationDays = new Set(
        observedRows.map((row: any) => String(row.date || "")).filter(Boolean),
      ).size;
      if (observationDays < Math.ceil(learningHours / 24)) continue;
      const observedUnits = observedRows.reduce(
        (sum: number, row: any) => sum + numberValue(row.units_ordered),
        0,
      );
      const observedSales = observedRows.reduce(
        (sum: number, row: any) =>
          sum + numberValue(row.ordered_product_sales || row.gross_revenue),
        0,
      );
      const observedSessions = observedRows.reduce(
        (sum: number, row: any) => sum + numberValue(row.sessions),
        0,
      );
      const maturedEvidence = {
        ...(history.decision_evidence || {}),
        observation_completed: true,
        observation_days: observationDays,
        observation_completed_at: nowIso(),
        observation_source: "SalesDaily_SP_API",
      };
      await base44.asServiceRole.entities.ProductEconomicsHistory.update(
        history.id,
        {
          units_after: observedUnits,
          sales_after: observedSales,
          conversion_after: observedSessions > 0
            ? observedUnits / observedSessions
            : null,
          decision_evidence: maturedEvidence,
          next_evaluation_at: null,
        },
      ).catch(() => {});
      Object.assign(history, {
        units_after: observedUnits,
        sales_after: observedSales,
        conversion_after: observedSessions > 0
          ? observedUnits / observedSessions
          : null,
        decision_evidence: maturedEvidence,
      });
    }
    const elasticity = estimateObservedElasticity(
      productHistory
        .filter((row: any) =>
          row.history_type === "price_confirmed" && finite(row.price_after) &&
          row.decision_evidence?.observation_completed === true &&
          finite(row.units_after) && numberValue(row.units_after) > 0
        )
        .map((row: any) => ({
          price: Number(row.price_after),
          dailyUnits: Number(row.units_after) /
            Math.max(
              1,
              numberValue(row.decision_evidence?.observation_days, 1),
            ),
        })),
    );
    const policy = policyInputs(mergedEconomics, adsCost, settings);
    const validation = validateRepricingEconomics(policy);
    const dataConfidence = [
      confirmedPrice ? 1 : 0,
      validation.complete ? 1 : 0,
      competitionFresh ? 1 : 0,
      listing.buyable ? 1 : 0,
      numberValue(sales.sessions) > 0 || numberValue(sales.units) > 0
        ? 0.9
        : 0.5,
    ].reduce((sum, value) => sum + value, 0) / 5;
    const decision = decideRepricing({
      economics: policy,
      currentPrice: confirmedPrice,
      featuredOfferPrice: pricing.featuredOfferPrice,
      featuredOfferExpectedPrice: pricing.featuredOfferExpectedPrice,
      competitorOffers,
      competitionFresh,
      sellerFulfillmentType: listing.sellerFulfillmentType,
      dailyUnits,
      sessions: numberValue(sales.sessions),
      conversionRate,
      stock,
      daysOfSupply: product.days_of_supply,
      elasticity: elasticity.elasticity,
      elasticityConfidence: elasticity.confidence,
      dataConfidence,
      lastPriceChangeAt: economics.last_price_change_at,
      absoluteChangeLast24hPct: recentPriceChangePct(productHistory),
      guardrails: {
        normalMaxChangePct: numberValue(settings.normal_max_change_pct, 3),
        dailyMaxChangePct: numberValue(settings.daily_max_change_pct, 10),
        minimumEffectiveChangePct: numberValue(
          settings.minimum_effective_change_pct,
          1,
        ),
        cooldownHours: numberValue(settings.cooldown_hours, 6),
        minimumConfidence: numberValue(settings.minimum_confidence, 75) / 100,
      },
    });
    const economicConflict = Boolean(
      decision.currentEconomics && decision.currentEconomics.marginPct < 15,
    );
    const requestedEnabled = economics.repricing_requested === true ||
      economics.repricing_enabled === true;
    const executionEnabled = requestedEnabled && validation.complete;
    const status = !executionEnabled
      ? decision.blocked ? "blocked" : "recommendation"
      : decision.blockReasons?.length
      ? "blocked"
      : decision.automaticEligible
      ? "eligible"
      : "recommendation";
    const blockReason = [
      ...(decision.blockReasons || []),
      ...(decision.blocked ? decision.blockReasons || [] : []),
    ].filter(Boolean).filter((value, index, array) =>
      array.indexOf(value) === index
    ).join(" ");
    const evidence = {
      source: "amazon_sp_api_and_persisted_real_metrics",
      current_price_source: "Listings Items API 2021-08-01",
      competition_source: "Product Pricing API 2022-05-01",
      fees_source: mergedEconomics.fees_source,
      ads_cost_source: adsCost.source,
      current_price: confirmedPrice,
      featured_offer_price: pricing.featuredOfferPrice,
      featured_offer_expected_price: pricing.featuredOfferExpectedPrice,
      competitor_offers: competitorOffers.length,
      stock,
      sales_30d: numberValue(sales.sales),
      units_30d: numberValue(sales.units),
      sessions_30d: numberValue(sales.sessions),
      ads_spend_30d: numberValue(ads?.spend),
      ads_orders_30d: numberValue(ads?.orders),
      ads_clicks_30d: numberValue(ads?.clicks),
      ads_impressions_30d: numberValue(ads?.impressions),
      ads_cpc_30d: numberValue(ads?.clicks) > 0
        ? roundMoney(numberValue(ads?.spend) / numberValue(ads?.clicks))
        : null,
      ads_cvr_30d: numberValue(ads?.clicks) > 0
        ? numberValue(ads?.orders) / numberValue(ads?.clicks)
        : null,
      elasticity,
      candidates: decision.candidates,
      guardrails: settings,
      listing_issues: listing.issues,
    };
    const update: any = {
      ...feesPatch,
      marketplace_id: account.marketplace_id,
      product_id: product.id,
      asin: product.asin,
      normalized_sku: key,
      current_price: confirmedPrice,
      last_observed_amazon_price: confirmedPrice,
      price_source: "sp_api_listings_items",
      price_confidence: 1,
      product_type: listing.productType,
      currency_code: currency,
      seller_fulfillment_type: listing.sellerFulfillmentType,
      estimated_ads_cost_per_order: adsCost.value,
      ads_cost_source: adsCost.source,
      ads_cost_verified_at: adsCost.verifiedAt,
      ad_spend_per_order_14d: adsCost.value,
      minimum_margin_pct: policy.minimumMarginPct,
      target_margin_pct: policy.targetMarginPct,
      minimum_profitable_price: decision.minimumProfitablePrice,
      target_margin_price: decision.targetMarginPrice,
      suggested_price: decision.suggestedPrice,
      current_margin_pct: decision.currentEconomics?.marginPct,
      projected_margin_pct: decision.projectedEconomics?.marginPct,
      projected_unit_profit: decision.projectedEconomics?.unitProfit,
      expected_daily_units: decision.expectedDailyUnits,
      expected_daily_profit: decision.expectedDailyProfit,
      economic_data_complete: validation.complete &&
        Boolean(decision.currentEconomics),
      economic_data_updated_at: nowIso(),
      economics_status: validation.complete
        ? "complete"
        : validation.reasons.some((reason) => reason.includes("Tarifas"))
        ? "missing_fees"
        : validation.reasons.some((reason) => reason.includes("Custo"))
        ? "missing_cost"
        : "partial",
      repricing_requested: requestedEnabled,
      repricing_enabled: executionEnabled,
      repricing_status: status,
      repricing_block_reason: blockReason ||
        (decision.blocked ? decision.decisionReason : null),
      featured_offer_price: pricing.featuredOfferPrice,
      featured_offer_expected_price: pricing.featuredOfferExpectedPrice,
      competitor_median_price: decision.competitorMedian,
      competitor_offer_count: decision.equivalentOfferCount || 0,
      competitor_offers: competitorOffers,
      competition_checked_at: pricing.ok
        ? pricing.checkedAt
        : economics.competition_checked_at,
      competition_source: pricing.ok
        ? "sp_api_product_pricing_2022_05_01"
        : economics.competition_source,
      elasticity: elasticity.elasticity,
      elasticity_confidence: elasticity.confidence,
      elasticity_observations: elasticity.observations,
      final_economic_confidence: decision.confidence,
      contribution_margin_amount: decision.currentEconomics
        ? roundMoney(
          decision.currentEconomics.unitProfit + numberValue(adsCost.value),
        )
        : null,
      contribution_margin_percent: decision.currentEconomics
        ? roundMoney(
          (decision.currentEconomics.unitProfit + numberValue(adsCost.value)) /
            confirmedPrice * 100,
        )
        : null,
      profit_before_ads: decision.currentEconomics
        ? roundMoney(
          decision.currentEconomics.unitProfit + numberValue(adsCost.value),
        )
        : null,
      profit_after_ads: decision.currentEconomics?.unitProfit,
      profit_after_ads_percent: decision.currentEconomics?.marginPct,
      economic_conflict: economicConflict,
      profit_protection_mode: economicConflict
        ? "defensive"
        : economics.profit_protection_mode === "paused"
        ? "vigilant"
        : "normal",
      profit_protection_reason: economicConflict
        ? "Margem líquida real inferior a 15%; aumentos de Ads bloqueados."
        : null,
      decision_reason: decision.decisionReason,
      decision_evidence: evidence,
      last_repricing_decision_at: nowIso(),
      next_evaluation_at: economics.last_price_change_at &&
          hoursSince(economics.last_price_change_at) < learningHours
        ? new Date(
          new Date(economics.last_price_change_at).getTime() +
            learningHours * 3600000,
        ).toISOString()
        : new Date(Date.now() + 15 * 60000).toISOString(),
      updated_at: nowIso(),
    };
    await base44.asServiceRole.entities.ProductEconomics.update(
      economics.id,
      update,
    ).catch(() => {});
    await base44.asServiceRole.entities.Product.update(product.id, {
      listing_buyable: listing.buyable,
      offer_active: listing.offerActive,
      listing_suppressed: listing.suppressed,
      price: confirmedPrice,
      market_price_median: decision.competitorMedian,
      market_price_offer_count: decision.equivalentOfferCount || 0,
      market_price_source: "sp_api_product_pricing_2022_05_01",
      market_price_last_checked_at: pricing.checkedAt || nowIso(),
    }).catch(() => {});

    const decisionKey = `repricing_decision:${account.id}:${key}:${
      nowIso().slice(0, 13)
    }`;
    if (!historyRows.some((row: any) => row.import_batch_id === decisionKey)) {
      await base44.asServiceRole.entities.ProductEconomicsHistory.create({
        amazon_account_id: account.id,
        product_id: product.id,
        asin: product.asin,
        sku: product.sku,
        normalized_sku: key,
        history_type: decision.suggestedPrice &&
            Math.abs(decision.suggestedPrice - confirmedPrice) >= 0.01
          ? "price_recommendation"
          : "economic_evaluation",
        price_before: confirmedPrice,
        price_after: decision.suggestedPrice,
        minimum_profitable_price: decision.minimumProfitablePrice,
        target_margin_price: decision.targetMarginPrice,
        margin_before: decision.currentEconomics?.marginPct,
        margin_after: decision.projectedEconomics?.marginPct,
        unit_profit_before: decision.currentEconomics?.unitProfit,
        unit_profit_after: decision.projectedEconomics?.unitProfit,
        expected_daily_profit: decision.expectedDailyProfit,
        sales_before: numberValue(sales.sales),
        units_before: numberValue(sales.units),
        conversion_before: conversionRate,
        ads_cost_before: adsCost.value,
        stock_before: stock,
        featured_offer_before: pricing.featuredOfferPrice,
        decision_reason: decision.decisionReason,
        decision_evidence: evidence,
        source: "runAutomaticRepricing",
        reason: decision.decisionReason,
        import_batch_id: decisionKey,
        changed_by: options.changed_by || "scheduler",
        changed_at: nowIso(),
        status,
        next_evaluation_at: update.next_evaluation_at,
      }).catch(() => {});
    }

    const marketplaceId = account.marketplace_id ||
      secrets.get("AMAZON_MARKETPLACE_ID") || "";
    const manual = options.manual_apply === true;
    const canQueue = decision.suggestedPrice &&
      confirmedPrice > 0 &&
      Number(decision.suggestedPrice) > 0 &&
      Number(decision.minimumProfitablePrice) > 0 &&
      Number(decision.suggestedPrice) + 0.001 >=
        Number(decision.minimumProfitablePrice) &&
      Math.abs(decision.suggestedPrice - confirmedPrice) >= 0.01 &&
      decision.automaticEligible === true &&
      (decision.blockReasons || []).length === 0 &&
      validation.complete && listing.buyable && stock > 0 &&
      options.recommendation_only !== true &&
      (manual ||
        (settings.enabled !== false &&
          settings.automation_mode === "automatic" && executionEnabled)) &&
      queued < numberValue(settings.max_changes_per_cycle, 20);
    let queuedForProcessing = false;
    if (canQueue) {
      const queuedAction = await queuePriceAction(base44, {
        accountId: account.id,
        sellerId,
        marketplaceId,
        product,
        productType: listing.productType,
        currency,
        oldPrice: confirmedPrice,
        newPrice: decision.suggestedPrice,
        decision,
        metrics: {
          sales: numberValue(sales.sales),
          units: numberValue(sales.units),
          conversionRate,
        },
        adsCost,
        stock,
        pricing,
        evidence,
        manual,
        changedBy: options.changed_by || "scheduler",
      });
      if (queuedAction.created) queued += 1;
      queuedForProcessing = Boolean(
        queuedAction.action &&
          ["pending", "submitted", "processing"].includes(
            String(queuedAction.action.status || ""),
          ),
      );
      if (queuedForProcessing) {
        await base44.asServiceRole.entities.ProductEconomics.update(
          economics.id,
          {
            repricing_status: "pending",
            updated_at: nowIso(),
          },
        ).catch(() => {});
      }
    }
    results.push({
      sku: product.sku,
      asin: product.asin,
      status: queuedForProcessing ? "pending" : status,
      current_price: confirmedPrice,
      suggested_price: decision.suggestedPrice,
      minimum_profitable_price: decision.minimumProfitablePrice,
      target_margin_price: decision.targetMarginPrice,
      margin_current: decision.currentEconomics?.marginPct,
      margin_projected: decision.projectedEconomics?.marginPct,
      reason: decision.decisionReason,
      blockers: decision.blockReasons,
    });
  }
  return {
    account_id: account.id,
    evaluated: results.length,
    queued,
    mode: settings.automation_mode,
    results,
  };
}

function retryAt(attempt: number, retryAfterSeconds?: number | null) {
  const seconds = retryAfterSeconds && retryAfterSeconds > 0
    ? retryAfterSeconds
    : Math.min(6 * 3600, 5 * 60 * Math.pow(2, Math.max(0, attempt - 1)));
  return new Date(Date.now() + seconds * 1000).toISOString();
}

async function updateHistory(base44: any, action: any, patch: any) {
  if (action.history_id) {
    await base44.asServiceRole.entities.ProductEconomicsHistory.update(
      action.history_id,
      patch,
    ).catch(() => {});
  }
}

async function confirmPrice(
  base44: any,
  action: any,
  product: any,
  economics: any,
  observedPrice: number,
  listing: any,
) {
  const now = nowIso();
  const salesRows = await base44.asServiceRole.entities.SalesDaily.filter(
    { amazon_account_id: action.amazon_account_id, sku: action.sku },
    "-date",
    30,
  ).catch(() => []);
  const salesAfter = salesRows.reduce(
    (sum: number, row: any) =>
      sum + numberValue(row.ordered_product_sales || row.gross_revenue),
    0,
  );
  const unitsAfter = salesRows.reduce(
    (sum: number, row: any) => sum + numberValue(row.units_ordered),
    0,
  );
  const sessionsAfter = salesRows.reduce(
    (sum: number, row: any) => sum + numberValue(row.sessions),
    0,
  );
  await base44.asServiceRole.entities.AmazonActionQueue.update(action.id, {
    status: "confirmed",
    confirmed_price: observedPrice,
    confirmation_checked_at: now,
    completed_at: now,
    amazon_response: listing,
    result: JSON.stringify({
      confirmed_price: observedPrice,
      confirmation_source: "Listings Items API",
    }).slice(0, 1000),
    last_error: null,
    updated_at: now,
  });
  if (product?.id) {
    await base44.asServiceRole.entities.Product.update(product.id, {
      price: observedPrice,
      last_sync_at: now,
    }).catch(() => {});
  }
  if (economics?.id) {
    await base44.asServiceRole.entities.ProductEconomics.update(economics.id, {
      current_price: observedPrice,
      last_observed_amazon_price: observedPrice,
      price_source: "sp_api_listings_items_confirmed",
      repricing_status: "confirmed",
      repricing_block_reason: null,
      last_price_change_at: now,
      last_price_confirmed_at: now,
      updated_at: now,
    }).catch(() => {});
  }
  await updateHistory(base44, action, {
    history_type: "price_confirmed",
    status: "confirmed",
    price_after: observedPrice,
    sales_after: salesAfter,
    units_after: unitsAfter,
    conversion_after: sessionsAfter > 0 ? unitsAfter / sessionsAfter : null,
    stock_after: numberValue(
      product?.available_quantity ?? product?.fba_inventory,
    ),
    featured_offer_after: economics?.featured_offer_price,
    amazon_response: listing,
    changed_at: now,
    next_evaluation_at: new Date(Date.now() + 72 * 3600000).toISOString(),
  });
  return {
    action_id: action.id,
    sku: action.sku,
    status: "confirmed",
    price: observedPrice,
  };
}

async function failOrRetry(
  base44: any,
  action: any,
  result: any,
  permanent = false,
) {
  const attempts = numberValue(action.attempt_count) + 1;
  const exhausted =
    attempts >= numberValue(action.max_attempts, MAX_QUEUE_ATTEMPTS);
  const status = permanent ? "blocked" : exhausted ? "failed" : "pending";
  const error = amazonError(result);
  await base44.asServiceRole.entities.AmazonActionQueue.update(action.id, {
    status,
    attempt_count: attempts,
    next_retry_at: status === "pending"
      ? retryAt(attempts, result?.retry_after)
      : null,
    last_error: error,
    amazon_response: result,
    completed_at: ["blocked", "failed"].includes(status) ? nowIso() : null,
    updated_at: nowIso(),
  });
  await updateHistory(base44, action, {
    history_type: ["blocked", "failed"].includes(status)
      ? "price_failed"
      : "price_submission",
    status,
    amazon_response: result,
    reason: error,
    changed_at: nowIso(),
  });
  if (["blocked", "failed"].includes(status)) {
    const economicsRows = await base44.asServiceRole.entities.ProductEconomics
      .filter(
        { amazon_account_id: action.amazon_account_id, sku: action.sku },
        "-updated_at",
        1,
      ).catch(() => []);
    if (economicsRows[0]?.id) {
      await base44.asServiceRole.entities.ProductEconomics.update(
        economicsRows[0].id,
        {
          repricing_status: status,
          repricing_block_reason: `Repricing ${status}: ${error}`,
          updated_at: nowIso(),
        },
      ).catch(() => {});
    }
  }
  return { action_id: action.id, sku: action.sku, status, error };
}

async function processQueueForAccount(
  base44: any,
  account: any,
  accessToken: string,
  options: any,
) {
  const [allActions, products, economicsRows] = await Promise.all([
    base44.asServiceRole.entities.AmazonActionQueue.filter(
      { amazon_account_id: account.id, entity_type: "product_price" },
      "created_at",
      500,
    ).catch(() => []),
    base44.asServiceRole.entities.Product.filter(
      { amazon_account_id: account.id },
      undefined,
      5000,
    ).catch(() => []),
    base44.asServiceRole.entities.ProductEconomics.filter(
      { amazon_account_id: account.id },
      "-updated_at",
      5000,
    ).catch(() => []),
  ]);
  const due = allActions
    .filter((action: any) =>
      ["pending", "submitted", "processing"].includes(
        String(action.status || ""),
      )
    )
    .filter((action: any) =>
      !action.next_retry_at ||
      new Date(action.next_retry_at).getTime() <= Date.now()
    )
    .slice(0, Math.max(1, Math.min(numberValue(options.max_actions, 20), 100)));
  const productBySku = new Map<string, any>(
    products.map((product: any) => [normalizeSku(product.sku), product]),
  );
  const economicsBySku = new Map<string, any>();
  for (const economics of economicsRows) {
    const key = normalizeSku(economics.sku);
    if (key && !economicsBySku.has(key)) economicsBySku.set(key, economics);
  }
  const results: any[] = [];
  for (const action of due) {
    const key = normalizeSku(action.sku);
    const product = productBySku.get(key);
    const economics = economicsBySku.get(key);
    const stock = numberValue(
      product?.available_quantity ?? product?.fba_inventory,
    );
    if (!product || !economics) {
      results.push(
        await failOrRetry(base44, action, {
          status: 404,
          errors: [{ message: "Produto ou dados econômicos não encontrados." }],
        }, true),
      );
      continue;
    }
    if (stock <= 0) {
      await base44.asServiceRole.entities.AmazonActionQueue.update(action.id, {
        status: "cancelled",
        last_error: "Produto sem estoque.",
        completed_at: nowIso(),
        updated_at: nowIso(),
      });
      results.push({
        action_id: action.id,
        sku: action.sku,
        status: "cancelled",
        error: "Produto sem estoque.",
      });
      continue;
    }
    const listingResult = await fetchListing(
      base44,
      account,
      accessToken,
      action.sku,
    );
    if (!listingResult.ok) {
      results.push(
        await failOrRetry(
          base44,
          action,
          listingResult.amazon ||
            {
              status: listingResult.status,
              errors: [{ message: listingResult.error }],
            },
          [401, 403, 404].includes(Number(listingResult.status)),
        ),
      );
      continue;
    }
    const listing = listingSignals(listingResult.listing);
    if (
      listing.currentPrice &&
      Math.abs(listing.currentPrice - numberValue(action.new_price)) < 0.01
    ) {
      results.push(
        await confirmPrice(
          base44,
          action,
          product,
          economics,
          listing.currentPrice,
          listingResult.listing,
        ),
      );
      continue;
    }
    if (["submitted", "processing"].includes(String(action.status || ""))) {
      const attempts = numberValue(action.attempt_count) + 1;
      if (attempts >= numberValue(action.max_attempts, MAX_QUEUE_ATTEMPTS)) {
        results.push(
          await failOrRetry(
            base44,
            { ...action, attempt_count: attempts - 1 },
            {
              status: 504,
              errors: [{
                message:
                  "Amazon aceitou a submissão, mas o preço não foi confirmado dentro do limite de tentativas.",
              }],
            },
          ),
        );
      } else {
        await base44.asServiceRole.entities.AmazonActionQueue.update(
          action.id,
          {
            status: "processing",
            attempt_count: attempts,
            next_retry_at: retryAt(attempts),
            confirmation_checked_at: nowIso(),
            amazon_response: listingResult.listing,
            updated_at: nowIso(),
          },
        );
        results.push({
          action_id: action.id,
          sku: action.sku,
          status: "processing",
        });
      }
      continue;
    }
    const adsCost = {
      value: economics.estimated_ads_cost_per_order,
      source: economics.ads_cost_source,
      verifiedAt: economics.ads_cost_verified_at,
    };
    const settings = await loadSettings(base44, account.id);
    const policy = policyInputs(economics, adsCost, settings);
    const validation = validateRepricingEconomics(policy);
    const requestedEconomics = economicsAtPrice(
      numberValue(action.new_price),
      policy,
    );
    if (
      !validation.complete || !requestedEconomics ||
      requestedEconomics.marginPct < 15 ||
      numberValue(action.new_price) <= 0 ||
      numberValue(validation.minimumProfitablePrice) <= 0 ||
      numberValue(action.new_price) + 0.001 <
        numberValue(validation.minimumProfitablePrice)
    ) {
      results.push(
        await failOrRetry(base44, action, {
          status: 422,
          errors: [{
            message: `Guardrail econômico bloqueou a publicação: ${
              validation.reasons.join(" ") || "margem inferior a 15%"
            }`,
          }],
        }, true),
      );
      continue;
    }
    if (!listing.buyable || !listing.productType) {
      results.push(
        await failOrRetry(base44, action, {
          status: 422,
          errors: [{
            message: "Listing inativo, não comprável ou sem Product Type.",
          }],
        }, true),
      );
      continue;
    }
    const payload = {
      productType: action.payload?.product_type || listing.productType,
      patches: [{
        op: "replace",
        path: "/attributes/purchasable_offer",
        value: [{
          audience: "ALL",
          currency: action.payload?.currency || economics.currency_code ||
            account.currency_code || "BRL",
          marketplace_id: action.marketplace_id,
          our_price: [{
            schedule: [{ value_with_tax: numberValue(action.new_price) }],
          }],
        }],
      }],
    };
    const endpoint = `${spBase(account.region)}/listings/2021-08-01/items/${
      encodeURIComponent(action.seller_id)
    }/${encodeURIComponent(action.sku)}?marketplaceIds=${
      encodeURIComponent(action.marketplace_id)
    }&issueLocale=pt_BR`;
    await base44.asServiceRole.entities.AmazonActionQueue.update(action.id, {
      status: "processing",
      started_at: nowIso(),
      amazon_request: payload,
      updated_at: nowIso(),
    });
    const amazon = await amazonCall(
      base44,
      account.id,
      "repricing_patch_listing_price",
      endpoint,
      accessToken,
      "PATCH",
      payload,
    );
    const responsePayload = amazonPayload(amazon);
    if (amazon.ok) {
      const accepted = !responsePayload?.status ||
        responsePayload.status === "ACCEPTED";
      const issues = responsePayload?.issues || [];
      if (
        !accepted ||
        issues.some((issue: any) =>
          String(issue.severity || "").toUpperCase() === "ERROR"
        )
      ) {
        results.push(
          await failOrRetry(base44, action, {
            ...amazon,
            errors: issues.length ? issues : amazon.errors,
          }, true),
        );
        continue;
      }
      await base44.asServiceRole.entities.AmazonActionQueue.update(action.id, {
        status: "submitted",
        attempt_count: numberValue(action.attempt_count) + 1,
        submission_id: responsePayload?.submissionId || null,
        amazon_request: payload,
        amazon_response: responsePayload,
        next_retry_at: new Date(Date.now() + 2 * 60000).toISOString(),
        updated_at: nowIso(),
      });
      await base44.asServiceRole.entities.ProductEconomics.update(
        economics.id,
        { repricing_status: "submitted", updated_at: nowIso() },
      ).catch(() => {});
      await updateHistory(base44, action, {
        status: "submitted",
        amazon_response: responsePayload,
        changed_at: nowIso(),
      });
      results.push({
        action_id: action.id,
        sku: action.sku,
        status: "submitted",
        submission_id: responsePayload?.submissionId || null,
      });
    } else if ([504, 524].includes(Number(amazon.status))) {
      await base44.asServiceRole.entities.AmazonActionQueue.update(action.id, {
        status: "submitted",
        attempt_count: numberValue(action.attempt_count) + 1,
        amazon_request: payload,
        amazon_response: amazon,
        next_retry_at: new Date(Date.now() + 5 * 60000).toISOString(),
        last_error:
          "Resposta assíncrona/timeout; aguardando confirmação por leitura.",
        updated_at: nowIso(),
      });
      results.push({
        action_id: action.id,
        sku: action.sku,
        status: "submitted",
        asynchronous: true,
      });
    } else if (Number(amazon.status) === 409) {
      const recheck = await fetchListing(
        base44,
        account,
        accessToken,
        action.sku,
      );
      const observed = recheck.ok
        ? listingSignals(recheck.listing).currentPrice
        : null;
      if (
        observed && Math.abs(observed - numberValue(action.new_price)) < 0.01
      ) {
        results.push(
          await confirmPrice(
            base44,
            action,
            product,
            economics,
            observed,
            recheck.listing,
          ),
        );
      } else {
        results.push(await failOrRetry(base44, action, amazon));
      }
    } else {
      results.push(
        await failOrRetry(
          base44,
          action,
          amazon,
          [400, 401, 403, 404, 413, 415, 422].includes(Number(amazon.status)),
        ),
      );
    }
  }
  return { account_id: account.id, processed: results.length, results };
}

async function saveSettings(
  base44: any,
  accountId: string,
  values: any,
  changedBy: string,
) {
  const settings = settingsValues(values);
  if (numberValue(settings.default_minimum_margin_pct) < 15) {
    throw new Error("A margem mínima padrão nunca pode ser inferior a 15%.");
  }
  if (
    numberValue(settings.default_target_margin_pct) <
      numberValue(settings.default_minimum_margin_pct)
  ) throw new Error("A margem-alvo deve ser maior ou igual à margem mínima.");
  if (numberValue(settings.minimum_effective_change_pct) < 1) {
    throw new Error("A alteração mínima efetiva deve ser de pelo menos 1%.");
  }
  if (
    numberValue(settings.normal_max_change_pct) < 1 ||
    numberValue(settings.normal_max_change_pct) > 3
  ) {
    throw new Error(
      "A alteração normal máxima por ciclo deve ficar entre 1% e 3%.",
    );
  }
  if (
    numberValue(settings.daily_max_change_pct) <
      numberValue(settings.normal_max_change_pct) ||
    numberValue(settings.daily_max_change_pct) > 10
  ) {
    throw new Error(
      "A alteração acumulada em 24 horas deve ser maior ou igual ao limite por ciclo e não pode superar 10%.",
    );
  }
  if (numberValue(settings.cooldown_hours) < 6) {
    throw new Error("O cooldown não pode ser inferior a 6 horas.");
  }
  if (numberValue(settings.learning_window_hours) < 72) {
    throw new Error(
      "A janela de aprendizado não pode ser inferior a 72 horas.",
    );
  }
  const records = await base44.asServiceRole.entities.RepricingSettings.filter(
    { amazon_account_id: accountId },
    "-updated_at",
    1,
  ).catch(() => []);
  const payload = {
    amazon_account_id: accountId,
    default_minimum_margin_pct: numberValue(
      settings.default_minimum_margin_pct,
      15,
    ),
    default_target_margin_pct: numberValue(
      settings.default_target_margin_pct,
      20,
    ),
    normal_max_change_pct: numberValue(settings.normal_max_change_pct, 3),
    daily_max_change_pct: numberValue(settings.daily_max_change_pct, 10),
    minimum_effective_change_pct: numberValue(
      settings.minimum_effective_change_pct,
      1,
    ),
    cooldown_hours: numberValue(settings.cooldown_hours, 6),
    learning_window_hours: numberValue(settings.learning_window_hours, 72),
    minimum_confidence: Math.max(
      0,
      Math.min(100, numberValue(settings.minimum_confidence, 75)),
    ),
    automation_mode: settings.automation_mode === "automatic"
      ? "automatic"
      : "recommendation_only",
    max_changes_per_cycle: Math.max(
      1,
      Math.min(100, numberValue(settings.max_changes_per_cycle, 20)),
    ),
    competition_max_age_minutes: Math.max(
      5,
      numberValue(settings.competition_max_age_minutes, 30),
    ),
    fees_max_age_hours: Math.max(
      1,
      numberValue(settings.fees_max_age_hours, 24),
    ),
    enabled: settings.enabled !== false,
    updated_by: changedBy,
    updated_at: nowIso(),
  };
  const record = records[0]
    ? await base44.asServiceRole.entities.RepricingSettings.update(
      records[0].id,
      payload,
    )
    : await base44.asServiceRole.entities.RepricingSettings.create({
      ...payload,
      created_at: nowIso(),
    });
  return record;
}

async function checkConnectionForAccount(
  base44: any,
  account: any,
  accessToken: string,
) {
  const sellerId = account.seller_id || secrets.get("AMAZON_SELLER_ID") || "";
  const marketplaceId = account.marketplace_id ||
    secrets.get("AMAZON_MARKETPLACE_ID") || "";
  const checks: any = {
    oauth: { ok: true, message: "OAuth SP-API validado." },
    seller: {
      ok: Boolean(sellerId),
      message: sellerId ? "Seller ID configurado." : "Seller ID ausente.",
    },
    marketplace: {
      ok: Boolean(marketplaceId),
      message: marketplaceId
        ? "Marketplace ID configurado."
        : "Marketplace ID ausente.",
    },
    listings: { ok: false, skipped: true, message: "Sem SKU para testar." },
    pricing: { ok: false, skipped: true, message: "Sem SKU/ASIN para testar." },
  };
  if (!sellerId || !marketplaceId) {
    return { account_id: account.id, connected: false, checks };
  }

  const products = await base44.asServiceRole.entities.Product.filter(
    { amazon_account_id: account.id },
    "-updated_date",
    100,
  ).catch(() => []);
  const sample = products.find((product: any) => product?.sku && product?.asin);
  if (!sample) {
    return {
      account_id: account.id,
      connected: true,
      limited: true,
      message: "OAuth e conta válidos; nenhum produto com SKU e ASIN para testar os endpoints.",
      checks,
    };
  }

  const listing = await fetchListing(base44, account, accessToken, sample.sku);
  checks.listings = {
    ok: listing.ok === true,
    status: listing.status || listing.amazon?.status || 200,
    sku: sample.sku,
    asin: sample.asin,
    message: listing.ok
      ? "Listings Items API acessível."
      : listing.error || "Falha ao consultar Listings Items API.",
  };
  const pricingMap = await fetchPricingBatches(base44, account, accessToken, [{
    sku: sample.sku,
    asin: sample.asin,
  }]);
  const pricing = pricingMap.get(normalizeSku(sample.sku));
  checks.pricing = {
    ok: pricing?.ok === true,
    sku: sample.sku,
    asin: sample.asin,
    message: pricing?.ok
      ? "Product Pricing API acessível."
      : pricing?.errors?.join(" ") || "Falha ao consultar Product Pricing API.",
  };
  return {
    account_id: account.id,
    connected: checks.listings.ok && checks.pricing.ok,
    checked_at: nowIso(),
    sample: { sku: sample.sku, asin: sample.asin },
    checks,
  };
}

Deno.serve(async (req) => {
  const startedAt = nowIso();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    let user: any = null;
    if (!body._service_role) {
      user = await base44.auth.me().catch(() => null);
      if (!user) {
        return Response.json({ ok: false, error: "Não autorizado" }, {
          status: 401,
        });
      }
    }
    const operation = String(body.operation || "evaluate");
    if (operation === "save_settings") {
      if (!body.amazon_account_id) {
        return Response.json({
          ok: false,
          error: "amazon_account_id obrigatório",
        }, { status: 400 });
      }
      const settings = await saveSettings(
        base44,
        body.amazon_account_id,
        body.settings || {},
        user?.email || user?.id || "service_role",
      );
      return Response.json({ ok: true, operation, settings });
    }

    const accounts = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter(
        { id: body.amazon_account_id },
        undefined,
        1,
      )
      : await base44.asServiceRole.entities.AmazonAccount.filter(
        { status: "connected" },
        undefined,
        100,
      );
    if (!accounts.length) {
      return Response.json({
        ok: true,
        skipped: true,
        reason: "Nenhuma conta Amazon conectada.",
      });
    }
    const accessToken = await getSpAccessToken();
    const results: any[] = [];
    for (const account of accounts) {
      const options = {
        ...body,
        full: operation === "full_evaluation",
        manual_apply: operation === "apply_suggested",
        product_id: body.product_id,
        changed_by: user?.email || user?.id || "scheduler",
      };
      if (["process_queue", "reconcile"].includes(operation)) {
        results.push(
          await processQueueForAccount(base44, account, accessToken, options),
        );
      } else if (operation === "connection_check") {
        results.push(
          await checkConnectionForAccount(base44, account, accessToken),
        );
      } else if (
        ["evaluate", "full_evaluation", "apply_suggested"].includes(operation)
      ) {
        if (operation === "apply_suggested" && !body.product_id) {
          return Response.json({
            ok: false,
            error: "product_id obrigatório para aplicar preço sugerido.",
          }, { status: 400 });
        }
        results.push(
          await evaluateAccount(base44, account, accessToken, options),
        );
      } else {
        return Response.json({
          ok: false,
          error: `Operação de repricing desconhecida: ${operation}`,
        }, { status: 400 });
      }
    }
    const completedAt = nowIso();
    for (const result of results) {
      await base44.asServiceRole.entities.SyncExecutionLog.create({
        amazon_account_id: result.account_id,
        operation: `runAutomaticRepricing:${operation}`,
        status: operation === "connection_check" && result.connected !== true
          ? "warning"
          : "success",
        trigger_type: body._service_role ? "automatic" : "manual",
        started_at: startedAt,
        completed_at: completedAt,
        records_processed: result.evaluated || result.processed || 0,
        result_summary: JSON.stringify({
          operation,
          evaluated: result.evaluated,
          processed: result.processed,
          queued: result.queued,
          mode: result.mode,
        }).slice(0, 4000),
      }).catch(() => {});
    }
    return Response.json({
      ok: true,
      operation,
      started_at: startedAt,
      completed_at: completedAt,
      results,
    });
  } catch (error: any) {
    const message = String(error?.message || "Falha no motor de repricing")
      .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "[REDACTED]");
    return Response.json({
      ok: false,
      error: message,
      started_at: startedAt,
      completed_at: nowIso(),
    }, {
      status: [400, 401, 403].includes(Number(error?.status))
        ? Number(error.status)
        : 500,
    });
  }
});
