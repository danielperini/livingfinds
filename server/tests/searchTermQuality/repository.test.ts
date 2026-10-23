import { EntityRepo } from '../../src/sdk/entities.ts';
import { storage } from './dbMock.ts';
function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
}
Deno.test('raw ingestion persists exclusions; default reads/get exclude them and audit retains them', async () => {
  storage.clear();
  const repo = new EntityRepo('SearchTerm');
  await repo.create({ id: 'bad', search_term: 'B0F45JG27L', amazon_account_id: 'a', campaign_id: 'c' });
  await repo.create({ id: 'good', search_term: 'lixeira 13l' });
  equal((await repo.filter()).map(row => row.id), ['good']);
  equal(await repo.get('bad'), null);
  const audit = await repo.filter({ search_term_quality_view: 'audit' });
  equal(audit[0].raw_term, 'B0F45JG27L');
  equal(audit[0].accepted, false);
  // Re-import updates the original invalid observation instead of losing it.
  await repo.update('bad', { spend: 10 });
  equal((await repo.filter({ search_term_quality_view: 'audit' }))[0].spend, 10);
});
Deno.test('all derived entity writes reject invalid terms and preserve an audit record', async () => {
  for (const entity of ['TermBank', 'KeywordSuggestion', 'NegativeKeywordSuggestion']) {
    storage.clear();
    const repo = new EntityRepo(entity);
    let rejected = false;
    try { await repo.create({ keyword: '2026', term: '2026', amazon_account_id: 'a' }); }
    catch (error) { rejected = String(error).includes('search_term_excluded'); }
    equal(rejected, true);
    equal((storage.get('search_term_quality_audit') || [])[0].data.raw_term, '2026');
    equal((await repo.filter()).length, 0);
  }
});
Deno.test('legacy invalid rows cannot be used to approve a suggestion', async () => {
  storage.clear();
  storage.set('keyword_suggestion', [{ id: 'legacy', data: { keyword: 'XZ123QW98' } }]);
  let rejected = false;
  try { await new EntityRepo('KeywordSuggestion').update('legacy', { status: 'approved' }); }
  catch { rejected = true; }
  equal(rejected, true);
});
Deno.test('sequential suggestions deduplicate by normalized text within scope and preserve raw audit', async () => {
  storage.clear();
  const repo = new EntityRepo('KeywordSuggestion');
  const first = await repo.create({ keyword: '  LIXEIRA  automática ', amazon_account_id: 'a' });
  const second = await repo.create({ keyword: 'lixeira automática', amazon_account_id: 'a' });
  equal(first.id, second.id);
  equal(first.raw_term, '  LIXEIRA  automática ');
  equal(first.keyword, 'lixeira automática');
});
