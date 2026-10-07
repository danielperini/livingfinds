import test from 'node:test';
import assert from 'node:assert/strict';
import { visibleCatalogProducts, catalogStockStatus, catalogStockFreshness, loadAccountProducts } from './productCatalogVisibility.js';

test('microphone with FBA stock appears despite inactive merchant offer; zero-stock products remain visible', () => {
  const microphone = { id: 'mic', sku: 'FBA-0122', asin: 'B0HLMF8PPD', status: 'inactive', fba_inventory: 20, available_quantity: 0 };
  const empty = { id: 'empty', sku: 'empty', fba_inventory: 0 };
  assert.deepEqual(visibleCatalogProducts([microphone, empty]), [microphone, empty]);
  assert.equal(catalogStockStatus(microphone), 'active');
  assert.equal(catalogStockStatus(empty), 'out_of_stock');
  assert.equal(catalogStockStatus({ fba_inventory: null }), 'unknown');
});

test('deduplication retains distinct SKUs/accounts and the freshest balance instead of the largest', () => {
  const old = { sku: 'A', asin: 'same', amazon_account_id: 'one', fba_inventory: 99, last_catalog_sync_at: '2026-10-01' };
  const fresh = { ...old, fba_inventory: 0, last_catalog_sync_at: '2026-10-07' };
  const otherSku = { ...fresh, sku: 'B' };
  const otherAccount = { ...fresh, amazon_account_id: 'two' };
  assert.deepEqual(visibleCatalogProducts([old, fresh, otherSku, otherAccount, { ...fresh, sku: 'archived', status: 'archived' }]), [fresh, otherSku, otherAccount]);
});

test('freshness uses catalog sync and never arbitrary product updates', () => {
  const now = Date.parse('2026-10-07T12:00:00Z');
  assert.equal(catalogStockFreshness({ last_catalog_sync_at: '2026-10-07T11:00:00Z', last_sync_at: '2026-01-01' }, now), 'fresh');
  assert.equal(catalogStockFreshness({ updated_date: '2026-10-07T11:00:00Z' }, now), 'unknown');
});

test('loads products past the first 500 records', async () => {
  const data = Array.from({ length: 501 }, (_, id) => ({ id }));
  const entity = { filter: async (_query, _sort, limit, offset) => data.slice(offset, offset + limit) };
  assert.equal((await loadAccountProducts(entity, 'account')).length, 501);
});
