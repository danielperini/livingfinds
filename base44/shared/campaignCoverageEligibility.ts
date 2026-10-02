import { stockAdsDecision } from './stockAdsPolicy.ts';
import { isProductEligibleForCampaignActivation } from './productCampaignPauseGuard.ts';

// Discovery must not depend on past sales, ACOS or campaign activity.
// Paused-by-stock products can resume; explicit manual locks remain respected.
export function campaignCoverageEligible(product: any): boolean {
  return stockAdsDecision(product) === 'activate'
    && Boolean(String(product?.sku || '').trim())
    && /^B0[A-Z0-9]{8}$/.test(String(product?.asin || '').trim().toUpperCase())
    && isProductEligibleForCampaignActivation(product);
}
