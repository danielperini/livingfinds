export function inventoryAvailable(item: any): number | null {
  const raw = item?.inventoryDetails?.fulfillableQuantity;
  if (raw == null || raw === '' || typeof raw === 'boolean') return null;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function nonNegativeQuantity(value: unknown): number {
  if (value == null || value === '' || typeof value === 'boolean') return 0;
  const quantity = Number(value);
  return Number.isInteger(quantity) && quantity >= 0 ? quantity : 0;
}

/** Canonical sellable and diagnostic quantities from SP-API getInventorySummaries. */
export function fbaInventorySnapshot(item: any, marketplaceId: string, observedAt: string) {
  const details = item?.inventoryDetails || {};
  return {
    fba_inventory: inventoryAvailable(item),
    available_quantity: inventoryAvailable(item),
    total_quantity: nonNegativeQuantity(item?.totalQuantity),
    reserved_inventory: nonNegativeQuantity(details?.reservedQuantity?.totalReservedQuantity),
    inbound_inventory: nonNegativeQuantity(details?.inboundWorkingQuantity)
      + nonNegativeQuantity(details?.inboundShippedQuantity)
      + nonNegativeQuantity(details?.inboundReceivingQuantity),
    unfulfillable_inventory: nonNegativeQuantity(details?.unfulfillableQuantity?.totalUnfulfillableQuantity),
    inventory_snapshot_at: observedAt,
    inventory_marketplace_id: marketplaceId,
    inventory_source: 'sp_api_getInventorySummaries',
  };
}

/** A live ad decision may proceed only after a successful inventory read and stock guard. */
export function inventoryDecisionPreflight(result: any, dryRun = false) {
  if (dryRun) return { allowed: true, reason: 'simulation_does_not_write_ads', blockedAccounts: [] as string[] };
  const rows = Array.isArray(result?.accounts) ? result.accounts : [result];
  if (!rows.length) return { allowed: false, reason: 'no_account_inventory_result', blockedAccounts: [] as string[] };
  const blockedAccounts = rows
    .filter((row: any) => row?.inventory_sync_confirmed !== true || row?.stock_guard_confirmed !== true)
    .map((row: any) => String(row?.account_id || row?.amazon_account_id || 'unknown'));
  return blockedAccounts.length
    ? { allowed: false, reason: 'fresh_inventory_or_stock_guard_not_confirmed', blockedAccounts }
    : { allowed: true, reason: 'fresh_inventory_and_stock_guard_confirmed', blockedAccounts: [] as string[] };
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
