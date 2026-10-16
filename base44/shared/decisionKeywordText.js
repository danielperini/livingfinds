/** Text aliases have textual provenance; identifiers never participate in resolution. */
export const KEYWORD_TEXT_FIELDS = ['keyword_text', 'keywordText', 'keyword', 'term', 'normalized_term'];
const ID_FIELDS = ['keyword_id', 'keywordId', 'amazon_keyword_id', 'target_id', 'targetId', 'campaign_id', 'campaignId', 'ad_group_id', 'adGroupId', 'entity_id'];

export function getDecisionKeywordId(row = {}) {
  const value = [row?.keyword_id, row?.keywordId, row?.amazon_keyword_id, row?.entity_type === 'keyword' ? row?.entity_id : null]
    .find(candidate => candidate != null && String(candidate).trim() !== '');
  return value == null || String(value).trim() === '' ? null : String(value).trim();
}

function humanText(value, row) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || ID_FIELDS.some(field => row?.[field] != null && String(row[field]).trim() === text)) return null;
  // Reject an explicitly formatted technical label, never a numeric customer query.
  if (/^(?:keyword(?:[\s_]?id)?|target(?:[\s_]?id)?|campaign(?:[\s_]?id)?|adgroup(?:[\s_]?id)?)\s*[:=#]?\s*\d+$/i.test(text)) return null;
  return text;
}

export function getDecisionKeywordText(row = {}) {
  for (const field of KEYWORD_TEXT_FIELDS) {
    const text = humanText(row?.[field], row);
    if (text) return text;
  }
  return null;
}

/** Customer query is separate from the targeted keyword, even in the same report. */
export function getSearchTermText(row = {}) {
  for (const field of ['search_term_original', 'search_term', 'searchTerm', 'search_term_normalized', 'normalized_search_term']) {
    const text = humanText(row?.[field], row);
    if (text) return text;
  }
  return null;
}

export function getKeywordLabel(row = {}) {
  const text = getDecisionKeywordText(row);
  if (text) return text;
  const id = getDecisionKeywordId(row);
  return id ? `Keyword ID: ${id}` : 'Texto indisponível';
}

/** Pure preparation shared by repository create/update and regression tests.
 * Partial updates preserve stored text; callers supply current identity when needed.
 * @param {Record<string, any>} payload
 * @param {Record<string, any>} current
 */
export function prepareKeywordPersistence(payload = {}, current = {}) {
  const merged = { ...current, ...payload };
  const out = { ...payload };
  const id = getDecisionKeywordId(merged);
  const hasText = KEYWORD_TEXT_FIELDS.some(field => Object.hasOwn(payload, field));
  const keywordEntity = merged.entity_type === 'keyword';
  if (id && (hasText || keywordEntity || Object.hasOwn(payload, 'keyword_id') || Object.hasOwn(payload, 'keywordId'))) out.keyword_id = id;
  if ((hasText && (id || keywordEntity || Object.hasOwn(payload, 'keyword_text') || Object.hasOwn(payload, 'keywordText'))) || (keywordEntity && id)) {
    for (const field of KEYWORD_TEXT_FIELDS) {
      if (Object.hasOwn(payload, field) && payload[field] != null && !humanText(payload[field], merged)) out[field] = null;
    }
    // A valid legacy alias can repair a contaminated canonical field.
    out.keyword_text = getDecisionKeywordText(merged);
  }
  for (const field of ['search_term', 'searchTerm', 'search_term_original', 'search_term_normalized', 'normalized_search_term']) {
    if (Object.hasOwn(payload, field) && payload[field] != null) out[field] = humanText(payload[field], merged);
  }
  return out;
}
