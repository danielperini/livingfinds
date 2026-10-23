/** Deterministic lexical heuristic, not a dictionary or a claim of commercial performance. */
export function assessSearchTerm(value, context = {}) {
  const raw_term = String(value ?? '');
  const normalized_term = raw_term.normalize('NFC').toLocaleLowerCase('pt-BR').trim().replace(/\s+/gu, ' ');
  const letters = normalized_term.match(/\p{L}/gu) || [];
  const tokens = normalized_term.split(/[\s\p{P}\p{S}]+/u).filter(Boolean);
  const identifier = /^(?:b0[a-z0-9]{8}|[a-f0-9]{16,}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i;
  const stop = new Set(['de', 'da', 'do', 'das', 'dos', 'em', 'na', 'no', 'com', 'para', 'por', 'sem']);
  const word = tokens.some(t => /^\p{L}{2,}$/u.test(t) && !stop.has(t) &&
    /[aeiouáéíóúâêôãõàü]/u.test(t) && !/^(.)\1+$/u.test(t));
  let exclusion_reason = null;
  if (!normalized_term) exclusion_reason = 'empty';
  else if (/^\d+(?:[\s.,-]\d+)*$/u.test(normalized_term)) exclusion_reason = 'numbers_only';
  else if (!letters.length) exclusion_reason = 'symbols_only';
  else if (identifier.test(normalized_term) || /^(?:sku|asin|id|uuid|campaign|adgroup)[_:=]/i.test(normalized_term)) exclusion_reason = 'technical_identifier';
  else if (letters.length < 2) exclusion_reason = 'too_few_letters';
  else if (!word) exclusion_reason = 'no_meaningful_word';
  return { raw_term, normalized_term, accepted: exclusion_reason === null, exclusion_reason,
    source: context.source || 'unknown', campaign_id: context.campaign_id || null,
    amazon_account_id: context.amazon_account_id || null };
}

export const QUALITY_ENTITIES = new Set(['SearchTerm', 'Keyword', 'KeywordSuggestion', 'NegativeKeywordSuggestion', 'TermBank', 'ImportedSearchTermReportRow']);
export function termValue(row) {
  if ('search_term' in row) return row.search_term;
  if ('searchTerm' in row) return row.searchTerm;
  return row.keyword_text || row.keyword || row.term || '';
}
export function annotateSearchTerm(row, source) {
  const quality = assessSearchTerm(termValue(row), { ...row, source: row.source || source });
  return { ...row, ...quality, raw_term: row.raw_term ?? quality.raw_term };
}

/** Filter before slicing so an excluded page never signals end-of-data. */
/** @param {(limit: number, offset: number) => Promise<any[]>} fetchPage
 * @param {{limit?: number, offset?: number, audit?: boolean}} options */
export async function readQualityPage(fetchPage, { limit, offset = 0, audit = false } = {}) {
  offset = Math.max(0, Math.floor(offset));
  if (limit !== undefined) limit = Math.max(0, Math.floor(limit));
  const result = [];
  const target = limit === undefined ? Infinity : offset + limit;
  if (target === 0) return [];
  for (let cursor = 0; ; cursor += 500) {
    const page = await fetchPage(500, cursor);
    for (const row of page) if (audit || row.accepted) result.push(row);
    if (page.length < 500 || result.length >= target) break;
  }
  return result.slice(offset, limit === undefined ? undefined : offset + limit);
}

/** Only deduplicate a list of phrases, never daily metric observations. */
export function uniqueSearchTerms(values) {
  const seen = new Set();
  return values.map(value => assessSearchTerm(value)).filter(row => {
    if (!row.accepted || seen.has(row.normalized_term)) return false;
    seen.add(row.normalized_term);
    return true;
  });
}
