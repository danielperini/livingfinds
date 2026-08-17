function text(value: unknown): string {
  return String(value ?? '').trim();
}

export function normalizeAsin(value: unknown): string {
  const asin = text(value).toUpperCase();
  return /^[A-Z0-9]{10}$/.test(asin) ? asin : '';
}

function campaignId(row: any): string {
  return text(row?.campaign_id || row?.amazon_campaign_id);
}

/**
 * A campaign is safe to use as an ASIN source only when every canonical source
 * agrees on exactly one advertised product. Multi-ASIN campaigns stay unresolved.
 */
export function buildCampaignAsinIndex(
  campaigns: any[] = [],
  productAds: any[] = [],
  keywords: any[] = [],
): Map<string, string> {
  const candidates = new Map<string, Set<string>>();
  const add = (idValue: unknown, asinValue: unknown) => {
    const id = text(idValue);
    const asin = normalizeAsin(asinValue);
    if (!id || !asin) return;
    if (!candidates.has(id)) candidates.set(id, new Set());
    candidates.get(id)!.add(asin);
  };

  for (const row of campaigns) add(campaignId(row), row?.asin);
  for (const row of productAds) add(campaignId(row), row?.asin);
  for (const row of keywords) add(campaignId(row), row?.asin);

  const index = new Map<string, string>();
  for (const [id, asins] of candidates) {
    if (asins.size === 1) index.set(id, [...asins][0]);
  }
  return index;
}

export function buildKeywordAsinIndex(keywords: any[] = []): Map<string, string> {
  const candidates = new Map<string, Set<string>>();
  for (const row of keywords) {
    const id = text(row?.keyword_id || row?.amazon_keyword_id);
    const asin = normalizeAsin(row?.asin);
    if (!id || !asin) continue;
    if (!candidates.has(id)) candidates.set(id, new Set());
    candidates.get(id)!.add(asin);
  }

  const index = new Map<string, string>();
  for (const [id, asins] of candidates) {
    if (asins.size === 1) index.set(id, [...asins][0]);
  }
  return index;
}

export function resolveAdsAsin(
  row: any,
  keywordAsinById: Map<string, string>,
  campaignAsinById: Map<string, string>,
): string {
  const explicit = normalizeAsin(row?.asin);
  if (explicit) return explicit;

  const keywordId = text(row?.keyword_id || row?.amazon_keyword_id || (row?.entity_type === 'keyword' ? row?.entity_id : ''));
  const fromKeyword = keywordId ? keywordAsinById.get(keywordId) : '';
  if (fromKeyword) return fromKeyword;

  const fromCampaign = campaignAsinById.get(campaignId(row));
  if (fromCampaign) return fromCampaign;

  const campaignNameMatches = text(row?.campaign_name).toUpperCase().match(/\b[A-Z0-9]{10}\b/g) || [];
  const uniqueMatches = [...new Set(campaignNameMatches.map(normalizeAsin).filter(Boolean))];
  return uniqueMatches.length === 1 ? uniqueMatches[0] : '';
}

export function normalizeNegativeMatchType(value: unknown): string {
  const normalized = text(value).toLowerCase().replace(/^negative[_-]?/, '') || 'exact';
  return `negative_${normalized === 'phrase' ? 'phrase' : 'exact'}`;
}
