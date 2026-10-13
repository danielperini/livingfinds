import { stockAdsDecision } from './stockAdsPolicy.ts';
import { isProductEligibleForCampaignActivation } from './productCampaignPauseGuard.ts';

const ASIN_PATTERN = /\b(B0[A-Z0-9]{8})\b/i;

export function campaignCoverageAsin(campaign: any): string {
  const explicit = [
    campaign?.asin,
    campaign?.advertised_asin,
    campaign?.advertised_product_asin,
    campaign?.product_asin,
  ].map((value) => String(value || '').trim().toUpperCase())
    .find((value) => /^B0[A-Z0-9]{8}$/.test(value));
  if (explicit) return explicit;
  const label = [campaign?.name, campaign?.campaign_name, campaign?.campaignName]
    .map((value) => String(value || '')).join(' ');
  return label.match(ASIN_PATTERN)?.[1]?.toUpperCase() || '';
}

export function campaignCoverageProductEligible(product: any): boolean {
  const status = String(product?.status || '').trim().toLowerCase();
  const syncStatus = String(product?.catalog_sync_status || '').trim().toLowerCase();
  return status !== 'archived'
    && syncStatus !== 'duplicate'
    && Boolean(String(product?.sku || '').trim())
    && /^B0[A-Z0-9]{8}$/.test(String(product?.asin || '').trim().toUpperCase())
    && isProductEligibleForCampaignActivation(product);
}

// Discovery must not depend on past sales, ACOS or campaign activity.
// Paused-by-stock products can resume; explicit manual locks remain respected.
export function campaignCoverageEligible(product: any): boolean {
  return campaignCoverageProductEligible(product) && stockAdsDecision(product) === 'activate';
}
