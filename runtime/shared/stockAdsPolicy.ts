export const MIN_ADVERTISING_STOCK = 2;

export function availableAdsStock(product: any): number {
  const raw = product?.available_quantity ?? product?.fba_inventory;
  if (raw === null || raw === undefined || raw === '') return -1;
  const value = Number(raw);
  return Number.isFinite(value) ? value : -1;
}

export function stockAdsDecision(product: any): 'pause' | 'activate' | 'unknown' {
  const quantity = availableAdsStock(product);
  if (quantity < 0) return 'unknown';
  return quantity < MIN_ADVERTISING_STOCK ? 'pause' : 'activate';
}
