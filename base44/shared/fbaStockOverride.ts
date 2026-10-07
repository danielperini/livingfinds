/** Explicit seller confirmation, bounded in time and separate from Amazon inventory. */
export function confirmedFbaOverride(product: any, now = Date.now()): number | null {
  const record = product?.fba_stock_override;
  const quantity = record?.quantity;
  const confirmed = Date.parse(record?.confirmed_at || '');
  const expires = Date.parse(record?.expires_at || '');
  if (record?.source !== 'seller_confirmed' || !Number.isInteger(quantity) || quantity < 0
    || !Number.isFinite(confirmed) || !Number.isFinite(expires)
    || confirmed > now || expires <= now || expires - confirmed > 24 * 3600000) return null;
  return quantity;
}
