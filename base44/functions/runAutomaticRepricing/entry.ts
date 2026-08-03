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
  commercialPrice90AtOrAbove,
  economicsAtPrice,
  estimateObservedElasticity,
  normalizeSku,
  resolveMargins,
  validateRepricingEconomics,
} from "../../shared/repricingPolicy.ts";
import {
  AUTOMATIC_REPRICING_RUNTIME_FLAG,
  actionBlocksAutomaticDay,
  actionMatchesSku,
  dayKeyInTimeZone,
  isAutomaticRepricingRuntimeEnabled,
  isConcurrentPriceAction,
  listingExecutionBlockReasons,
  pricesMatch,
} from "../../shared/repricingSafety.ts";
import {
  resolveSellerId,
  selectSpApiSamples,
  sellerIdFromAdsProfiles,
  sellerIdFromParticipations,
} from "../../shared/spApiIdentity.ts";
import { competitorMetricScope } from "../../shared/competitorDataPolicy.ts";
import {
  applyGuardedPriceChange,
  deterministicPriceConfidence,
  priceChangeUsedInWindow,
} from "../../shared/guardedPriceChangePolicy.ts";
import { listingOfferStatus } from "../../shared/listingOfferStatus.ts";

const DEFAULTS = {
  default_minimum_margin_pct: 15,
  default_target_margin_pct: 20,
  normal_max_change_pct: 3,
  daily_max_change_pct: 10,
  minimum_effective_change_pct: 1,
  repricing_rollout_mode: "guarded",
  maximum_price_change_amount_24h: 2,
  minimum_price_change_amount: 0.05,
  minimum_automatic_confidence: 96,
  price_change_window_hours: 24,
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
const averagePositive = (values: unknown[]) => {
  const valid = values.map(Number).filter((value) =>
    Number.isFinite(value) && value > 0
  );
  return valid.length
    ? roundMoney(valid.reduce((sum, value) => sum + value, 0) / valid.length)
    : null;
};
const hoursSince = (value: unknown) => {
  if (!value) return Number.POSITIVE_INFINITY;
  const time = new Date(String(value)).getTime();
  return Number.isFinite(time)
    ? (Date.now() - time) / 3600000
    : Number.POSITIVE_INFINITY;
};

const comparableTokens = (value: unknown) => new Set(
  String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/)
    .filter((token) => token.length > 2),
);

function titleSimilarity(left: unknown, right: unknown) {
  const a = comparableTokens(left);
  const b = comparableTokens(right);
  if (!a.size || !b.size) return 0;
  const intersection = [...a].filter((token) => b.has(token)).length;
  return intersection / Math.max(a.size, b.size);
}

function genericProductSimilarity(left: unknown, right: unknown) {
  const a = comparableTokens(left);
  const b = comparableTokens(right);
  if (!a.size || !b.size) return 0;
  const shared = [...a].filter((token) => b.has(token)).length;
  if (shared < 2) return 0;
  const coverage = shared / Math.max(1, Math.min(a.size, b.size));
  return Math.min(0.99, 0.82 + Math.min(0.12, shared * 0.05) + Math.min(0.05, coverage * 0.05));
}

const SIMILAR_QUERY_FAMILIES = [
  "lixeira", "moedor", "headset", "interruptor", "fechadura", "abridor",
  "microfone", "ventilador", "maçarico", "organizador", "fone",
];
const SIMILAR_QUERY_ATTRIBUTES = new Set([
  "automatico", "automatica", "sensor", "eletrico", "eletrica", "wifi",
  "touch", "usb", "portatil", "digital", "biometrica", "recarregavel",
  "inteligente", "lapela", "gamer", "preto", "preta", "branco", "branca",
  "cinza", "vermelho", "vermelha", "azul", "verde", "rosa",
]);
function similarSearchQueries(value: unknown) {
  const tokens = [...comparableTokens(value)];
  const family = SIMILAR_QUERY_FAMILIES.find((token) => tokens.includes(token)) || tokens[0];
  const variantTokens = tokens.filter((token) =>
    token !== family && (SIMILAR_QUERY_ATTRIBUTES.has(token) || /\d/.test(token))
  );
  const descriptive = tokens.filter((token) => token !== family && !variantTokens.includes(token));
  const compact = [family, ...variantTokens.slice(0, 3), ...descriptive.slice(0, 1)].filter(Boolean).join(" ");
  const broad = [family, ...descriptive.slice(0, 2)].filter(Boolean).join(" ");
  return [...new Set([compact, broad].filter((query) => query.split(/\s+/).length >= 2))];
}

function inferredMonthlySalesVolume(value: unknown) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const match = raw.match(/([\d.,]+)\s*\+?/);
  if (!match) return null;
  const estimate = Number(match[1].replace(/\D/g, ""));
  if (!Number.isFinite(estimate) || estimate <= 0) return null;
  return {
    competitor_sales_estimate: estimate,
    competitor_sales_estimate_confidence: /bought|comprad|vendid/i.test(raw) ? "medium" : "low",
    competitor_sales_estimate_source: "inferred",
    sales_volume_raw: raw,
  };
}

const SIMILAR_COMPETITION_ALGORITHM_VERSION = 5;
const COLOR_TOKENS = [
  "preto", "preta", "branco", "branca", "cinza", "vermelho", "vermelha",
  "azul", "verde", "rosa", "amarelo", "amarela", "bege", "marrom",
  "prata", "dourado", "dourada", "transparente",
];

function productVariantSignature(value: unknown) {
  const normalized = String(value || "").normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/,/g, ".").replace(/[^a-z0-9.]+/g, " ").trim();
  const tokens = normalized.split(/\s+/).filter(Boolean);
  const colors = COLOR_TOKENS.filter((color) => tokens.includes(color));
  const models = tokens.filter((token) =>
    token.length >= 3 && /[a-z]/.test(token) && /\d/.test(token) &&
    !/^\d+(?:\.\d+)?(?:ml|cm|mm|kg|gb|w|v|l)$/.test(token)
  );
  const sizes = [...normalized.matchAll(
    /\b\d+(?:\.\d+)?\s*(?:ml|litros?|l|cm|mm|metros?|m|kg|gramas?|g|polegadas?|pol|botoes?|vias?|pecas?|unidades?)\b/g,
  )].map((match) => match[0].replace(/\s+/g, ""));
  return { colors: [...new Set(colors)], models: [...new Set(models)], sizes: [...new Set(sizes)] };
}

function comparableVariant(sourceTitle: unknown, candidateTitle: unknown) {
  const source = productVariantSignature(sourceTitle);
  const candidate = productVariantSignature(candidateTitle);
  const overlap = (left: string[], right: string[]) => left.some((value) => right.includes(value));
  if (source.models.length && candidate.models.length && !overlap(source.models, candidate.models)) return { ok: false, matched: [] };
  if (source.colors.length && candidate.colors.length && !overlap(source.colors, candidate.colors)) return { ok: false, matched: [] };
  if (source.sizes.length && candidate.sizes.length && !overlap(source.sizes, candidate.sizes)) return { ok: false, matched: [] };
  const matched = [
    source.models.length ? "mesmo_modelo" : null,
    source.colors.length ? "mesma_cor" : null,
    source.sizes.length ? "mesmo_tamanho_variante" : null,
    !source.models.length && !source.colors.length && !source.sizes.length ? "mesmo_produto_generico" : null,
  ].filter(Boolean);
  return { ok: true, matched };
}
const unwrap = (value: any) => value?.data || value || {};
const automaticExecutionRuntimeEnabled = () =>
  isAutomaticRepricingRuntimeEnabled(
    secrets.get(AUTOMATIC_REPRICING_RUNTIME_FLAG),
  );

function sellerIdentity(account: any) {
  return resolveSellerId(account, {
    AMAZON_SELLER_ID: secrets.get("AMAZON_SELLER_ID"),
    SP_SELLER_ID: secrets.get("SP_SELLER_ID"),
  });
}

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

function isAmazonQuotaLimit(result: any) {
  const status = Number(result?.status || result?.payload?.status || 0);
  const errors = result?.errors || result?.payload?.errors || [];
  const text = [
    result?.error,
    ...errors.flatMap((error: any) => [error?.code, error?.message]),
  ].filter(Boolean).join(" ").toLowerCase();
  return status === 429 ||
    /quota|throttl|too\s*many\s*requests|rate\s*limit/.test(text);
}

async function ensureSellerIdentity(
  base44: any,
  account: any,
  accessToken: string,
) {
  const configured = sellerIdentity(account);
  if (configured.sellerId) {
    return {
      account: { ...account, seller_id: configured.sellerId },
      ...configured,
    };
  }
  const result = await amazonCall(
    base44,
    account.id,
    "repricing_get_marketplace_participations",
    `${spBase(account.region)}/sellers/v1/marketplaceParticipations`,
    accessToken,
  );
  let discovered = result.ok === true
    ? sellerIdFromParticipations(amazonPayload(result))
    : "";
  let source = discovered ? "SP-API marketplaceParticipations" : "";
  let adsDiscoveryError = "";
  if (!discovered) {
    const tokenResponse = await base44.asServiceRole.functions.invoke(
      "amazonAdsTokenManager",
      { amazon_account_id: account.id, _service_role: true },
    ).catch((error: any) => ({
      data: { ok: false, error: error?.message || String(error) },
    }));
    const tokenData = unwrap(tokenResponse);
    const adsClientId = secrets.get("ADS_CLIENT_ID") ||
      secrets.get("AMAZON_ADS_CLIENT_ID") || "";
    if (tokenData?.ok === true && tokenData?.access_token && adsClientId) {
      const profilesResponse: any = await fetch(
        "https://advertising-api.amazon.com/v2/profiles",
        {
          headers: {
            Authorization: `Bearer ${tokenData.access_token}`,
            "Amazon-Advertising-API-ClientId": adsClientId,
            "Content-Type": "application/json",
          },
          signal: AbortSignal.timeout(20000),
        },
      ).catch((error: any) => ({
        ok: false,
        status: 0,
        json: async () => ({}),
        error: error?.message || String(error),
      }));
      const profiles = await profilesResponse.json().catch(() => []);
      if (profilesResponse.ok) {
        discovered = sellerIdFromAdsProfiles(profiles, account.ads_profile_id);
        if (discovered) source = "Amazon Ads profile accountInfo.id";
      } else {
        adsDiscoveryError = profilesResponse.error ||
          `Amazon Ads profiles HTTP ${profilesResponse.status}`;
      }
    } else {
      adsDiscoveryError = tokenData?.error ||
        (!adsClientId ? "ADS_CLIENT_ID ausente" : "Token Amazon Ads ausente");
    }
  }
  if (!discovered) {
    return {
      account,
      sellerId: "",
      source: null,
      discoveryError: result.ok === true
        ? `A Sellers API respondeu HTTP 200, mas não forneceu Seller ID. Fallback Ads indisponível: ${adsDiscoveryError || "perfil seller não encontrado"}.`
        : amazonError(result),
    };
  }
  const persisted = await base44.asServiceRole.entities.AmazonAccount.update(
    account.id,
    { seller_id: discovered },
  ).then(() => true).catch(() => false);
  return {
    account: { ...account, seller_id: discovered },
    sellerId: discovered,
    source,
    discovered: true,
    persisted,
  };
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
  const { offerActive } = listingOfferStatus(summaries);
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
  const sellerId = sellerIdentity(account).sellerId;
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
  const referencePrices = (body?.referencePrices || []).map((reference: any) => ({
    name: reference?.name || reference?.type || "reference",
    amount: numberValue(
      reference?.price?.amount ?? reference?.amount ?? reference?.value,
      0,
    ),
    currencyCode: reference?.price?.currencyCode || reference?.currencyCode || null,
  })).filter((reference: any) => reference.amount > 0);
  return { offers: offers.slice(0, 20), featuredOfferPrice, referencePrices };
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
        rateLimited: isAmazonQuotaLimit(competitive) ||
          isAmazonQuotaLimit(foep) ||
          Number(competitiveResponse?.status?.statusCode || 0) === 429 ||
          Number(foepResponse?.status?.statusCode || 0) === 429,
        offers: competitiveParsed.offers,
        featuredOfferPrice: foepParsed.featured ||
          competitiveParsed.featuredOfferPrice,
        featuredOfferExpectedPrice: foepParsed.expected,
        referencePrices: competitiveParsed.referencePrices,
        referenceAveragePrice: averagePositive(
          competitiveParsed.referencePrices.map((reference: any) => reference.amount),
        ),
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
        String(economics.fees_source || "").startsWith("sp_api") &&
        hoursSince(economics.fees_verified_at) <=
          numberValue(settings.fees_max_age_hours, 24),
    ),
    adsCostConfirmed: finite(adsCost.value) && adsCost.source !== "missing" &&
      Boolean(adsCost.verifiedAt) && hoursSince(adsCost.verifiedAt) <= 24 * 30,
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
    { amazon_account_id: accountId, entity_type: "product_price" },
    "-created_at",
    500,
  ).catch(() => []);
  for (
    const action of actions.filter((item: any) =>
      actionMatchesSku(item, sku) && isConcurrentPriceAction(item)
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
  const day = dayKeyInTimeZone()!;
  const normalizedSku = normalizeSku(params.product?.sku);
  const baseKey = `repricing:${params.accountId}:${params.marketplaceId}:${
    normalizedSku
  }:${newPrice.toFixed(2)}`;
  const [exactSkuActions, normalizedSkuActions] = await Promise.all([
    base44.asServiceRole.entities.AmazonActionQueue.filter(
      {
        amazon_account_id: params.accountId,
        entity_type: "product_price",
        sku: params.product.sku,
      },
      "-created_at",
      50,
    ).catch(() => []),
    base44.asServiceRole.entities.AmazonActionQueue.filter(
      {
        amazon_account_id: params.accountId,
        entity_type: "product_price",
        normalized_sku: normalizedSku,
      },
      "-created_at",
      50,
    ).catch(() => []),
  ]);
  const sameSkuActions = [...new Map(
    [...exactSkuActions, ...normalizedSkuActions]
      .filter((action: any) => actionMatchesSku(action, normalizedSku))
      .map((action: any) => [action.id, action]),
  ).values()];
  if (!params.manual) {
    if (params.decision?.emergencyMarginRecovery === true) {
      // Recuperação de margem não pode ser diluída pelo limite normal de R$2/dia.
      // A fila ainda revalida listing, custos, tarifas, Ads e margem antes do PUT.
    } else {
    const finalGuard = applyGuardedPriceChange({
      currentPrice: oldPrice,
      proposedPrice: newPrice,
      decisionConfidence: numberValue(params.evidence?.decision_confidence),
      priceChangeUsed24h: priceChangeUsedInWindow({
        actions: sameSkuActions,
        history: params.productHistory || [],
        windowHours: numberValue(params.settings?.price_change_window_hours, 24),
      }),
      maximumPriceChangeAmount24h: numberValue(
        params.settings?.maximum_price_change_amount_24h,
        2,
      ),
      minimumPriceChangeAmount: numberValue(
        params.settings?.minimum_price_change_amount,
        0.05,
      ),
      minimumAutomaticConfidence: Math.max(96, numberValue(
        params.settings?.minimum_automatic_confidence,
        96,
      )),
    });
    if (!finalGuard.automaticAllowed ||
      !pricesMatch(commercialPrice90AtOrAbove(finalGuard.guardedPrice), newPrice)) {
      return { created: false, action: null, blocked: true, guard: finalGuard };
    }
    }
  }
  const concurrent = sameSkuActions.find(isConcurrentPriceAction);
  if (concurrent) return { created: false, action: concurrent };
  const alreadyHandledToday = sameSkuActions.find(
    (action: any) => actionBlocksAutomaticDay(action, day),
  );
  if (alreadyHandledToday) {
    return { created: false, action: alreadyHandledToday };
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
    normalized_sku: normalizedSku,
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
      emergency_margin_recovery: params.decision.emergencyMarginRecovery === true,
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
  const [products, economicsRows, salesRows, adsRows, historyRows, actionRows] =
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
      base44.asServiceRole.entities.AmazonActionQueue.filter(
        { amazon_account_id: account.id, entity_type: "product_price" },
        "-created_at",
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
    const availableStock = numberValue(
      product.available_quantity ?? product.fba_inventory,
      0,
    );
    // Não consultar concorrentes, consumir ScrapingBee nem gerar preço para
    // catálogo inativo/sem estoque. Registros e decisões anteriores ficam
    // intactos para auditoria; somente a nova avaliação é bloqueada.
    if (
      product.status !== "active" ||
      availableStock <= 0 ||
      !product.sku ||
      !product.asin
    ) {
      return false;
    }
    if (options.product_id && product.id !== options.product_id) return false;
    const economics = latestEconomicsBySku.get(normalizeSku(product.sku));
    return Boolean(
      economics &&
        (economics.costs_confirmed_by_user || options.product_id ||
          options.force_all_decisions === true),
    );
  });
  // Uma mesma oferta pode aparecer mais de uma vez após importações legadas.
  // Avaliar uma única linha por SKU evita estudos e decisões conflitantes.
  const uniqueEligible = new Map<string, any>();
  for (const product of eligible) {
    const key = normalizeSku(product.sku);
    const current = uniqueEligible.get(key);
    const score = (row: any) =>
      (row.status === "active" ? 100 : 0) +
      (numberValue(row.available_quantity ?? row.fba_inventory, 0) > 0 ? 20 : 0) +
      (row.catalog_sync_status === "success" ? 10 : 0) +
      (row.display_name && normalizeSku(row.display_name) !== key ? 5 : 0) +
      Math.min(4, comparableTokens(row.display_name || row.product_name || row.title || "").size);
    if (!current || score(product) > score(current)) uniqueEligible.set(key, product);
  }
  eligible = [...uniqueEligible.values()];
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
    // O estudo de mercado é informativo e deve existir mesmo quando estoque,
    // Listings ou fulfillment ainda impedem a EXECUÇÃO do novo preço.
    const cachedSimilar = economics.decision_evidence || {};
    // Concorrência usada na decisão vem exclusivamente da Product Pricing
    // API. Scraping/HTML permanece fora do caminho econômico e nunca autoriza
    // alteração de preço.
    const similarCompetition = {
      average: null, minimum: null, maximum: null, count: 0, matches: [],
      checkedAt: nowIso(), source: "disabled_official_api_only",
      aiAssisted: false, canonicalSourceTitle: null, searchQueries: [],
      error: "public_page_scraping_disabled",
    };
    await base44.asServiceRole.entities.ProductEconomics.update(economics.id, {
      decision_evidence: {
        ...cachedSimilar,
        similar_competitor_price_average: similarCompetition.average,
        similar_competitor_price_minimum: similarCompetition.minimum,
        similar_competitor_price_maximum: similarCompetition.maximum,
        similar_competitor_product_count: similarCompetition.count,
        similar_competitor_products: similarCompetition.matches,
        similar_competition_checked_at: similarCompetition.checkedAt,
        similar_competition_source: similarCompetition.source,
        similar_competition_search_queries: similarCompetition.searchQueries || [],
        similar_competition_error: similarCompetition.error || null,
        similar_competition_ai_assisted: similarCompetition.aiAssisted === true,
        similar_competition_canonical_title: similarCompetition.canonicalSourceTitle || null,
        similar_competition_threshold: 0.90,
        similar_competition_algorithm_version: SIMILAR_COMPETITION_ALGORITHM_VERSION,
      },
      updated_at: nowIso(),
    }).catch(() => {});
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
    const inventoryFresh = product.catalog_sync_status === "success" &&
      hoursSince(product.last_catalog_sync_at) <= 2;
    if (!inventoryFresh) {
      const reason =
        "Repricing bloqueado: estoque FBA ausente, inconsistente ou desatualizado.";
      await cancelPendingPriceActions(base44, account.id, product.sku, reason);
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
    const listingBlockReasons = listingExecutionBlockReasons(listing);
    if (listingBlockReasons.includes("oferta_inativa")) {
      requirements.push("Repricing bloqueado: oferta inativa na Amazon.");
    }
    if (listingBlockReasons.includes("listing_nao_compravel")) {
      requirements.push("Repricing bloqueado: listing não comprável ou com issue de erro.");
    }
    if (listingBlockReasons.includes("product_type_ausente")) {
      requirements.push("Repricing bloqueado: Product Type ausente.");
    }
    if (listingBlockReasons.includes("fulfillment_nao_confirmado_como_fba")) {
      requirements.push("Repricing bloqueado: fulfillment da oferta não foi confirmado como FBA/AFN.");
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
    const sellerId = sellerIdentity(account).sellerId;
    const competitorOffers = (pricing.offers || []).filter((offer: any) =>
      !sellerId || !offer.sellerId ||
      String(offer.sellerId) !== String(sellerId)
    );
    const competitionFresh = pricing.ok === true ||
      (economics.competition_checked_at &&
        hoursSince(economics.competition_checked_at) * 60 <=
          numberValue(settings.competition_max_age_minutes, 30));
    const marketCompetitionFresh = competitionFresh;
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
      marketCompetitionFresh ? (competitionFresh ? 1 : 0.75) : 0,
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
      referenceAveragePrice: pricing.referenceAveragePrice,
      similarReferenceAveragePrice: similarCompetition.average,
      similarReferenceCount: similarCompetition.count,
      competitorOffers,
      competitionFresh: marketCompetitionFresh,
      sellerFulfillmentType: listing.sellerFulfillmentType,
      dailyUnits,
      sessions: numberValue(sales.sessions),
      conversionRate,
      adsClicks: numberValue(ads?.clicks),
      adsOrders: numberValue(ads?.orders),
      adsConversionRate: numberValue(ads?.clicks) > 0
        ? numberValue(ads?.orders) / numberValue(ads?.clicks)
        : null,
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
        minimumConfidence: Math.max(96, numberValue(
          settings.minimum_automatic_confidence,
          96,
        )) / 100,
      },
    });
    const inventoryConfidenceFresh = Boolean(
      stock > 0 && product.last_catalog_sync_at &&
        hoursSince(product.last_catalog_sync_at) <= 2,
    );
    const salesAndConversionSufficient = numberValue(sales.sessions) >= 20 &&
      numberValue(sales.units) > 0 && conversionRate > 0;
    const adsMetricsMatured = Boolean(
      ads?.latest?.data_status === "complete" &&
        (ads.latest.metrics_matured === true ||
          ads.latest.attribution_confidence === "complete" ||
          hoursSince(ads.latest.assessment_date) >= 48),
    );
    const priceHistorySufficient = productHistory.filter((row: any) =>
      row.history_type === "price_confirmed" &&
      row.decision_evidence?.observation_completed === true
    ).length >= 2;
    const confidenceAudit = deterministicPriceConfidence({
      economicsComplete: validation.complete,
      priceAndFeesFresh: Boolean(
        confirmedPrice > 0 && listing.buyable &&
          mergedEconomics.fees_verified_at &&
          hoursSince(mergedEconomics.fees_verified_at) <=
            numberValue(settings.fees_max_age_hours, 24),
      ),
      inventoryFresh: inventoryConfidenceFresh,
      equivalentCompetitionValid: competitionFresh && competitorOffers.length > 0,
      salesAndConversionSufficient,
      adsMetricsMatured,
      priceHistorySufficient,
    });
    const skuActions = actionRows.filter((action: any) =>
      actionMatchesSku(action, key)
    );
    const priceChangeUsed24h = priceChangeUsedInWindow({
      actions: skuActions,
      history: productHistory,
      windowHours: numberValue(settings.price_change_window_hours, 24),
    });
    const guardedChange = applyGuardedPriceChange({
      currentPrice: confirmedPrice,
      proposedPrice: numberValue(decision.suggestedPrice, confirmedPrice),
      decisionConfidence: confidenceAudit.score,
      priceChangeUsed24h,
      maximumPriceChangeAmount24h: numberValue(
        settings.maximum_price_change_amount_24h,
        2,
      ),
      minimumPriceChangeAmount: numberValue(
        settings.minimum_price_change_amount,
        0.05,
      ),
      minimumAutomaticConfidence: Math.max(96, numberValue(
        settings.minimum_automatic_confidence,
        96,
      )),
    });
    const idealSuggestedPrice = decision.suggestedPrice;
    decision.confidence = confidenceAudit.score / 100;
    if (decision.emergencyMarginRecovery && validation.complete) {
      const emergencyPrice = commercialPrice90AtOrAbove(
        Math.max(Number(decision.minimumProfitablePrice), Number(decision.suggestedPrice || 0)),
      );
      const emergencyEconomics = economicsAtPrice(emergencyPrice, policy);
      const manualMaximum = numberValue(policy.manualMaxPrice, Number.POSITIVE_INFINITY);
      if (emergencyEconomics && emergencyEconomics.marginPct >= 15 && emergencyPrice <= manualMaximum) {
        decision.suggestedPrice = emergencyPrice;
        decision.projectedEconomics = emergencyEconomics;
        decision.blockReasons = (decision.blockReasons || []).filter((reason: string) =>
          !/confian|cooldown|altera[cç][aã]o inferior|limite absoluto/i.test(reason)
        );
        decision.automaticEligible = true;
        decision.decisionReason =
          "Recuperação automática imediata: preço ativo abaixo de 15% de margem líquida, elevado ao primeiro valor terminado em ,90 que preserva o piso econômico.";
      }
    } else if (guardedChange.automaticAllowed) {
      const commercialPrice = commercialPrice90AtOrAbove(guardedChange.guardedPrice);
      const commercialEconomics = economicsAtPrice(commercialPrice, policy);
      decision.suggestedPrice = commercialPrice;
      decision.projectedEconomics = commercialEconomics;
    } else if (guardedChange.status === "recommendation_only") {
      decision.blockReasons.push(
        "Confiança entre 75% e 95,99%: somente recomendação, sem alteração automática.",
      );
    } else if (guardedChange.status === "insufficient_confidence") {
      decision.blockReasons.push(
        "Confiança inferior a 75%: alteração bloqueada até existirem dados suficientes.",
      );
    } else if (guardedChange.status === "limit_exhausted") {
      decision.blockReasons.push(
        "Limite absoluto de alteração de preço em 24 horas esgotado ou abaixo de R$ 0,05.",
      );
    }
    const economicConflict = Boolean(
      decision.currentEconomics && decision.currentEconomics.marginPct < 15,
    );
    const requestedEnabled = economics.repricing_requested === true ||
      economics.repricing_enabled === true;
    const executionEnabled = requestedEnabled && validation.complete;
    const status = guardedChange.status === "recommendation_only"
      ? "recommendation"
      : guardedChange.status === "insufficient_confidence" ||
          guardedChange.status === "limit_exhausted"
      ? "blocked"
      : !executionEnabled
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
      metric_scope: competitorMetricScope(),
      decision_confidence: confidenceAudit.score,
      confidence_components: confidenceAudit.components,
      missing_data: confidenceAudit.missingData,
      confidence_reason: confidenceAudit.reason,
      decision_status: guardedChange.status,
      decision_action: decision.suggestedPrice &&
          Math.abs(Number(decision.suggestedPrice) - confirmedPrice) >= 0.01
        ? Number(decision.suggestedPrice) > confirmedPrice
          ? "increase_price"
          : "decrease_price"
        : "maintain_price",
      forced_full_decision_audit: options.force_all_decisions === true,
      ideal_suggested_price: idealSuggestedPrice,
      guarded_suggested_price: decision.suggestedPrice,
      price_change_used_24h: guardedChange.priceChangeUsed24h,
      remaining_price_change_24h: guardedChange.remainingPriceChange24h,
      maximum_price_change_amount_24h: numberValue(
        settings.maximum_price_change_amount_24h,
        2,
      ),
      current_price_source: "Listings Items API 2021-08-01",
      competition_source: "Product Pricing API 2022-05-01",
      market_competition_fresh: marketCompetitionFresh,
      sp_api_competition_fresh: competitionFresh,
      public_page_scraping_enabled: false,
      fees_source: mergedEconomics.fees_source,
      ads_cost_source: adsCost.source,
      current_price: confirmedPrice,
      featured_offer_price: pricing.featuredOfferPrice,
      featured_offer_expected_price: pricing.featuredOfferExpectedPrice,
      competitor_offers: competitorOffers.length,
      competitor_offer_price_average: averagePositive(
        competitorOffers.map((offer: any) => offer.totalPrice),
      ),
      competitor_reference_prices: pricing.referencePrices || [],
      competitor_reference_price_average: pricing.referenceAveragePrice || null,
      official_competition_only: true,
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
      ideal_suggested_price: idealSuggestedPrice,
      decision_confidence: confidenceAudit.score,
      confidence_components: confidenceAudit.components,
      missing_data: confidenceAudit.missingData,
      confidence_reason: confidenceAudit.reason,
      guarded_decision_status: guardedChange.status,
      price_change_used_24h: guardedChange.priceChangeUsed24h,
      remaining_price_change_24h: guardedChange.remainingPriceChange24h,
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
      competitor_reference_prices: pricing.referencePrices || [],
      competitor_reference_price_average: pricing.referenceAveragePrice || null,
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
    const competitorOfferPrices = competitorOffers
      .map((offer: any) => numberValue(offer.totalPrice))
      .filter((value: number) => value > 0);
    await base44.asServiceRole.entities.Product.update(product.id, {
      listing_buyable: listing.buyable,
      offer_active: listing.offerActive,
      listing_suppressed: listing.suppressed,
      price: confirmedPrice,
      market_price_average: pricing.referenceAveragePrice || decision.competitorMedian,
      market_price_minimum: competitorOfferPrices.length
        ? Math.min(...competitorOfferPrices)
        : null,
      market_price_maximum: competitorOfferPrices.length
        ? Math.max(...competitorOfferPrices)
        : null,
      market_price_median: decision.competitorMedian || pricing.referenceAveragePrice,
      market_price_offer_count: decision.equivalentOfferCount || 0,
      market_price_currency: currency,
      market_price_source: "sp_api_product_pricing_2022_05_01",
      market_price_provider: "Amazon SP-API",
      market_price_marketplace: account.marketplace_id,
      market_price_status: pricing.ok !== true
        ? "failed"
        : numberValue(decision.equivalentOfferCount) > 0
        ? "success"
        : "no_offers",
      market_price_error: pricing.ok ? null : pricing.errors?.join(" ") || "Product Pricing API unavailable",
      market_price_last_checked_at: pricing.checkedAt || nowIso(),
      market_price_updated_by: "runAutomaticRepricing",
    }).catch(() => {});

    // Uma auditoria por ciclo/minuto: o ciclo horário e o estudo completo
    // consecutivo devem registrar conclusões independentes, inclusive "manter".
    const decisionKey = `repricing_decision:${account.id}:${key}:${
      nowIso().slice(0, 16)
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
    const emergencyExecutionAllowed = decision.emergencyMarginRecovery === true &&
      options.emergency_margin_recovery === true;
    const runtimeExecutionAllowed = manual || options.explicit_execution === true ||
      automaticExecutionRuntimeEnabled() || emergencyExecutionAllowed;
    const canQueue = decision.suggestedPrice &&
      confirmedPrice > 0 &&
      Number(decision.suggestedPrice) > 0 &&
      Number(decision.minimumProfitablePrice) > 0 &&
      Number(decision.suggestedPrice) + 0.001 >=
        Number(decision.minimumProfitablePrice) &&
      Math.abs(decision.suggestedPrice - confirmedPrice) >=
        numberValue(settings.minimum_price_change_amount, 0.05) &&
      decision.automaticEligible === true &&
      (decision.blockReasons || []).length === 0 &&
      validation.complete && listing.buyable && stock > 0 &&
      (options.recommendation_only !== true || emergencyExecutionAllowed) &&
      runtimeExecutionAllowed &&
      (manual || options.explicit_execution === true || emergencyExecutionAllowed ||
        (settings.enabled !== false &&
          settings.repricing_rollout_mode === "guarded" &&
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
        productHistory,
        settings,
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
  const dueCandidates = allActions
    .filter((action: any) =>
      ["pending", "submitted", "processing"].includes(
        String(action.status || ""),
      )
    )
    .filter((action: any) =>
      !action.next_retry_at ||
      new Date(action.next_retry_at).getTime() <= Date.now()
    )
    .sort((a: any, b: any) =>
      new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime()
    );
  const groupedDue = new Map<string, any[]>();
  for (const action of dueCandidates) {
    const key = normalizeSku(action.normalized_sku || action.sku);
    if (!key) continue;
    const group = groupedDue.get(key) || [];
    group.push(action);
    groupedDue.set(key, group);
  }
  const due: any[] = [];
  const duplicateResults: any[] = [];
  for (const group of groupedDue.values()) {
    const inFlight = group.filter((action: any) =>
      ["submitted", "processing"].includes(String(action.status || ""))
    );
    const keep = new Set(
      (inFlight.length ? inFlight : group.slice(0, 1)).map((action: any) =>
        action.id
      ),
    );
    for (const action of group) {
      if (keep.has(action.id)) {
        due.push(action);
        continue;
      }
      await base44.asServiceRole.entities.AmazonActionQueue.update(action.id, {
        status: "cancelled",
        last_error:
          "Ação duplicada do mesmo SKU; preservada somente a ação canônica para reconciliação.",
        completed_at: nowIso(),
        updated_at: nowIso(),
      }).catch(() => {});
      duplicateResults.push({
        action_id: action.id,
        sku: action.sku,
        status: "cancelled",
        duplicate: true,
      });
    }
  }
  due.splice(
    Math.max(1, Math.min(numberValue(options.max_actions, 20), 100)),
  );
  const productBySku = new Map<string, any>(
    products.map((product: any) => [normalizeSku(product.sku), product]),
  );
  const economicsBySku = new Map<string, any>();
  for (const economics of economicsRows) {
    const key = normalizeSku(economics.sku);
    if (key && !economicsBySku.has(key)) economicsBySku.set(key, economics);
  }
  const results: any[] = [...duplicateResults];
  for (const action of due) {
    const key = normalizeSku(action.normalized_sku || action.sku);
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
    const inventoryFresh = product.catalog_sync_status === "success" &&
      hoursSince(product.last_catalog_sync_at) <= 2;
    if (
      product.status !== "active" || !inventoryFresh ||
      listingExecutionBlockReasons(listing).length > 0
    ) {
      results.push(
        await failOrRetry(base44, action, {
          status: 422,
          errors: [{
            message:
              "Produto inativo, estoque FBA desatualizado ou fulfillment não confirmado como AFN.",
          }],
        }, true),
      );
      continue;
    }
    if (!pricesMatch(listing.currentPrice, action.old_price)) {
      results.push(
        await failOrRetry(base44, action, {
          status: 409,
          errors: [{
            message:
              `Preço atual da Amazon divergiu da base da ação (${listing.currentPrice} vs ${action.old_price}); publicação cancelada para preservar o preço confirmado.`,
          }],
        }, true),
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
      !pricesMatch(
        numberValue(action.new_price),
        commercialPrice90AtOrAbove(numberValue(action.new_price)),
      ) ||
      numberValue(validation.minimumProfitablePrice) <= 0 ||
      numberValue(action.new_price) + 0.001 <
        numberValue(validation.minimumProfitablePrice)
    ) {
      results.push(
        await failOrRetry(base44, action, {
          status: 422,
          errors: [{
            message: `Guardrail econômico bloqueou a publicação: ${
              validation.reasons.join(" ") ||
                "margem inferior a 15% ou preço fora do padrão comercial ,90"
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
    if (
      action.payload?.manual_apply !== true &&
      action.payload?.emergency_margin_recovery !== true &&
      !automaticExecutionRuntimeEnabled()
    ) {
      const nextRetryAt = new Date(Date.now() + 60 * 60000).toISOString();
      await base44.asServiceRole.entities.AmazonActionQueue.update(action.id, {
        status: "pending",
        last_error:
          `Execução automática suspensa: ative ${AUTOMATIC_REPRICING_RUNTIME_FLAG} somente após o rollout controlado.`,
        next_retry_at: nextRetryAt,
        updated_at: nowIso(),
      }).catch(() => {});
      results.push({
        action_id: action.id,
        sku: action.sku,
        status: "pending",
        runtime_kill_switch: true,
        next_retry_at: nextRetryAt,
      });
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
    numberValue(settings.maximum_price_change_amount_24h) <= 0 ||
    numberValue(settings.maximum_price_change_amount_24h) > 2
  ) throw new Error("O limite absoluto em 24 horas não pode superar R$ 2,00.");
  if (numberValue(settings.minimum_price_change_amount) < 0.05) {
    throw new Error("A alteração mínima de preço não pode ser inferior a R$ 0,05.");
  }
  if (numberValue(settings.minimum_automatic_confidence) < 96) {
    throw new Error("A confiança automática mínima não pode ser inferior a 96%.");
  }
  if (numberValue(settings.price_change_window_hours) !== 24) {
    throw new Error("A janela móvel de preço deve ser de 24 horas.");
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
    repricing_rollout_mode: ["guarded", "recommendation_only", "manual"]
        .includes(String(settings.repricing_rollout_mode))
      ? settings.repricing_rollout_mode
      : "guarded",
    maximum_price_change_amount_24h: Math.min(
      2,
      numberValue(settings.maximum_price_change_amount_24h, 2),
    ),
    minimum_price_change_amount: Math.max(
      0.05,
      numberValue(settings.minimum_price_change_amount, 0.05),
    ),
    minimum_automatic_confidence: Math.max(
      96,
      Math.min(100, numberValue(settings.minimum_automatic_confidence, 96)),
    ),
    price_change_window_hours: 24,
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
  identityResult?: any,
) {
  const identity = sellerIdentity(account);
  const sellerId = identity.sellerId;
  const marketplaceId = account.marketplace_id ||
    secrets.get("AMAZON_MARKETPLACE_ID") || "";
  const products = await base44.asServiceRole.entities.Product.filter(
    { amazon_account_id: account.id },
    "-updated_date",
    100,
  ).catch(() => []);
  const economics = await base44.asServiceRole.entities.ProductEconomics.filter(
    { amazon_account_id: account.id },
    "-updated_at",
    100,
  ).catch(() => []);
  const productSamples = selectSpApiSamples(products);
  const economicSamples = selectSpApiSamples(economics);
  const samples = {
    listing: productSamples.listing || economicSamples.listing,
    asin: productSamples.asin || economicSamples.asin,
    pricing: productSamples.pricing || economicSamples.pricing,
  };
  const checks: any = {
    oauth: { ok: true, message: "OAuth SP-API validado." },
    seller: {
      ok: Boolean(sellerId),
      message: sellerId
        ? `Seller ID validado (${identityResult?.source || identity.source}).`
        : `Seller ID ausente e não identificado pela autorização SP-API${
          identityResult?.discoveryError ? `: ${identityResult.discoveryError}` : "."
        }`,
    },
    marketplace: {
      ok: Boolean(marketplaceId),
      message: marketplaceId
        ? "Marketplace ID configurado."
        : "Marketplace ID ausente.",
    },
    listings: {
      ok: false,
      skipped: true,
      sku: samples.listing?.sku || null,
      message: samples.listing
        ? "SKU encontrado; teste bloqueado pela configuração da conta."
        : `Nenhum SKU encontrado em ${products.length} produto(s) e ${economics.length} registro(s) econômicos.`,
    },
    pricing: {
      ok: false,
      skipped: true,
      sku: samples.pricing?.sku || null,
      asin: samples.pricing?.asin || samples.asin?.asin || null,
      message: samples.pricing
        ? "SKU e ASIN encontrados; teste bloqueado pela configuração da conta."
        : "Nenhum registro com SKU e ASIN encontrado entre catálogo e economia do produto.",
    },
  };
  if (!sellerId || !marketplaceId) {
    return {
      account_id: account.id,
      connected: false,
      product_count: products.length,
      economics_count: economics.length,
      checks,
    };
  }

  const sample = samples.pricing;
  if (!sample) {
    return {
      account_id: account.id,
      connected: true,
      limited: true,
      product_count: products.length,
      economics_count: economics.length,
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
  const pricingRateLimited = pricing?.rateLimited === true;
  checks.pricing = {
    ok: pricing?.ok === true,
    degraded: pricingRateLimited,
    retryable: pricingRateLimited,
    sku: sample.sku,
    asin: sample.asin,
    message: pricing?.ok
      ? "Product Pricing API acessível."
      : pricingRateLimited
      ? "Product Pricing API autenticada, mas a Amazon limitou temporariamente a quota. O motor usará dados confirmados em cache e tentará novamente no próximo ciclo; nenhuma alteração será feita com concorrência vencida."
      : pricing?.errors?.join(" ") || "Falha ao consultar Product Pricing API.",
  };
  const connected = checks.listings.ok &&
    (checks.pricing.ok || checks.pricing.degraded);
  return {
    account_id: account.id,
    connected,
    degraded: connected && checks.pricing.degraded === true,
    message: connected && checks.pricing.degraded === true
      ? "SP-API conectada. A consulta de preços está temporariamente limitada pela quota da Amazon e será repetida automaticamente."
      : undefined,
    product_count: products.length,
    economics_count: economics.length,
    checked_at: nowIso(),
    sample: { sku: sample.sku, asin: sample.asin },
    checks,
  };
}

async function fetchSimilarCompetition(
  base44: any,
  account: any,
  accessToken: string,
  product: any,
  aiBudget: { used: number; max: number },
) {
  const originalTitle = product.display_name || product.product_name || product.title || "";
  let title = originalTitle;
  const marketplaceId = account.marketplace_id || secrets.get("AMAZON_MARKETPLACE_ID") || "";
  const localTitleInvalid = !title || normalizeSku(title) === normalizeSku(product.sku) ||
    /^t[ií]tulo pendente$/i.test(String(title).trim());

  // O título canônico do ASIN prevalece sobre textos importados. Isso também
  // corrige contaminação de registros duplicados/parent antes de pesquisar.
  if (product.asin) {
    const sourceCatalog = await amazonCall(
      base44, account.id, "repricing_catalog_source_product",
      `${spBase(account.region)}/catalog/2022-04-01/items/${encodeURIComponent(product.asin)}?marketplaceIds=${marketplaceId}&includedData=summaries,attributes`,
      accessToken,
    );
    const sourcePayload = amazonPayload(sourceCatalog) || {};
    const sourceSummary = (sourcePayload.summaries || []).find((entry: any) => !entry.marketplaceId || entry.marketplaceId === marketplaceId) || sourcePayload.summaries?.[0] || {};
    const canonicalTitle = sourceSummary.itemName || sourceSummary.itemTitle || sourcePayload.attributes?.item_name?.[0]?.value || "";
    if (canonicalTitle && (localTitleInvalid || canonicalTitle !== title)) {
      title = canonicalTitle;
      await base44.asServiceRole.entities.Product.update(product.id, {
        display_name: canonicalTitle,
        product_name: canonicalTitle,
        catalog_sync_status: "success",
        last_catalog_sync_at: nowIso(),
      }).catch(() => {});
    }
  }

  void aiBudget;
  const queries = similarSearchQueries(title);
  if (!product.asin || !queries.length) {
    return { average: null, count: 0, matches: [], checkedAt: nowIso(), source: "scrapingbee_amazon_search_inferred" };
  }
  const scrapingBeeKey = secrets.get("SCRAPINGBEE_API_KEY");
  if (!scrapingBeeKey) {
    return { average: null, count: 0, matches: [], checkedAt: nowIso(), source: "scrapingbee_amazon_search_inferred", error: "SCRAPINGBEE_API_KEY_missing" };
  }
  const searchProducts: any[] = [];
  const queryErrors: string[] = [];
  for (const searchText of queries.slice(0, 2)) {
    const query = new URLSearchParams({
      query: searchText, domain: "com.br", pages: "1", sort_by: "featured",
    });
    try {
      const response = await fetch(`https://app.scrapingbee.com/api/v1/amazon/search?${query}`, {
        headers: { Authorization: `Bearer ${scrapingBeeKey}` },
        signal: AbortSignal.timeout(35000),
      });
      if (!response.ok) {
        queryErrors.push(`${searchText}:HTTP_${response.status}`);
        continue;
      }
      const payload = await response.json().catch(() => ({}));
      if (Array.isArray(payload?.products)) searchProducts.push(...payload.products);
    } catch (error: any) {
      queryErrors.push(`${searchText}:${String(error?.message || "unavailable").slice(0, 80)}`);
    }
  }
  const uniqueProducts = [...new Map(searchProducts.filter((item: any) => item?.asin).map((item: any) => [item.asin, item])).values()];
  const pricedMatches = uniqueProducts.map((item: any) => {
    const matchedTitle = String(item.title || "");
    const similarity = genericProductSimilarity(title, matchedTitle);
    const variant = comparableVariant(title, matchedTitle);
    return {
      asin: item.asin || null,
      title: matchedTitle,
      brand: item.manufacturer || null,
      similarity,
      matchedDimensions: variant.matched,
      variantCompatible: variant.ok,
      averagePrice: numberValue(item.price || item.highest_price, 0),
      amazonUrl: item.asin ? `https://www.amazon.com.br/dp/${item.asin}` : null,
      ...(inferredMonthlySalesVolume(item.sales_volume) || {}),
      organic_position: finite(item.organic_position) ? Number(item.organic_position) : null,
      sponsored: item.is_sponsored === true,
      data_source: "scrapingbee_amazon_search",
    };
  }).filter((item: any) => item.asin && item.asin !== product.asin && item.similarity >= 0.90 && item.variantCompatible && item.averagePrice > 0)
    .sort((a: any, b: any) => b.similarity - a.similarity || numberValue(a.organic_position, 999) - numberValue(b.organic_position, 999))
    .slice(0, 10);
  return {
    average: averagePositive(pricedMatches.map((match: any) => match.averagePrice)),
    minimum: pricedMatches.length ? Math.min(...pricedMatches.map((match: any) => match.averagePrice)) : null,
    maximum: pricedMatches.length ? Math.max(...pricedMatches.map((match: any) => match.averagePrice)) : null,
    count: pricedMatches.length,
    matches: pricedMatches,
    checkedAt: nowIso(),
    source: "scrapingbee_amazon_search_inferred",
    aiAssisted: false,
    canonicalSourceTitle: title,
    searchQueries: queries.slice(0, 2),
    error: !pricedMatches.length && queryErrors.length ? queryErrors.join(" | ").slice(0, 400) : null,
  };
}

async function acquireRepricingLock(
  base44: any,
  accountId: string,
  ownerId: string,
) {
  const response = await base44.asServiceRole.functions.invoke(
    "acquireAmazonSchedulerLock",
    {
      amazon_account_id: accountId,
      lock_key: "automatic_repricing_engine",
      owner_id: ownerId,
      ttl_ms: 55 * 60 * 1000,
      _service_role: true,
    },
  ).catch((error: any) => ({
    data: { ok: false, acquired: false, error: error?.message || String(error) },
  }));
  return unwrap(response);
}

async function releaseRepricingLock(
  base44: any,
  accountId: string,
  ownerId: string,
) {
  await base44.asServiceRole.functions.invoke("acquireAmazonSchedulerLock", {
    amazon_account_id: accountId,
    lock_key: "automatic_repricing_engine",
    owner_id: ownerId,
    action: "release",
    _service_role: true,
  }).catch(() => {});
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
    for (const storedAccount of accounts) {
      const sellerIdentityResult = await ensureSellerIdentity(
        base44,
        storedAccount,
        accessToken,
      );
      const account = sellerIdentityResult.account;
      const options = {
        ...body,
        full: ["full_evaluation", "execute_planned"].includes(operation),
        manual_apply: operation === "apply_suggested",
        explicit_execution: operation === "execute_planned" &&
          body.confirm_execute_planned === true,
        product_id: body.product_id,
        changed_by: user?.email || user?.id || "scheduler",
      };
      if (operation === "connection_check") {
        results.push(
          await checkConnectionForAccount(
            base44,
            account,
            accessToken,
            sellerIdentityResult,
          ),
        );
      } else {
        const ownerId = crypto.randomUUID();
        const lock = await acquireRepricingLock(base44, account.id, ownerId);
        if (lock.acquired !== true) {
          results.push({
            account_id: account.id,
            locked: true,
            lock_owner_id: lock.owner_id || null,
            lock_expires_at: lock.expires_at || null,
            error: lock.error ||
              "Outro ciclo de repricing já está em execução para esta conta.",
          });
          continue;
        }
        try {
          if (["process_queue", "reconcile"].includes(operation)) {
            results.push(
              await processQueueForAccount(base44, account, accessToken, options),
            );
          } else if (
            ["evaluate", "full_evaluation", "apply_suggested", "execute_planned"].includes(operation)
          ) {
            if (
              operation === "execute_planned" &&
              body.confirm_execute_planned !== true
            ) {
              return Response.json({
                ok: false,
                error: "Confirmação explícita obrigatória para executar preços planejados.",
              }, { status: 400 });
            }
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
        } finally {
          await releaseRepricingLock(base44, account.id, ownerId);
        }
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
      ok: results.every((result) => result.locked !== true),
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
