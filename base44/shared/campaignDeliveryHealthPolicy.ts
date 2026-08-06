export type DeliveryAction =
  | 'WAIT'
  | 'REPAIR_STRUCTURE'
  | 'ARCHIVE_NO_PRODUCT'
  | 'ARCHIVE_OUT_OF_STOCK'
  | 'INCREASE_BID'
  | 'PAUSE_AND_REPLACE'
  | 'PROTECT_WINNER';

export type DeliveryHealthInput = {
  ageHours: number;
  impressions: number;
  clicks: number;
  orders: number;
  sales: number;
  spend: number;
  complete: boolean;
  hasProduct: boolean;
  inStock: boolean;
  protectedWinner: boolean;
  accountOutOfBudget: boolean;
  priorBidEscalations: number;
  operationalState?: string;
};

const STALE_TRANSITIONAL_STATES = new Set([
  'INSERTING',
  'INCOMPLETE',
  'CREATING',
  'PENDING',
  'DRAFT',
  'PENDING_REVIEW',
]);

export function classifyCampaignDeliveryHealth(input: DeliveryHealthInput): DeliveryAction {
  if (input.protectedWinner || input.orders > 0 || input.sales > 0) return 'PROTECT_WINNER';
  if (!input.hasProduct) return 'ARCHIVE_NO_PRODUCT';
  if (!input.inStock) return 'ARCHIVE_OUT_OF_STOCK';

  const state = String(input.operationalState || '').trim().toUpperCase();
  const staleTransition = STALE_TRANSITIONAL_STATES.has(state) && input.ageHours >= 6;
  if (!input.complete || staleTransition) return 'REPAIR_STRUCTURE';

  if (input.ageHours < 72) return 'WAIT';
  if (input.impressions > 0 || input.clicks > 0) return 'WAIT';
  if (input.accountOutOfBudget) return 'WAIT';
  if (input.priorBidEscalations < 3) return 'INCREASE_BID';
  return 'PAUSE_AND_REPLACE';
}

export function nextConservativeBid(
  currentBid: number,
  maxBid: number,
  configuredIncrement = 0.1,
  minBid = 0.02,
): number {
  const safeMin = Math.max(0.02, Number(minBid) || 0.02);
  const safeCurrent = Math.max(safeMin, Number(currentBid) || safeMin);
  const cappedMax = Math.max(safeCurrent, Number(maxBid) || safeCurrent);
  const increment = Math.max(0.01, Number(configuredIncrement) || 0.1);
  const percentageStep = Math.round(safeCurrent * 1.1 * 100) / 100;
  const fixedStep = Math.round((safeCurrent + increment) * 100) / 100;
  return Math.min(cappedMax, Math.max(percentageStep, fixedStep));
}
