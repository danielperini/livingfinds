export type ProductScope = {
  product: any | null;
  sku: string;
  asin: string;
  status: 'resolved' | 'missing_identity' | 'not_found' | 'ambiguous';
  identitySource: 'campaign_sku' | 'product_ad_sku' | 'unique_asin' | 'none';
};

const token = (value: unknown) => String(value ?? '').trim().toUpperCase();
const campaignId = (row: any) => String(row?.amazon_campaign_id || row?.campaign_id || row?.id || '');

export function uniqueCampaignRows(rows: any[]) {
  const latest = new Map<string, any>();
  for (const row of [...rows].sort((a, b) =>
    new Date(String(b?.updated_at || b?.synced_at || b?.created_at || 0)).getTime() -
    new Date(String(a?.updated_at || a?.synced_at || a?.created_at || 0)).getTime())) {
    const id = campaignId(row);
    if (id && !latest.has(id)) latest.set(id, row);
  }
  return [...latest.values()];
}

/** Resolve by SKU first. ASIN fallback is allowed only when it identifies one SKU. */
export function resolveProductScope(campaign: any, productAds: any[], products: any[]): ProductScope {
  const id = campaignId(campaign);
  const linkedAds = productAds.filter((row) => String(row?.campaign_id || '') === id);
  const explicitSku = token(campaign?.sku || linkedAds.find((row) => row?.sku)?.sku);
  const explicitAsin = token(campaign?.asin || linkedAds.find((row) => row?.asin)?.asin);

  if (explicitSku) {
    const matches = products.filter((row) => token(row?.sku) === explicitSku &&
      (!explicitAsin || !token(row?.asin) || token(row?.asin) === explicitAsin));
    if (matches.length === 1) return {
      product: matches[0], sku: explicitSku, asin: token(matches[0]?.asin || explicitAsin),
      status: 'resolved',
      identitySource: token(campaign?.sku) === explicitSku ? 'campaign_sku' : 'product_ad_sku',
    };
    return { product: null, sku: explicitSku, asin: explicitAsin, status: matches.length ? 'ambiguous' : 'not_found', identitySource: 'none' };
  }

  if (!explicitAsin) return { product: null, sku: '', asin: '', status: 'missing_identity', identitySource: 'none' };
  const asinMatches = products.filter((row) => token(row?.asin) === explicitAsin);
  if (asinMatches.length === 1) return {
    product: asinMatches[0], sku: token(asinMatches[0]?.sku), asin: explicitAsin,
    status: 'resolved', identitySource: 'unique_asin',
  };
  return { product: null, sku: '', asin: explicitAsin, status: asinMatches.length ? 'ambiguous' : 'not_found', identitySource: 'none' };
}

export function resolveSkuScopedRow<T extends Record<string, any>>(
  product: any,
  rows: T[],
  options: { requireFresh?: boolean; freshnessField?: string } = {},
): T | null {
  if (!product) return null;
  const sku = token(product.sku);
  const asin = token(product.asin);
  const fresh = (row: T) => !options.requireFresh ||
    row[options.freshnessField || 'data_fresh'] === true;
  if (sku) {
    const exact = rows.filter((row) => token(row.sku) === sku && fresh(row))
      .sort((a, b) => new Date(String(b.updated_at || b.created_at || 0)).getTime() -
        new Date(String(a.updated_at || a.created_at || 0)).getTime());
    if (exact.length) return exact[0];
  }
  const asinRows = rows.filter((row) => token(row.asin) === asin && fresh(row));
  const distinctSkus = new Set(asinRows.map((row) => token(row.sku)).filter(Boolean));
  if (asinRows.length === 1 && (!distinctSkus.size || distinctSkus.size === 1)) return asinRows[0];
  return null;
}

/** Campaign metrics stay campaign-scoped; never fall back to account or portfolio rows. */
export function latestMetricsByCampaign(rows: any[], date?: string) {
  const latest = new Map<string, any>();
  for (const row of [...rows].filter((item) => !date || String(item?.date || item?.spend_date || '') === date)
    .sort((a, b) => new Date(String(b?.synced_at || b?.observed_at || b?.updated_at || b?.created_at || 0)).getTime() -
      new Date(String(a?.synced_at || a?.observed_at || a?.updated_at || a?.created_at || 0)).getTime())) {
    const id = String(row?.campaign_id || '');
    if (id && !latest.has(id)) latest.set(id, row);
  }
  return latest;
}

/** Account budget is a single hard spend cap. It is never apportioned to campaigns. */
export function resolveAccountHardCap(cap: number, confirmedSpend: number, pendingSpend = 0) {
  const hardCap = Math.max(0, Number(cap) || 0);
  const committed = Math.max(0, Number(confirmedSpend) || 0) + Math.max(0, Number(pendingSpend) || 0);
  return {
    hardCap,
    committedSpend: Math.round(committed * 100) / 100,
    remaining: Math.round(Math.max(0, hardCap - committed) * 100) / 100,
    reached: hardCap > 0 && committed >= hardCap,
    scope: 'account_global_hard_cap' as const,
  };
}

/** A daypart learned from one campaign is never reused for another campaign/SKU. */
export function selectCampaignHourEvidence(params: {
  decisions: any[];
  patterns: any[];
  campaignId: string;
  sku: string;
  dayOfWeek: number;
  hour: number;
}) {
  const { decisions, patterns, campaignId: id, sku, dayOfWeek, hour } = params;
  const exactDecisions = decisions.filter((row) =>
    String(row.campaign_id || '') === id &&
    Number(row.day_of_week) === dayOfWeek && Number(row.hour) === hour &&
    (!sku || !row.sku || token(row.sku) === token(sku)) &&
    !row.canonical_audit_only);
  const learnedDecision = exactDecisions.sort((a, b) =>
    new Date(String(b.updated_at || b.created_at || 0)).getTime() -
    new Date(String(a.updated_at || a.created_at || 0)).getTime())[0] || null;
  const exactPatterns = patterns.filter((row) =>
    token(row.sku) === token(sku) && token(sku) !== '' &&
    Number(row.day_of_week) === dayOfWeek && Number(row.hour) === hour &&
    !(Number(row.hour) === 0 && Number(row.occurrences || 0) > 24 && !row.sku));
  const pattern = exactPatterns.sort((a, b) =>
    new Date(String(b.updated_at || b.created_at || 0)).getTime() -
    new Date(String(a.updated_at || a.created_at || 0)).getTime())[0] || null;
  if (learnedDecision && (!pattern || new Date(String(learnedDecision.updated_at || learnedDecision.created_at || 0)).getTime() >=
    new Date(String(pattern.updated_at || pattern.created_at || 0)).getTime())) {
    return { row: learnedDecision, source: 'campaign_decision' as const };
  }
  if (pattern) return { row: pattern, source: 'sku_pattern' as const };
  return { row: null, source: 'no_campaign_or_sku_history' as const };
}
