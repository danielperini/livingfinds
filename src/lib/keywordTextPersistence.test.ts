import assert from 'node:assert/strict';
import { sql } from '../../server/src/db.ts';
import { EntityRepo } from '../../server/src/sdk/entities.ts';
import * as entities from '../../server/src/sdk/entities.ts';

Deno.test('repository: create, bulk, partial update and atomic decisions keep keyword text separate', async () => {
  const id = '250430582474108';
  const records = new Map<string, any>();
  const original = sql.unsafe;
  const unsafe = (query: string, values: any[] = []) => {
    if (/^\s*(CREATE|create|select pg_advisory)/.test(query)) return Promise.resolve([]);
    if (/^\s*SELECT/.test(query) && query.includes('FROM "keyword"')) return Promise.resolve([{ id: 'local-keyword', data: { amazon_account_id: 'test-account', keyword_id: id, keyword: 'known text 220' } }]);
    if (/^\s*SELECT/.test(query)) return Promise.resolve(records.has(values[0]) ? [records.get(values[0])] : []);
    if (/^\s*select/.test(query)) return Promise.resolve([]);
    if (/^\s*INSERT/.test(query)) {
      const row = { id: values[0], data: values[2] };
      records.set(row.id, row);
      return Promise.resolve([row]);
    }
    if (/^\s*UPDATE/.test(query)) {
      const row = records.get(values[0]);
      row.data = { ...row.data, ...values[1] };
      return Promise.resolve([row]);
    }
    if (/^\s*insert/i.test(query)) {
      const data = values.find(value => value && typeof value === 'object' && value.keyword_id);
      return Promise.resolve([{ id: 'atomic', data }]);
    }
    throw new Error(`Unexpected query: ${query.slice(0, 100)}`);
  };
  (sql as any).unsafe = unsafe;
  try {
    const repo = new EntityRepo('OptimizationDecision', 'keyword_text_test_only');
    const created = await repo.create({ id: 'one', entity_type: 'keyword', entity_id: id, keyword: 'lixeira 20L' });
    assert.equal(created.keyword_id, id);
    assert.equal(records.get('one').data.keyword_text, 'lixeira 20L');
    const [invalid] = await repo.bulkCreate([{ id: 'two', keyword_id: id, keyword_text: id }]);
    assert.equal(invalid.keyword_text, null);
    assert.equal(invalid.keyword_id, id);
    await repo.update('two', { keyword_text: '220' });
    assert.equal(records.get('two').data.keyword_text, '220');
    await repo.update('two', { keyword_text: id });
    assert.equal(records.get('two').data.keyword_text, null);
    await repo.update('one', { status: 'executed' });
    assert.equal(records.get('one').data.keyword_text, 'lixeira 20L');
    const query = await repo.create({ id: 'query', keyword_id: id, keyword_text: 'target phrase', searchTerm: id });
    assert.equal(query.searchTerm, null);
    assert.equal(query.keyword_text, 'target phrase');
    records.set('historical', { id: 'historical', data: { keyword_id: id, keyword_text: id, keyword: 'old phrase' } });
    assert.equal((await repo.get('historical'))?.keyword_text, 'old phrase');
    assert.equal(records.get('historical').data.keyword_text, id); // read does not rewrite historical data
    const enriched = await repo.create({ id: 'enriched', amazon_account_id: 'test-account', keyword_id: id });
    assert.equal(enriched.keyword_text, 'known text 220');
    const client = { begin: async (fn: any) => await fn({ unsafe }) };
    const atomicCreate = (entities as any).createOptimizationDecisionIdempotentWithSql;
    if (atomicCreate) {
    const atomic = await atomicCreate(client, 'keyword_text_test_only', {
      amazon_account_id: 'test-account', idempotency_key: 'test-key', entity_type: 'keyword', entity_id: id,
      keyword_id: id, keyword: 'café 220V', decision_type: 'bid_change', action: 'set_bid',
      cycle_key: 'test-cycle', rule_key: 'test-rule',
    });
    assert.equal(atomic.decision?.keyword_id, id);
    assert.equal(atomic.decision?.keyword_text, 'café 220V');
    }
  } finally {
    (sql as any).unsafe = original;
  }
});
