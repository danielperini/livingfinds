const LIST_PATHS = new Set([
  '/sp/campaigns/list', '/sp/adGroups/list', '/sp/productAds/list',
  '/sp/keywords/list', '/sp/negativeKeywords/list', '/sp/targets/list',
]);
const ID_FILTERS = ['campaignIdFilter', 'adGroupIdFilter', 'adIdFilter', 'keywordIdFilter', 'targetIdFilter'];

/** SP v3 ID filters are objects, unlike legacy callers that pass plain arrays. */
export function normalizeSpListFilters(path: string, method: string, payload: any): any {
  if (method !== 'POST' || !LIST_PATHS.has(path) || !payload || Array.isArray(payload)) return payload;
  const normalized = { ...payload };
  for (const key of ID_FILTERS) {
    if (Array.isArray(payload[key])) normalized[key] = { include: [...payload[key]] };
  }
  return normalized;
}
