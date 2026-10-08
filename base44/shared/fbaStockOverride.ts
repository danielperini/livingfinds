/** Explicit seller confirmation, bounded in time and separate from Amazon inventory. */
export function confirmedFbaOverride(product: any, now = Date.now()): number | null {
  const record = product?.fba_stock_override;
  const quantity = record?.quantity;
  const confirmed = Date.parse(record?.confirmed_at || '');
  const expires = Date.parse(record?.expires_at || '');
  if (record?.source !== 'seller_confirmed' || !Number.isInteger(quantity) || quantity < 0
    || !Number.isFinite(confirmed) || !Number.isFinite(expires)
    || confirmed > now || expires <= now || expires - confirmed > 24 * 3600000) return null;
  const apiAt = Date.parse(product?.last_catalog_sync_at || '');
  const apiQuantity = product?.fba_inventory;
  if (product?.catalog_sync_status === 'success' && Number.isFinite(apiAt) && apiAt > confirmed && apiAt <= now
    && apiQuantity !== null && apiQuantity !== undefined && apiQuantity !== '' && typeof apiQuantity !== 'boolean'
    && Number.isInteger(Number(apiQuantity)) && Number(apiQuantity) >= 0) return null;
  return quantity;
}
