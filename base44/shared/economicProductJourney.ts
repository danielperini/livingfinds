export const PRODUCT_JOURNEY_STATES = [
  'NOT_ELIGIBLE', 'ECONOMICS_PENDING', 'READY_FOR_DISCOVERY',
  'DISCOVERY_AUTO', 'LEARNING', 'HARVEST_PENDING',
  'MANUAL_CREATION_PENDING', 'MANUAL_VALIDATION', 'ACTIVE_OPTIMIZATION',
  'LOW_VOLUME_GUARDED', 'PROTECTED_WINNER', 'OUT_OF_STOCK', 'COOLDOWN',
  'ARCHIVED', 'ERROR_RETRYABLE', 'ERROR_BLOCKED',
] as const;

export type ProductJourneyState = typeof PRODUCT_JOURNEY_STATES[number];

const valid = (value: unknown) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
const number = (value: unknown) => valid(value) ? Number(value) : 0;

export function normalizeJourneyTerm(value: unknown): string {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

export function buildExactJourneyKey(input: {
  accountId: string; profileId: string; marketplaceId: string;
  asin: string; term: string;
}) {
  return [input.accountId, input.profileId, input.marketplaceId, input.asin,
    normalizeJourneyTerm(input.term), 'EXACT'].join('|');
}

export function calculateEconomicSnapshot(input: any) {
  const salePrice = number(input.salePrice);
  const productCost = number(input.productCost);
  const costs = {
    product_cost: productCost,
    referral_fee: number(input.referralFee),
    fba_fee: number(input.fbaFee),
    fulfillment_cost: number(input.fulfillmentCost),
    inbound_freight_cost: number(input.inboundFreightCost),
    preparation_cost: number(input.preparationCost),
    tax_cost: number(input.taxCost),
    coupon_cost: number(input.couponCost),
    discount_cost: number(input.discountCost),
    return_provision: number(input.returnProvision),
    other_variable_cost: number(input.otherVariableCost),
  };
  const missing: string[] = [];
  if (!valid(input.salePrice) || salePrice <= 0) missing.push('sale_price');
  if (!valid(input.productCost) || productCost <= 0 || input.costConfirmed !== true) missing.push('product_cost');
  if (input.feesFresh !== true) missing.push('amazon_fees');
  if (input.inventoryKnown !== true) missing.push('inventory');
  if (input.salesFresh !== true) missing.push('sales');
  const totalVariableCost = Object.values(costs).reduce((sum, value) => sum + value, 0);
  const marginBeforeAds = salePrice > 0 ? salePrice - totalVariableCost : 0;
  const marginRate = salePrice > 0 ? marginBeforeAds / salePrice : 0;
  const breakEvenAcos = marginRate > 0 ? marginRate : 0;
  const safetyFactor = Math.min(1, Math.max(0, number(input.safetyFactor) || 0.75));
  const targetAcos = breakEvenAcos * safetyFactor;
  const allowableAdSpendPerOrder = salePrice * targetAcos;
  const estimatedConversionRate = Math.min(1, Math.max(0, number(input.estimatedConversionRate)));
  const maxSustainableCpc = estimatedConversionRate * allowableAdSpendPerOrder;
  if (marginBeforeAds <= 0) missing.push('positive_margin');
  const actionable = missing.length === 0;
  return {
    ...costs, sale_price: salePrice, total_variable_cost: totalVariableCost,
    margin_before_ads: marginBeforeAds, margin_rate: marginRate,
    break_even_acos: breakEvenAcos, target_acos: targetAcos,
    allowable_ad_spend_per_order: allowableAdSpendPerOrder,
    max_sustainable_cpc: maxSustainableCpc,
    confidence_level: actionable ? 'complete' : 'blocked',
    data_freshness_status: actionable ? 'fresh' : 'invalid_or_stale',
    missing_fields: [...new Set(missing)], actionable,
    calculation_version: 'economic-journey-v1',
  };
}

export function determineProductJourneyState(input: any): { state: ProductJourneyState; reason: string } {
  if (input.archived === true) return { state: 'ARCHIVED', reason: 'product_archived' };
  if (input.inventoryKnown !== true) return { state: 'ERROR_RETRYABLE', reason: 'inventory_unknown' };
  if (number(input.inventoryAvailable) <= 0) return { state: 'OUT_OF_STOCK', reason: 'no_available_inventory' };
  if (!input.economics?.actionable) return { state: 'ECONOMICS_PENDING', reason: input.economics?.missing_fields?.join(',') || 'economics_incomplete' };
  if (input.listingActive !== true || input.buyable === false) return { state: 'NOT_ELIGIBLE', reason: 'listing_not_buyable' };
  if (input.cooldownActive === true) return { state: 'COOLDOWN', reason: 'decision_cooldown_active' };
  if (input.protectedWinner === true) return { state: 'PROTECTED_WINNER', reason: 'profitable_winner' };
  if (input.manualValidated === true) return { state: input.lowVolume ? 'LOW_VOLUME_GUARDED' : 'ACTIVE_OPTIMIZATION', reason: 'manual_exact_confirmed' };
  if (input.manualPending === true) return { state: 'MANUAL_VALIDATION', reason: 'manual_exact_pending_confirmation' };
  if (input.harvestCandidate === true) return { state: 'HARVEST_PENDING', reason: 'profitable_same_sku_term' };
  if (input.autoActive === true) return { state: 'LEARNING', reason: 'automatic_discovery_active' };
  return { state: 'READY_FOR_DISCOVERY', reason: 'eligible_for_automatic_discovery' };
}

export function capBidToEconomics(currentBid: number, proposedBid: number, maxSustainableCpc: number, maxIncreasePct = 0.20) {
  const current = Math.max(0, number(currentBid));
  const proposed = Math.max(0, number(proposedBid));
  const ceiling = Math.max(0, number(maxSustainableCpc));
  if (ceiling <= 0) return { allowed: false, bid: current, reason: 'missing_sustainable_cpc' };
  const cycleCap = current > 0 ? current * (1 + Math.min(0.20, Math.max(0, maxIncreasePct))) : ceiling;
  const bid = Math.min(proposed, ceiling, cycleCap);
  return { allowed: bid > 0 && bid >= current, bid: Math.round(bid * 100) / 100,
    reason: proposed > ceiling ? 'capped_to_sustainable_cpc' : proposed > cycleCap ? 'capped_to_cycle_limit' : 'within_guardrails' };
}
