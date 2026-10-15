import { loadSearchTermHarvestEvidence } from './searchTermHarvestEvidence.ts';
import { createEmptyHarvestMemo } from './emptyHarvestMemo.ts';

const names = ['SearchTerm', 'Campaign', 'Product', 'ProductEconomics', 'DailyProductAdsAssessment', 'PerformanceSettings', 'Keyword', 'SearchTermPromotion', 'TermBank', 'KeywordBank', 'ProductAd'];
const window = { startDate: '2026-09-16', endDate: '2026-10-15', assessmentStart: '2026-10-14' };
const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
const emptyEntities = () => Object.fromEntries(names.map(name => [name, { filter: async (..._args: any[]) => [] as any[] }]));

Deno.test('harvest applies report and daily assessment windows in the database; current identities remain available', async () => {
  const entities = emptyEntities();
  const calls: Record<string, any[]> = {};
  for (const name of names) entities[name].filter = async (...args) => { calls[name] = args; return []; };
  await loadSearchTermHarvestEvidence(entities, 'account-a', window);
  for (const name of names) assert(calls[name][0].amazon_account_id === 'account-a', `Missing account scope: ${name}`);
  assert(JSON.stringify(calls.SearchTerm[0].date) === JSON.stringify({ $gte: window.startDate, $lte: window.endDate }), 'Unbounded report history');
  assert(JSON.stringify(calls.DailyProductAdsAssessment[0].assessment_date) === JSON.stringify({ $gte: window.assessmentStart, $lte: window.endDate }), 'Stale daily assessment');
  assert(Object.keys(calls.Campaign[0]).length === 1, 'Unchanged current campaign hidden by a historical date filter');
  assert(calls.PerformanceSettings[2] === 1, 'Reads unnecessary settings history');
});

Deno.test('harvest consumes more than the old 20000-row cap without silently truncating', async () => {
  const entities = emptyEntities();
  let requests = 0;
  entities.SearchTerm.filter = async (_query, sort, limit, offset) => {
    assert(typeof sort === 'string', 'Pagination sort contract broken');
    requests++;
    return Array.from({ length: Math.max(0, Math.min(limit, 20001 - offset)) }, (_, i) => ({ id: `term-${offset + i}` }));
  };
  const data = await loadSearchTermHarvestEvidence(entities, 'a', window);
  assert(data.searchTerms.length === 20001 && requests === 21, 'Incomplete evidence treated as complete');
});

Deno.test('failure in every required source blocks harvest and hides unsafe database diagnostics', async () => {
  for (const name of names) {
    const entities = emptyEntities();
    entities[name].filter = async () => { throw new Error('unsafe row payload'); };
    let error = '';
    try { await loadSearchTermHarvestEvidence(entities, 'a', window); } catch (e) { error = String(e); }
    assert(error.includes(`harvest_evidence_incomplete:${name}`), `Failure swallowed: ${name}`);
    assert(!error.includes('unsafe row payload'), 'Leaked raw database diagnostic');
  }
});

Deno.test('late page failure never becomes an empty successful harvest or a memoized result', async () => {
  const entities = emptyEntities();
  let calls = 0;
  entities.SearchTerm.filter = async (_q, _sort, _limit, offset) => {
    calls++;
    if (offset) throw new Error('second page unavailable');
    return Array.from({ length: 1000 }, (_, i) => ({ id: String(i) }));
  };
  const memo = createEmptyHarvestMemo();
  let downstream = 0;
  for (let i = 0; i < 2; i++) {
    let failed = false;
    try {
      await memo({ amazon_account_id: 'a' }, async () => {
        await loadSearchTermHarvestEvidence(entities, 'a', window);
        downstream++;
        return { ok: true };
      });
    } catch { failed = true; }
    assert(failed, 'Failure converted to an empty success');
  }
  assert(calls === 4 && downstream === 0, 'Repeated failure was cached or allowed downstream decisions');
});

Deno.test('repeated pages block evidence and duplicate identifiers are not double-counted', async () => {
  const entities = emptyEntities();
  const page = Array.from({ length: 1000 }, (_, i) => ({ id: String(i) }));
  entities.Keyword.filter = async () => page;
  let error = '';
  try { await loadSearchTermHarvestEvidence(entities, 'a', window); } catch (e) { error = String(e); }
  assert(error.includes('harvest_evidence_incomplete:Keyword'), 'Repeated page accepted');
  entities.Keyword.filter = async (_q, _sort, _limit, offset) => offset ? [{ id: '999' }, { id: '1000' }] : page;
  const data = await loadSearchTermHarvestEvidence(entities, 'a', window);
  assert(data.keywords.length === 1001, 'Counted duplicate identifier twice');
});
