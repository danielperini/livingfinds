export function catalogSyncTime(product) {
  return Date.parse(product.last_catalog_sync_at || product.synced_at || product.last_sync_at || '') || 0;
}

export function visibleCatalogProducts(products) {
  const records = new Map();
  for (const product of products) {
    if (String(product.status).toLowerCase() === 'archived' || product.catalog_sync_status === 'duplicate') continue;
    const identity = product.sku ? `sku:${product.sku.trim().toLowerCase()}` : `asin:${product.asin || product.id}`;
    const key = `${product.amazon_account_id || ''}:${identity}`;
    const previous = records.get(key);
    if (!previous || catalogSyncTime(product) > catalogSyncTime(previous)) records.set(key, product);
  }
  return [...records.values()];
}

export function catalogStockStatus(product) {
  if (product.status === 'archived') return 'archived';
  const raw = product.fba_inventory ?? product.available_quantity;
  if (raw == null || raw === '' || typeof raw === 'boolean') return 'unknown';
  const quantity = Number(raw);
  if (!Number.isInteger(quantity) || quantity < 0) return 'unknown';
  return quantity === 0 ? 'out_of_stock' : quantity <= 5 ? 'low_stock' : 'active';
}

export function catalogStockFreshness(product, now = Date.now()) {
  const synced = catalogSyncTime(product);
  if (!synced) return 'unknown';
  const age = now - synced;
  return age >= 0 && age <= 24 * 3600000 ? 'fresh' : 'stale';
}

export async function loadAccountProducts(entity, accountId) {
  const result = [];
  const seen = new Set();
  const limit = 500;
  for (let offset = 0; ; offset += limit) {
    const batch = await entity.filter({ amazon_account_id: accountId }, 'id', limit, offset);
    for (const product of batch) {
      if (seen.has(product.id)) throw new Error('O catálogo mudou durante a leitura. Atualize a lista novamente.');
      seen.add(product.id);
    }
    result.push(...batch);
    if (batch.length < limit) return result;
  }
}
