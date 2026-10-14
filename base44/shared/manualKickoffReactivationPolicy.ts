import { hasFreshAdsInventory, availableAdsStock } from './stockAdsPolicy.ts';

/** Explicit manual kickoff can restore a user's paused campaign set once. */
export function shouldReactivateForManualKickoff(product: any, campaign: any, remoteState: unknown): boolean {
  if (product?.manual_kickoff_status !== 'pending') return false;
  if (!hasFreshAdsInventory(product) || availableAdsStock(product) <= 0) return false;
  if (campaign?.archived === true || ['archived', 'ended'].includes(String(campaign?.state || campaign?.status || '').toLowerCase())) return false;
  return String(remoteState || '').toLowerCase() === 'paused';
}

export function manualKickoffCanComplete(product: any, campaigns: any[], remoteStates: Map<string, string>): boolean {
  if (product?.manual_kickoff_status !== 'pending' || !hasFreshAdsInventory(product) || availableAdsStock(product) <= 0) return false;
  const eligible = campaigns.filter((campaign) => campaign?.archived !== true
    && !['archived', 'ended'].includes(String(campaign?.state || campaign?.status || '').toLowerCase()));
  if (!eligible.length) return false;
  return eligible.every((campaign) => {
    const id = String(campaign?.amazon_campaign_id || campaign?.campaign_id || '');
    return id && ['enabled', 'archived'].includes(String(remoteStates.get(id) || '').toLowerCase());
  });
}
