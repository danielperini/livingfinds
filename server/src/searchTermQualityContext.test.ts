import { recordTermQualityRead, withTermQualityRun } from './searchTermQualityContext.ts';
const assert = (ok: boolean) => { if (!ok) throw new Error('Assertion failed'); };
Deno.test('nested reads count exclusions once and preserve response outcome', async () => {
  const summaries: any[] = [];
  const response = await withTermQualityRun(async () => {
    recordTermQualityRead('SearchTerm', [{ id: 'bad', accepted: false }]);
    return await withTermQualityRun(async () => {
      recordTermQualityRead('SearchTerm', [{ id: 'bad', accepted: false }]);
      return Response.json({ ok: true, decisions: [] });
    }, async () => { throw new Error('nested audit must use parent'); });
  }, async summary => { summaries.push(summary); });
  const body = await response.json();
  assert(body.ok && body.term_validation_outcome === 'invalid_terms_filtered');
  assert(summaries.length === 1 && summaries[0].filtered_count === 1);
});
Deno.test('concurrent runs keep account counters isolated', async () => {
  const summaries: any[] = [];
  await Promise.all([1, 2].map(count => withTermQualityRun(async () => {
    for (let id = 0; id < count; id++) recordTermQualityRead('SearchTerm', [{ id, accepted: false }]);
    await Promise.resolve();
    return Response.json({ ok: true });
  }, async summary => { summaries.push(summary.filtered_count); })));
  assert(summaries.sort().join(',') === '1,2');
});
