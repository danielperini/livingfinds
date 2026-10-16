import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveMotorDecisionTitle } from './motorDecisionTitle.js';
import { buildHistoryCsv } from './motorHistoryCsv.js';
import { getDecisionKeywordId, getDecisionKeywordText, getSearchTermText, prepareKeywordPersistence } from '../../base44/shared/decisionKeywordText.js';

const id = '250430582474108';
for (const [name, row, expected] of [
  ['canonical text and ID', { keyword_text: 'café portátil', keyword_id: id }, 'café portátil'],
  ['text only', { keyword_text: 'lixeira' }, 'lixeira'],
  ['camelCase text', { keywordText: 'tubo' }, 'tubo'],
  ['legacy keyword', { keyword: '220V' }, '220V'],
  ['term', { term: 'tubo 20 mm' }, 'tubo 20 mm'],
  ['normalized term', { normalized_term: 'ação portátil' }, 'ação portátil'],
  ['ID only', { keyword_id: id }, null],
  ['numeric query', { keyword_id: id, keyword_text: '220' }, '220'],
  ['long numeric customer query without ID provenance', { keyword_text: id }, id],
  ['contaminated canonical with valid legacy alias', { keyword_id: id, keyword_text: id, keyword: 'café' }, 'café'],
  ['incomplete historical row', {}, null],
]) {
  test(name, () => assert.equal(getDecisionKeywordText(row), expected));
}

test('every technical identifier stays separate from all text aliases', () => {
  for (const key of ['keyword_id', 'keywordId', 'amazon_keyword_id', 'entity_id']) {
    for (const field of ['keyword_text', 'keywordText', 'keyword', 'term', 'normalized_term']) {
      assert.equal(getDecisionKeywordText({ entity_type: 'keyword', [key]: id, [field]: id }), null);
      assert.equal(getDecisionKeywordText({ entity_type: 'keyword', [key]: id, [field]: Number(id) }), null);
    }
  }
  for (const text of [`Keyword ${id}`, `Keyword ID: ${id}`, `keywordId=${id}`]) {
    assert.equal(getDecisionKeywordText({ keyword_text: text }), null);
  }
  assert.equal(getDecisionKeywordText({ entity_type: 'keyword', entity_name: 'unverified name' }), null);
});

test('query provenance never falls back to keyword ID or targeted keyword text', () => {
  assert.equal(getSearchTermText({ keyword_id: id }), null);
  assert.equal(getSearchTermText({ keyword_id: id, searchTerm: id }), null);
  assert.equal(getSearchTermText({ keywordText: 'targeted phrase' }), null);
  assert.equal(getSearchTermText({ keyword_id: id, keyword_text: 'targeted phrase', searchTerm: 'customer query 220' }), 'customer query 220');
  assert.equal(getSearchTermText({ searchTerm: '220' }), '220');
  assert.equal(prepareKeywordPersistence({ keyword_id: id, searchTerm: id }).searchTerm, null);
});

test('explicit ID labels for incomplete and contaminated historical records', () => {
  for (const row of [{ keyword_id: id }, { keywordId: id }, { entity_type: 'keyword', entity_id: id }, { keyword_id: id, keyword_text: id, entity_name: id, campaign_name: 'Manual' }]) {
    assert.equal(deriveMotorDecisionTitle(row), `Keyword ID: ${id}`);
  }
  assert.equal(deriveMotorDecisionTitle({ keyword: 'texto real', keyword_id: id }), 'texto real');
  assert.equal(deriveMotorDecisionTitle({ asin: 'B012345678' }), 'B012345678');
  assert.equal(deriveMotorDecisionTitle({ entity_type: 'campaign', entity_name: 'AUTO' }), 'AUTO');
  assert.equal(deriveMotorDecisionTitle({}), 'Decisão do motor');
});

test('production CSV exports resolved human text and separate technical ID', () => {
  const rows = [
    { keyword_id: id, keyword_text: id, keyword: 'texto "real"; 220V' },
    { keywordId: '156910507571616', normalized_term: 'termo antigo' },
    { keyword_id: id },
  ];
  const csv = buildHistoryCsv(rows.map(raw => ({ raw, timestamp: '2026-10-16', source: 'test' })));
  assert.ok(csv.includes('"keyword_id";"keyword_text"'));
  assert.ok(csv.includes(`"${id}";"texto ""real""; 220V"`));
  assert.ok(csv.includes('"156910507571616";"termo antigo"'));
  assert.ok(csv.includes(`"Keyword ID: ${id}"`));
  assert.ok(csv.includes(`"${id}";;`));
  assert.ok(!csv.includes(`"${id}";"${id}"`));
});

test('OptimizationDecision preparation preserves identity and canonical text', () => {
  const row = prepareKeywordPersistence({ entity_type: 'keyword', entity_id: id, keyword: 'lixeira 20L', action: 'set_bid' });
  assert.equal(row.keyword_id, id);
  assert.equal(row.keyword_text, 'lixeira 20L');
  assert.equal(row.action, 'set_bid');
  assert.equal(getDecisionKeywordId(row), id);
  const invalid = prepareKeywordPersistence({ keyword_id: id, keyword_text: id });
  assert.equal(invalid.keyword_id, id);
  assert.equal(invalid.keyword_text, null);
  assert.deepEqual(prepareKeywordPersistence({ status: 'executed' }), { status: 'executed' });
  assert.equal(prepareKeywordPersistence({ keyword_text: id }, { keyword_id: id, keyword: 'legacy valid' }).keyword_text, 'legacy valid');
});
