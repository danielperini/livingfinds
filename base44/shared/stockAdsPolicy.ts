export const MIN_ADVERTISING_STOCK = 1;

export function availableAdsStock(product: any): number {
  if (product?.status === 'archived' || product?.catalog_sync_status === 'duplicate') return -1;
  // User-selected inventory policy: use only the catalog's available FBA balance.
  // Offer buyability is verified separately; inventory alone never proves it.
  if (['mapping_conflict', 'invalid_inventory', 'not_found'].includes(product?.catalog_sync_status)) return -1;
  const raw = product?.fba_inventory;
  if (raw === null || raw === undefined || raw === '' || typeof raw === 'boolean') return -1;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : -1;
}

export function hasFreshAdsInventory(product: any, now = Date.now()): boolean {
  const age = now - Date.parse(product?.last_catalog_sync_at || '');
  return product?.catalog_sync_status === 'success' && Number.isFinite(age)
    && age >= 0 && age <= 30 * 60_000 && availableAdsStock(product) >= 0;
}

export function stockAdsDecision(product: any): 'pause' | 'activate' | 'unknown' {
  const quantity = availableAdsStock(product);
  if (quantity < 0) return 'unknown';
  return quantity < MIN_ADVERTISING_STOCK ? 'pause' : 'activate';
}
