export function canonicalSkuRecord(rows: any[], asin: string): any | null {
  const active = rows.filter(p => p.status !== 'archived');
  if (!active.length || active.some(p => String(p.asin || '').toUpperCase() !== asin.toUpperCase())) return null;
  return [...active].sort((a,b) => Number(b.cost_confirmed === true)-Number(a.cost_confirmed === true)
    || Number(b.ads_scope_status === 'authorized')-Number(a.ads_scope_status === 'authorized')
    || (Date.parse(b.updated_date || b.created_date) || 0)-(Date.parse(a.updated_date || a.created_date) || 0)
    || String(a.id).localeCompare(String(b.id)))[0];
}

export function recoveredOfferLockPatch(product: any, signal: any): Record<string, unknown> {
  if (signal.listing_status_confirmed !== true || signal.listing_buyable !== true
      || signal.offer_active !== true || signal.listing_suppressed === true) return {};
  // Only the known automatic migration may release its own lock. Human locks survive.
  if (product.campaign_pause_locked_by !== 'pause_guard_migration') return {};
  return { campaign_pause_lock: false, campaign_pause_lock_reason: null,
    campaign_pause_locked_by: null, campaign_pause_locked_at: null,
    pause_reason: 'offer_recovered', ads_pause_reason: 'offer_recovered', ads_resume_pending: true };
}
