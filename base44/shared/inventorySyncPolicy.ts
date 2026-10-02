export function inventoryAvailable(item: any): number | null {
  const raw = item?.inventoryDetails?.fulfillableQuantity;
  if (raw == null || raw === '' || typeof raw === 'boolean') return null;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

export function campaignStateConfirmed(status: number, data: any, id: string): boolean {
  if (status < 200 || status >= 300) return false;
  const root = data?.campaigns;
  if ((root?.error?.length || root?.errors?.length || data?.errors?.length)) return false;
  const successes = Array.isArray(root) ? root : root?.success || [];
  return successes.some((row: any) => String(row.campaignId) === String(id)
    && (row.code == null || row.code === 'SUCCESS'));
}

export function isStockCampaignPause(campaign: any): boolean {
  const reason = String(campaign?.last_pause_reason || campaign?.pause_reason || campaign?.paused_reason || '').toLowerCase();
  return ['out_of_stock_confirmed', 'low_stock_one_unit', 'out_of_stock', 'stock_zero', 'low_stock'].includes(reason);
}
