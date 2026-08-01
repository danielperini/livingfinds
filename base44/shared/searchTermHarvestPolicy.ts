export type SameSkuAttribution = {
  windowDays: number;
  totalOrders: number;
  totalSales: number;
  sameSkuOrders: number;
  sameSkuSales: number;
  haloOrders: number;
  haloSales: number;
  verified: boolean;
  source: string;
};

export type HarvestSource = {
  campaignId: string;
  adGroupId: string;
  keywordId: string;
  matchType: string;
  campaignType: string;
};

export type HarvestAggregate = {
  asin: string;
  sku: string;
  term: string;
  normalizedTerm: string;
  impressions: number;
  clicks: number;
  spend: number;
  totalOrders: number;
  totalSales: number;
  sameSkuOrders: number;
  sameSkuSales: number;
  haloOrders: number;
  haloSales: number;
  latestDate: string;
  sourceRows: any[];
  sources: HarvestSource[];
  attributionVerified: boolean;
  skuResolutionVerified: boolean;
};

const own = (row: any, key: string) => Object.prototype.hasOwnProperty.call(row || {}, key);

export function numberValue(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function normalizeSearchTerm(value: unknown): string {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

export function isAsinSearchTerm(value: unknown): boolean {
  return /^B0[A-Z0-9]{8}$/i.test(String(value || '').trim());
}

function firstPresent(row: any, fields: string[]): { present: boolean; value: number; field: string } {
  for (const field of fields) {
    if (own(row, field)) return { present: true, value: numberValue(row[field]), field };
  }
  return { present: false, value: 0, field: '' };
}

/**
 * Amazon seller profiles normally expose 7-day promoted/same-SKU metrics, while
 * vendor profiles can expose 14-day metrics. The selected total and promoted
 * values always come from the same attribution window.
 */
export function resolveSameSkuAttribution(row: any): SameSkuAttribution {
  const windows = [7, 14, 30, 1];
  for (const days of windows) {
    const totalOrders = firstPresent(row, [`purchases${days}d`]);
    const totalSales = firstPresent(row, [`sales${days}d`]);
    const sameOrders = firstPresent(row, [
      `purchasesSameSku${days}d`,
      `promotedPurchases${days}d`,
    ]);
    const sameSales = firstPresent(row, [
      `attributedSalesSameSku${days}d`,
      `promotedSales${days}d`,
    ]);
    const otherOrders = firstPresent(row, [`purchasesOtherSku${days}d`]);
    const otherSales = firstPresent(row, [`salesOtherSku${days}d`]);

    if (!totalOrders.present && !totalSales.present) continue;

    const resolvedSameOrders = sameOrders.present
      ? sameOrders.value
      : otherOrders.present
        ? Math.max(0, totalOrders.value - otherOrders.value)
        : 0;
    const resolvedSameSales = sameSales.present
      ? sameSales.value
      : otherSales.present
        ? Math.max(0, totalSales.value - otherSales.value)
        : 0;
    const verified = (sameOrders.present || otherOrders.present) &&
      (sameSales.present || otherSales.present);

    return {
      windowDays: days,
      totalOrders: totalOrders.value,
      totalSales: totalSales.value,
      sameSkuOrders: resolvedSameOrders,
      sameSkuSales: resolvedSameSales,
      haloOrders: Math.max(0, totalOrders.value - resolvedSameOrders),
      haloSales: Math.max(0, totalSales.value - resolvedSameSales),
      verified,
      source: verified
        ? `${sameOrders.field || otherOrders.field}+${sameSales.field || otherSales.field}`
        : 'total_only',
    };
  }

  return {
    windowDays: 0,
    totalOrders: 0,
    totalSales: 0,
    sameSkuOrders: 0,
    sameSkuSales: 0,
    haloOrders: 0,
    haloSales: 0,
    verified: false,
    source: 'missing',
  };
}

export function canonicalMatchType(raw: unknown, campaignType: unknown): string {
  const value = normalizeSearchTerm(raw).replace(/_/g, '-');
  if (['exact', 'phrase', 'broad'].includes(value)) return value;
  if (['close-match', 'loose-match', 'substitutes', 'complements', 'auto'].includes(value)) return 'auto';
  if (String(campaignType || '').toUpperCase().includes('MANUAL')) return 'broad';
  return 'auto';
}

export function aggregateSearchTerms(rows: any[]): HarvestAggregate[] {
  const aggregates = new Map<string, HarvestAggregate>();

  for (const row of rows || []) {
    const term = String(row.search_term || row.searchTerm || '').trim();
    const normalizedTerm = normalizeSearchTerm(term);
    const asin = String(row.advertised_asin || row.asin || '').trim().toUpperCase();
    if (!term || !normalizedTerm || !asin) continue;

    const key = `${asin}|${normalizedTerm}`;
    const current = aggregates.get(key) || {
      asin,
      sku: String(row.advertised_sku || row.sku || '').trim(),
      term,
      normalizedTerm,
      impressions: 0,
      clicks: 0,
      spend: 0,
      totalOrders: 0,
      totalSales: 0,
      sameSkuOrders: 0,
      sameSkuSales: 0,
      haloOrders: 0,
      haloSales: 0,
      latestDate: '',
      sourceRows: [],
      sources: [],
      attributionVerified: true,
      skuResolutionVerified: true,
    } satisfies HarvestAggregate;

    const attribution = own(row, 'same_sku_attribution_verified')
      ? {
          totalOrders: numberValue(row.total_orders ?? row.orders_7d ?? row.orders_14d ?? row.orders_30d),
          totalSales: numberValue(row.total_sales ?? row.sales_7d ?? row.sales_14d ?? row.sales_30d),
          sameSkuOrders: numberValue(row.same_sku_orders),
          sameSkuSales: numberValue(row.same_sku_sales),
          haloOrders: numberValue(row.halo_orders),
          haloSales: numberValue(row.halo_sales),
          verified: row.same_sku_attribution_verified === true,
        }
      : resolveSameSkuAttribution(row);

    current.impressions += numberValue(row.impressions);
    current.clicks += numberValue(row.clicks);
    current.spend += numberValue(row.spend ?? row.cost);
    current.totalOrders += attribution.totalOrders;
    current.totalSales += attribution.totalSales;
    current.sameSkuOrders += attribution.sameSkuOrders;
    current.sameSkuSales += attribution.sameSkuSales;
    current.haloOrders += attribution.haloOrders;
    current.haloSales += attribution.haloSales;
    current.latestDate = String(row.date || '') > current.latestDate ? String(row.date || '') : current.latestDate;
    current.attributionVerified = current.attributionVerified && attribution.verified;
    current.skuResolutionVerified = current.skuResolutionVerified &&
      !['missing', 'ambiguous'].includes(String(row.sku_resolution_status || 'resolved'));
    if (!current.sku && row.advertised_sku) current.sku = String(row.advertised_sku);
    current.sourceRows.push(row);

    const source: HarvestSource = {
      campaignId: String(row.campaign_id || ''),
      adGroupId: String(row.ad_group_id || ''),
      keywordId: String(row.keyword_id || ''),
      matchType: String(row.source_target_type || row.match_type || ''),
      campaignType: String(row.source_campaign_type || ''),
    };
    const sourceKey = `${source.campaignId}|${source.adGroupId}|${source.keywordId}|${source.matchType}`;
    if (source.campaignId && !current.sources.some((item) =>
      `${item.campaignId}|${item.adGroupId}|${item.keywordId}|${item.matchType}` === sourceKey
    )) current.sources.push(source);

    aggregates.set(key, current);
  }

  return [...aggregates.values()];
}

export function calculateSafeHarvestBid(input: {
  observedCpc: number;
  safeCpc: number;
  minBid: number;
  maxBid: number;
}): number | null {
  const minBid = Math.max(0.02, numberValue(input.minBid, 0.25));
  const maxBid = Math.max(minBid, numberValue(input.maxBid, 3));
  const safeCpc = numberValue(input.safeCpc);
  if (safeCpc < minBid) return null;
  const observed = numberValue(input.observedCpc);
  const evidenceBid = observed > 0 ? observed * 0.90 : safeCpc * 0.75;
  return Math.round(Math.min(maxBid, safeCpc, Math.max(minBid, evidenceBid)) * 100) / 100;
}

export function evaluateHarvestCandidate(input: {
  aggregate: HarvestAggregate;
  inStock: boolean;
  economicsActionable: boolean;
  breakEvenAcos: number | null;
  safeBid: number | null;
  alreadyExact: boolean;
  alreadyPromoted: boolean;
}): { eligible: boolean; reason: string; sameSkuAcos: number | null } {
  const { aggregate } = input;
  const sameSkuAcos = aggregate.sameSkuSales > 0
    ? aggregate.spend / aggregate.sameSkuSales * 100
    : null;

  if (isAsinSearchTerm(aggregate.term)) return { eligible: false, reason: 'product_target_not_keyword', sameSkuAcos };
  if (!aggregate.skuResolutionVerified || !aggregate.asin) return { eligible: false, reason: 'sku_unresolved', sameSkuAcos };
  if (!aggregate.attributionVerified) return { eligible: false, reason: 'same_sku_attribution_unavailable', sameSkuAcos };
  if (aggregate.sameSkuOrders < 1 || aggregate.sameSkuSales <= 0) return { eligible: false, reason: 'no_same_sku_sale', sameSkuAcos };
  if (!input.inStock) return { eligible: false, reason: 'out_of_stock', sameSkuAcos };
  if (!input.economicsActionable || input.safeBid == null) return { eligible: false, reason: 'unsafe_or_missing_economics', sameSkuAcos };
  if (input.breakEvenAcos && sameSkuAcos != null && sameSkuAcos >= input.breakEvenAcos) {
    return { eligible: false, reason: 'same_sku_acos_above_break_even', sameSkuAcos };
  }
  if (input.alreadyExact) return { eligible: false, reason: 'exact_keyword_already_active', sameSkuAcos };
  if (input.alreadyPromoted) return { eligible: false, reason: 'promotion_already_registered', sameSkuAcos };
  return { eligible: true, reason: 'same_sku_sale_profitable', sameSkuAcos };
}
