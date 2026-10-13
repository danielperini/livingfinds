/**
 * Portfolio-wide guardrails for manual exact campaign distribution.
 * Automatic discovery coverage is maintained separately at one AUTO per eligible SKU.
 */
export const SKU_CAMPAIGN_DISTRIBUTION = Object.freeze({
  automaticCampaignsPerEligibleSku: 1,
  maxManualExactCampaignsPerSku: 5,
  minAvailableFbaForManualExpansion: 5,
  maxNewManualExactPerSkuPerCycle: 1,
  maxNewManualExactPerAccountPerCycle: 10,
  minVerifiedSameSkuOrders: 2,
  manualCampaignFloor: 0,
});

const finite = (value: unknown, fallback = 0): number =>
  Number.isFinite(Number(value)) ? Number(value) : fallback;

/** There is deliberately no minimum number of manual campaigns per SKU. */
export function resolveManualCampaignFloor(_requested?: unknown): 0 {
  return 0;
}

/** Clamp caller-provided expansion limits so old callers cannot fan out campaigns. */
export function resolveManualExpansionLimits(requestedPerRun?: unknown, requestedPerSku?: unknown) {
  return {
    perRun: Math.max(0, Math.min(
      SKU_CAMPAIGN_DISTRIBUTION.maxNewManualExactPerAccountPerCycle,
      Math.floor(finite(requestedPerRun, SKU_CAMPAIGN_DISTRIBUTION.maxNewManualExactPerAccountPerCycle)),
    )),
    perSku: Math.max(0, Math.min(
      SKU_CAMPAIGN_DISTRIBUTION.maxNewManualExactPerSkuPerCycle,
      Math.floor(finite(requestedPerSku, SKU_CAMPAIGN_DISTRIBUTION.maxNewManualExactPerSkuPerCycle)),
    )),
  };
}

export function evaluateManualExactExpansion(input: {
  availableFbaUnits: unknown;
  sameSkuAttributionVerified: boolean;
  sameSkuOrders: unknown;
  manualCampaignCount: unknown;
  createdThisCycle: unknown;
  alreadyExact: boolean;
}): { eligible: boolean; reason: string } {
  if (finite(input.availableFbaUnits, -1) < SKU_CAMPAIGN_DISTRIBUTION.minAvailableFbaForManualExpansion) return { eligible: false, reason: 'insufficient_available_fba_for_manual_expansion' };
  if (input.sameSkuAttributionVerified !== true) return { eligible: false, reason: 'same_sku_attribution_unverified' };
  if (finite(input.sameSkuOrders) < SKU_CAMPAIGN_DISTRIBUTION.minVerifiedSameSkuOrders) {
    return { eligible: false, reason: 'requires_two_verified_same_sku_orders' };
  }
  if (finite(input.manualCampaignCount) >= SKU_CAMPAIGN_DISTRIBUTION.maxManualExactCampaignsPerSku) {
    return { eligible: false, reason: 'manual_campaign_cap_reached' };
  }
  if (finite(input.createdThisCycle) >= SKU_CAMPAIGN_DISTRIBUTION.maxNewManualExactPerSkuPerCycle) {
    return { eligible: false, reason: 'per_sku_cycle_cap_reached' };
  }
  if (input.alreadyExact) return { eligible: false, reason: 'exact_keyword_already_exists' };
  return { eligible: true, reason: 'verified_same_sku_winner_with_capacity' };
}
