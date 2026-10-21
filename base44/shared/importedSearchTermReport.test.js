import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeImportedSearchTermRows, persistImportedSearchTermBatch } from './importedSearchTermReport.js';

const row = (overrides = {}) => ({
  'Data inicial': '2026-10-20', 'Data final': '2026-10-20',
  'Janela de atribuição (dias)': 7, 'ID da campanha': 'campaign-1',
  'Termo de pesquisa': 'lixeira sensor', 'Impressões': 100, 'Cliques': 5,
  'Gastos': 4.5, 'Vendas': 30, 'Pedidos': 1, 'Unidades vendidas': 2,
  ...overrides,
});

test('daily import preserves source date and writes attribution values only to declared window', async () => {
  const result = await normalizeImportedSearchTermRows([row()], { id: 'account-1', marketplace_id: 'A2Q3Y263D00KWC', country_code: 'BR', currency_code: 'BRL' }, '2026-10-21T00:00:00Z');
  assert.equal(result.ok, true);
  assert.equal(result.records[0].date, '2026-10-20');
  assert.equal(result.records[0].source_granularity, 'daily');
  assert.equal(result.records[0].sales_7d, 30);
  assert.equal(result.records[0].sales_1d, null);
  assert.equal(result.records[0].sales_14d, null);
  assert.equal(result.records[0].sales_30d, null);
  assert.equal(result.records[0].decision_eligible, false);
  assert.equal(result.records[0].import_batch_id, result.batch_id);
  assert.equal(result.records[0].same_sku_attribution_verified, false);
  assert.equal(result.records[0].marketplace_id, 'A2Q3Y263D00KWC');
  assert.equal(result.records[0].currency_code, 'BRL');
  assert.equal(result.records[0].acos, 15);
});

test('period aggregate, missing attribution window, malformed date and missing metrics fail closed', async () => {
  const aggregate = await normalizeImportedSearchTermRows([row({ 'Data inicial': '2026-10-01' })], 'a', 'now');
  const missingWindow = await normalizeImportedSearchTermRows([row({ 'Janela de atribuição (dias)': undefined })], 'a', 'now');
  const badDate = await normalizeImportedSearchTermRows([row({ 'Data inicial': 'ontem' })], 'a', 'now');
  const missingMetric = await normalizeImportedSearchTermRows([row({ Cliques: undefined })], 'a', 'now');
  assert.match(aggregate.error, /período .* agregado/);
  assert.match(missingWindow.error, /janela de atribuição explícita/);
  assert.match(badDate.error, /data inicial\/final ausente ou inválida/);
  assert.match(missingMetric.error, /métrica ausente ou inválida/);
});

test('zero is preserved as a valid metric and Brazilian decimal strings parse correctly', async () => {
  const result = await normalizeImportedSearchTermRows([row({ Cliques: 0, Gastos: 'R$ 1.234,56', Vendas: 0, Pedidos: 0 })], 'a', 'now');
  assert.equal(result.ok, true);
  assert.equal(result.records[0].clicks, 0);
  assert.equal(result.records[0].spend, 1234.56);
  assert.equal(result.records[0].sales, 0);
  assert.equal(result.records[0].acos, null);
  assert.equal(result.records[0].conversion_rate, null);
});

test('exact duplicate rows deduplicate, while conflicting duplicate identities are rejected', async () => {
  const first = row();
  const duplicate = { ...first };
  const deduped = await normalizeImportedSearchTermRows([first, duplicate], 'a', 'now');
  assert.equal(deduped.ok, true);
  assert.equal(deduped.records.length, 1);
  assert.equal(deduped.duplicates_removed, 1);
  const conflict = await normalizeImportedSearchTermRows([first, row({ Gastos: 9 })], 'a', 'now');
  assert.equal(conflict.ok, false);
  assert.match(conflict.error, /chave duplicada com valores divergentes/);
});

test('same report replay has the same import id; corrected report creates a separate immutable batch', async () => {
  const first = await normalizeImportedSearchTermRows([row()], 'a', '2026-10-21T00:00:00Z');
  const replay = await normalizeImportedSearchTermRows([row()], 'a', '2026-10-22T00:00:00Z');
  const corrected = await normalizeImportedSearchTermRows([row({ Gastos: 5 })], 'a', '2026-10-22T00:00:00Z');
  assert.equal(first.batch_id, replay.batch_id);
  assert.equal(first.records[0].unique_key, replay.records[0].unique_key);
  assert.notEqual(first.batch_id, corrected.batch_id);
  assert.notEqual(first.records[0].unique_key, corrected.records[0].unique_key);
});

test('partial persistence stays hidden and retry completes without changing the previous published batch', async () => {
  const published = await normalizeImportedSearchTermRows([row()], 'a', 'first');
  const corrected = await normalizeImportedSearchTermRows([row({ Gastos: 5 })], 'a', 'second');
  const batches = new Map([[published.batch_id, { id: published.batch_id, status: 'completed', row_count: 1 }]]);
  const rows = new Map([[published.records[0].unique_key, { ...published.records[0], id: 'old-row' }]]);
  let failNextWrite = true;
  const repository = {
    findBatch: async (id) => batches.get(id) || null,
    startBatch: async (batch) => batches.set(batch.id, { ...batch }),
    findRowsByUniqueKeys: async (keys) => keys.map((key) => rows.get(key)).filter(Boolean),
    updateRows: async (updates) => updates.forEach((item) => rows.set(item.unique_key, { ...item })),
    createRows: async (creates) => {
      if (failNextWrite) {
        failNextWrite = false;
        if (creates[0]) rows.set(creates[0].unique_key, { ...creates[0], id: 'partial-row' });
        throw new Error('simulated_write_failure');
      }
      creates.forEach((item) => rows.set(item.unique_key, { ...item, id: `row-${rows.size}` }));
    },
    completeBatch: async (id) => batches.set(id, { ...batches.get(id), status: 'completed' }),
    failBatch: async (id, error_code) => batches.set(id, { ...batches.get(id), status: 'failed', error_code }),
  };
  const input = { batch_id: corrected.batch_id, account_id: 'a', records: corrected.records, duplicates_removed: 0, started_at: 'now', completed_at: 'now' };
  await assert.rejects(persistImportedSearchTermBatch(repository, input), /simulated_write_failure/);
  assert.equal(batches.get(corrected.batch_id).status, 'failed');
  assert.equal(batches.get(published.batch_id).status, 'completed');
  assert.equal(rows.get(published.records[0].unique_key).spend, 4.5);

  const retried = await persistImportedSearchTermBatch(repository, input);
  assert.equal(retried.replayed, false);
  assert.equal(batches.get(corrected.batch_id).status, 'completed');
  assert.equal(rows.get(published.records[0].unique_key).spend, 4.5);
  assert.equal(rows.get(corrected.records[0].unique_key).spend, 5);
});

test('completed import batch replay does not touch any report rows', async () => {
  let reads = 0;
  const result = await persistImportedSearchTermBatch({
    findBatch: async () => ({ status: 'completed', row_count: 4 }),
    startBatch: async () => { throw new Error('completed batch must not be restarted'); },
    findRowsByUniqueKeys: async () => { reads++; return []; },
    updateRows: async () => {}, createRows: async () => {}, completeBatch: async () => {}, failBatch: async () => {},
  }, { batch_id: 'done', account_id: 'a', records: [{ unique_key: 'x' }], duplicates_removed: 0, started_at: 'now', completed_at: 'now' });
  assert.equal(result.replayed, true);
  assert.equal(reads, 0);
});
