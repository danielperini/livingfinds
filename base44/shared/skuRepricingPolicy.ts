export type RepricingPolicyConfig = {
  strategy?: 'profit_balanced' | 'featured_offer' | 'inventory_velocity' | 'defensive';
  minimumConfidence?: number;
  minimumProfitAmount?: number;
  minimumProfitPercent?: number;
  floorBufferPercent?: number;
  maximumPrice?: number | null;
  minimumPrice?: number | null;
  undercutAmount?: number;
  maxDecreasePercentPerCycle?: number;
  maxIncreasePercentPerCycle?: number;
  maxDailyChangePercent?: number;
  lowStockDays?: number;
  excessStockDays?: number;
  targetAcos?: number;
};

export type RepricingEconomics = {
  currentPrice: number;
  unitCost?: number;
  totalVariableCostPerUnit?: number;
  amazonFeeAmount?: number;
  amazonFeePercent?: number;
  breakEvenAcos?: number;
  targetAcos?: number;
  profitAfterAds?: number;
};

export type RepricingMarket = {
  featuredOfferPrice?: number | null;
  featuredOfferSellerId?: string | null;
  ownSellerId?: string | null;
  lowestCompetitorPrice?: number | null;
  featuredOfferExpectedPrice?: number | null;
  competitivePrice?: number | null;
  wasPrice?: number | null;
  averageSellingPrice?: number | null;
  retailOfferPrice?: number | null;
};

export type RepricingPerformance = {
  adSpend?: number;
  adSales?: number;
  adOrders?: number;
  units?: number;
  revenue?: number;
  currentAcos?: number | null;
  daysObserved?: number;
};

export type RepricingInventory = {
  availableQuantity: number;
  daysOfSupply?: number | null;
  signalQuality?: 'sufficient' | 'insufficient_history' | string;
};

export type RepricingConfidenceSignals = {
  uniqueSkuMapping: boolean;
  listingFresh: boolean;
  economicsActionable: boolean;
  inventoryFresh: boolean;
  salesAndAdsFresh: boolean;
  competitiveSummaryFresh: boolean;
  foepAvailable: boolean;
  validationPreviewAccepted: boolean;
  noAnomalies: boolean;
};

export type RepricingDecisionInput = {
  sku: string;
  asin: string;
  policy: RepricingPolicyConfig;
  economics: RepricingEconomics;
  market: RepricingMarket;
  performance: RepricingPerformance;
  inventory: RepricingInventory;
  confidenceSignals: RepricingConfidenceSignals;
  changesTodayPercent?: number;
};

export type RepricingDecision = {
  action: 'increase' | 'decrease' | 'hold' | 'blocked';
  currentPrice: number;
  proposedPrice: number;
  economicFloor: number;
  priceCeiling: number;
  targetAcos: number;
  currentAcos: number | null;
  projectedAcos: number | null;
  projectedProfitPerUnit: number;
  confidence: number;
  blockers: string[];
  reasons: string[];
};

const n = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const roundMoney = (value: number): number =>
  Math.round((n(value) + Number.EPSILON) * 100) / 100;

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

export const normalizeSku = (value: unknown): string =>
  String(value || '').trim().toUpperCase().replace(/\s+/g, '-').replace(/-{2,}/g, '-');

export function resolveTargetAcos(economics: RepricingEconomics, policy: RepricingPolicyConfig): number {
  const configured = n(policy.targetAcos, 0) || n(economics.targetAcos, 0) || 15;
  const breakEven = n(economics.breakEvenAcos, 0);
  const safeBreakEven = breakEven > 0 ? Math.max(1, breakEven * 0.8) : 100;
  return roundMoney(clamp(Math.min(configured, safeBreakEven), 1, 100));
}

export function calculateEconomicFloor(
  economics: RepricingEconomics,
  policy: RepricingPolicyConfig,
  targetAcos: number,
): number {
  const currentPrice = n(economics.currentPrice, 0);
  const explicitVariable = n(economics.totalVariableCostPerUnit, 0);
  const unitCost = n(economics.unitCost, 0);
  const feeAmount = n(economics.amazonFeeAmount, 0);
  const feePercent = clamp(n(economics.amazonFeePercent, 0) / 100, 0, 0.6);
  const baseCost = explicitVariable > 0 ? explicitVariable : unitCost + feeAmount;
  const minimumProfitAmount = Math.max(
    n(policy.minimumProfitAmount, 0),
    currentPrice * (clamp(n(policy.minimumProfitPercent, 5), 0, 80) / 100),
  );
  const adShare = clamp(targetAcos / 100, 0, 0.8);
  const denominator = Math.max(0.05, 1 - feePercent - adShare);
  const feeAwareFloor = (Math.max(unitCost, explicitVariable > 0 ? explicitVariable - feeAmount : unitCost) + minimumProfitAmount) / denominator;
  const absoluteFloor = Math.max(baseCost + minimumProfitAmount, feeAwareFloor, n(policy.minimumPrice, 0));
  const buffer = 1 + clamp(n(policy.floorBufferPercent, 1), 0, 20) / 100;
  return roundMoney(absoluteFloor * buffer);
}

function referenceCeiling(currentPrice: number, market: RepricingMarket): number | null {
  const refs = [market.wasPrice, market.averageSellingPrice, market.retailOfferPrice]
    .map((value) => n(value, 0))
    .filter((value) => value > 0);
  if (!refs.length) return null;
  const strongestReference = Math.max(...refs);
  return roundMoney(Math.max(currentPrice, strongestReference * 1.10));
}

export function calculatePriceCeiling(
  economics: RepricingEconomics,
  market: RepricingMarket,
  policy: RepricingPolicyConfig,
  floor: number,
): number {
  const currentPrice = n(economics.currentPrice, 0);
  const configured = n(policy.maximumPrice, 0);
  const reference = referenceCeiling(currentPrice, market);
  const candidates = [configured, reference].filter((value): value is number => Boolean(value && value > 0));
  const ceiling = candidates.length ? Math.min(...candidates) : Math.max(currentPrice * 1.15, floor);
  return roundMoney(Math.max(floor, ceiling));
}

export function confidenceScore(signals: RepricingConfidenceSignals): number {
  const weights: Array<[keyof RepricingConfidenceSignals, number]> = [
    ['uniqueSkuMapping', 0.15],
    ['listingFresh', 0.15],
    ['economicsActionable', 0.20],
    ['inventoryFresh', 0.10],
    ['salesAndAdsFresh', 0.10],
    ['competitiveSummaryFresh', 0.10],
    ['foepAvailable', 0.05],
    ['validationPreviewAccepted', 0.10],
    ['noAnomalies', 0.05],
  ];
  return Math.round(weights.reduce((sum, [key, weight]) => sum + (signals[key] ? weight : 0), 0) * 1000) / 1000;
}

function priceForTargetAcos(performance: RepricingPerformance, targetAcos: number): number | null {
  const spend = n(performance.adSpend, 0);
  const orders = n(performance.adOrders, 0);
  if (spend <= 0 || orders <= 0 || targetAcos <= 0) return null;
  return roundMoney((spend / (targetAcos / 100)) / orders);
}

function projectedAcos(performance: RepricingPerformance, proposedPrice: number): number | null {
  const spend = n(performance.adSpend, 0);
  const orders = n(performance.adOrders, 0);
  if (spend <= 0 || orders <= 0 || proposedPrice <= 0) return null;
  return roundMoney((spend / (orders * proposedPrice)) * 100);
}

function projectedProfitPerUnit(economics: RepricingEconomics, proposedPrice: number, targetAcos: number): number {
  const explicitVariable = n(economics.totalVariableCostPerUnit, 0);
  const unitCost = n(economics.unitCost, 0);
  const feeAmount = n(economics.amazonFeeAmount, 0);
  const feePercent = clamp(n(economics.amazonFeePercent, 0) / 100, 0, 0.6);
  const fixedCost = explicitVariable > 0 ? Math.max(unitCost, explicitVariable - feeAmount) : unitCost;
  const variableFee = feePercent > 0 ? proposedPrice * feePercent : feeAmount;
  const adAllocation = proposedPrice * (targetAcos / 100);
  return roundMoney(proposedPrice - fixedCost - variableFee - adAllocation);
}

function marketCandidate(input: RepricingDecisionInput, floor: number, ceiling: number, targetAcos: number): { price: number; reasons: string[] } {
  const { economics, market, performance, inventory, policy } = input;
  const current = n(economics.currentPrice, 0);
  const undercut = Math.max(0.01, n(policy.undercutAmount, 0.01));
  const reasons: string[] = [];
  const ownFeatured = Boolean(market.ownSellerId && market.featuredOfferSellerId && market.ownSellerId === market.featuredOfferSellerId);
  let candidate = current;

  const acosPrice = priceForTargetAcos(performance, targetAcos);
  if (acosPrice && acosPrice > candidate) {
    candidate = acosPrice;
    reasons.push('price_supports_target_acos');
  }

  if (!ownFeatured && n(market.featuredOfferExpectedPrice, 0) > 0) {
    candidate = n(market.featuredOfferExpectedPrice);
    reasons.push('foep_target');
  } else if (!ownFeatured && n(market.featuredOfferPrice, 0) > 0) {
    candidate = n(market.featuredOfferPrice) - undercut;
    reasons.push('featured_offer_competition');
  } else if (!ownFeatured && n(market.lowestCompetitorPrice, 0) > 0) {
    candidate = n(market.lowestCompetitorPrice) - undercut;
    reasons.push('lowest_competitor_target');
  }

  if (ownFeatured) {
    const nextPrice = n(market.lowestCompetitorPrice, 0);
    const foep = n(market.featuredOfferExpectedPrice, 0);
    const upwardTargets = [nextPrice > current ? nextPrice - undercut : 0, foep > current ? foep : 0].filter((value) => value > 0);
    if (upwardTargets.length) {
      candidate = Math.min(...upwardTargets);
      reasons.push('raise_while_preserving_featured_offer_room');
    } else {
      reasons.push('own_featured_offer_hold');
    }
  }

  const days = n(inventory.daysOfSupply, -1);
  if (inventory.availableQuantity <= 0) return { price: current, reasons: [...reasons, 'out_of_stock'] };
  if (days >= 0 && days <= n(policy.lowStockDays, 14)) {
    candidate = Math.max(candidate, current);
    reasons.push('low_stock_no_price_decrease');
  } else if (days >= n(policy.excessStockDays, 90) && current > floor) {
    candidate = Math.min(candidate, Math.max(floor, current * 0.98));
    reasons.push('excess_stock_controlled_decrease');
  }

  if (n(performance.currentAcos, 0) > targetAcos) {
    candidate = Math.max(candidate, current);
    reasons.push('acos_above_target_no_price_decrease');
  }
  if (n(economics.profitAfterAds, 0) < 0) {
    candidate = Math.max(candidate, current);
    reasons.push('negative_profit_no_price_decrease');
  }

  return { price: roundMoney(clamp(candidate, floor, ceiling)), reasons };
}

export function decideSkuRepricing(input: RepricingDecisionInput): RepricingDecision {
  const blockers: string[] = [];
  const reasons: string[] = [];
  const currentPrice = roundMoney(n(input.economics.currentPrice, 0));
  const targetAcos = resolveTargetAcos(input.economics, input.policy);
  const floor = calculateEconomicFloor(input.economics, input.policy, targetAcos);
  const ceiling = calculatePriceCeiling(input.economics, input.market, input.policy, floor);
  const confidence = confidenceScore(input.confidenceSignals);
  const threshold = clamp(n(input.policy.minimumConfidence, 0.90), 0.5, 1);

  if (!normalizeSku(input.sku)) blockers.push('missing_sku');
  if (!String(input.asin || '').trim()) blockers.push('missing_child_asin');
  if (!input.confidenceSignals.uniqueSkuMapping) blockers.push('ambiguous_sku_mapping');
  if (!input.confidenceSignals.listingFresh) blockers.push('listing_data_stale');
  if (!input.confidenceSignals.economicsActionable) blockers.push('economics_not_actionable');
  if (!input.confidenceSignals.inventoryFresh) blockers.push('inventory_data_stale');
  if (!input.confidenceSignals.salesAndAdsFresh) blockers.push('sales_ads_data_stale');
  if (!input.confidenceSignals.competitiveSummaryFresh) blockers.push('competitive_data_stale');
  if (!input.confidenceSignals.validationPreviewAccepted) blockers.push('validation_preview_not_accepted');
  if (!input.confidenceSignals.noAnomalies) blockers.push('pricing_anomaly_detected');
  if (input.inventory.availableQuantity <= 0) blockers.push('out_of_stock');
  if (currentPrice <= 0) blockers.push('invalid_current_price');
  if (floor <= 0 || ceiling < floor) blockers.push('invalid_price_bounds');
  if (confidence < threshold) blockers.push(`confidence_below_${threshold.toFixed(2)}`);

  const market = marketCandidate(input, floor, ceiling, targetAcos);
  reasons.push(...market.reasons);
  let proposed = market.price;

  const maxDown = clamp(n(input.policy.maxDecreasePercentPerCycle, 3), 0.1, 20) / 100;
  const maxUp = clamp(n(input.policy.maxIncreasePercentPerCycle, 5), 0.1, 30) / 100;
  proposed = clamp(proposed, currentPrice * (1 - maxDown), currentPrice * (1 + maxUp));

  const usedDaily = Math.abs(n(input.changesTodayPercent, 0));
  const dailyLimit = clamp(n(input.policy.maxDailyChangePercent, 8), 0.5, 50);
  const remainingDaily = Math.max(0, dailyLimit - usedDaily) / 100;
  proposed = clamp(proposed, currentPrice * (1 - remainingDaily), currentPrice * (1 + remainingDaily));
  proposed = roundMoney(clamp(proposed, floor, ceiling));

  if (remainingDaily <= 0 && proposed !== currentPrice) blockers.push('daily_change_limit_reached');
  if (Math.abs(proposed - currentPrice) < 0.01) proposed = currentPrice;

  const action = blockers.length
    ? 'blocked'
    : proposed > currentPrice
      ? 'increase'
      : proposed < currentPrice
        ? 'decrease'
        : 'hold';

  if (action === 'hold') reasons.push('no_safe_price_change');
  const currentAcos = input.performance.currentAcos == null
    ? (n(input.performance.adSales, 0) > 0 ? roundMoney((n(input.performance.adSpend) / n(input.performance.adSales)) * 100) : null)
    : roundMoney(n(input.performance.currentAcos));

  return {
    action,
    currentPrice,
    proposedPrice: action === 'blocked' ? currentPrice : proposed,
    economicFloor: floor,
    priceCeiling: ceiling,
    targetAcos,
    currentAcos,
    projectedAcos: projectedAcos(input.performance, action === 'blocked' ? currentPrice : proposed),
    projectedProfitPerUnit: projectedProfitPerUnit(input.economics, action === 'blocked' ? currentPrice : proposed, targetAcos),
    confidence,
    blockers,
    reasons,
  };
}
