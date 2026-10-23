import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessSearchTerm, annotateSearchTerm, readQualityPage, uniqueSearchTerms } from './searchTermQuality.js';
for (const term of ['', '12345', '2026', '!!!', 'B0F45JG27L', 'B0CYNX7FZY', 'B0GKWZLCVH', 'XZ123QW98', 'a1', 'sku_123456', 'bcdfgh']) {
  test(`excludes ${JSON.stringify(term)}`, () => assert.equal(assessSearchTerm(term).accepted, false));
}
for (const term of ['lixeira automatica', 'lixeira automatica 13l', 'banheiro 15 litros', 'lixo cozinha 20 litros', 'ventilador 60w', 'lixeira automática', 'porta-retrato']) {
  test(`preserves ${term}`, () => assert.equal(assessSearchTerm(term).accepted, true));
}
test('normalization preserves accents, raw audit and scoped metadata', () => {
  const row = annotateSearchTerm({ search_term: '  LIXEIRA  automática ', campaign_id: 'c', amazon_account_id: 'a' }, 'report');
  assert.equal(row.raw_term, '  LIXEIRA  automática ');
  assert.equal(row.normalized_term, 'lixeira automática');
  assert.equal(row.source, 'report');
  assert.equal(row.campaign_id, 'c');
  assert.equal(row.amazon_account_id, 'a');
  assert.equal(row.exclusion_reason, null);
});
test('normalized suggestions are unique without deleting raw metric observations', () => {
  assert.equal(uniqueSearchTerms([' Lixeira  automática ', 'lixeira automática', '2026']).length, 1);
});
test('pagination scans excluded pages and applies accepted offset; audit retains raw rows', async () => {
  const rows = [...Array.from({ length: 501 }, () => assessSearchTerm('123')), assessSearchTerm('lixeira'), assessSearchTerm('banheiro')];
  const fetch = async (limit, offset) => rows.slice(offset, offset + limit);
  assert.equal((await readQualityPage(fetch, { limit: 1, offset: 1 }))[0].normalized_term, 'banheiro');
  assert.equal((await readQualityPage(fetch, { limit: 1, audit: true }))[0].raw_term, '123');
});
test('caller-supplied audit metadata cannot disguise a technical identifier', () => {
  assert.equal(annotateSearchTerm({ search_term: 'B0F45JG27L', raw_term: 'lixeira', accepted: true }, 'report').accepted, false);
});
test('empty keyword_text falls back to keyword; an explicitly empty query never uses targeting text', () => {
  assert.equal(annotateSearchTerm({ keyword_text: '', keyword: 'lixeira' }, 'Keyword').accepted, true);
  assert.equal(annotateSearchTerm({ search_term: '', keyword_text: 'lixeira' }, 'SearchTerm').accepted, false);
});
