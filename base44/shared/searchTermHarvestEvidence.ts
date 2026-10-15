import { readAllEntityPages } from './v6siaEvidencePaging.ts';

type Entities = Record<string, { filter: (...args: any[]) => Promise<any> }>;

// The report window is essential conversion evidence, not an unrestricted
// history scan. Current identities/destinations must remain complete to prevent
// duplicates; a missing page must never mean "no existing manual campaign".
export async function loadSearchTermHarvestEvidence(
  entities: Entities,
  accountId: string,
  window: { startDate: string; endDate: string; assessmentStart: string },
) {
  const account = { amazon_account_id: accountId };
  const read = async (name: string, query: Record<string, unknown>, sort: string) => {
    const result = await readAllEntityPages(entities[name], query, sort);
    if (!result.complete || !result.rows) {
      // Do not propagate database diagnostics that may contain row payloads.
      throw new Error(`harvest_evidence_incomplete:${name}:account=${accountId}`);
    }
    return result.rows as Record<string, any>[];
  };
  const [searchTerms, campaigns, products, economics, assessments, settingsRows, keywords, promotions, termBank, keywordBank, productAds] = await Promise.all([
    read('SearchTerm', { ...account, date: { $gte: window.startDate, $lte: window.endDate } }, '-date'),
    read('Campaign', account, '-updated_at'),
    read('Product', account, '-updated_at'),
    read('ProductEconomics', account, '-updated_at'),
    read('DailyProductAdsAssessment', { ...account, assessment_date: { $gte: window.assessmentStart, $lte: window.endDate } }, '-assessment_date'),
    // Only the latest settings row is semantically used, so this is not pagination.
    entities.PerformanceSettings.filter(account, '-updated_at', 1).catch(() => {
      throw new Error('harvest_evidence_incomplete:PerformanceSettings');
    }),
    read('Keyword', account, '-updated_at'),
    read('SearchTermPromotion', account, '-updated_at'),
    read('TermBank', account, '-updated_at'),
    read('KeywordBank', account, '-last_updated_at'),
    read('ProductAd', account, '-synced_at'),
  ]);
  if (!Array.isArray(settingsRows)) throw new Error('harvest_evidence_incomplete:PerformanceSettings');
  return { searchTerms, campaigns, products, economics, assessments, settingsRows, keywords, promotions, termBank, keywordBank, productAds };
}
