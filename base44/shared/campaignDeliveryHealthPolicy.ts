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
};

export function classifyCampaignDeliveryHealth(input: DeliveryHealthInput): DeliveryAction {
  if (input.protectedWinner || input.orders > 0 || input.sales > 0) return 'PROTECT_WINNER';
  if (!input.hasProduct) return 'ARCHIVE_NO_PRODUCT';
  if (!input.inStock) return 'ARCHIVE_OUT_OF_STOCK';
  if (!input.complete) return 'REPAIR_STRUCTURE';
  if (input.ageHours < 72) return 'WAIT';
  if (input.impressions > 0 || input.clicks > 0) return 'WAIT';
  if (input.accountOutOfBudget) return 'WAIT';
  if (input.priorBidEscalations < 3) return 'INCREASE_BID';
  return 'PAUSE_AND_REPLACE';
}

export function nextConservativeBid(currentBid: number, maxBid: number): number {
  const safeCurrent = Math.max(0.02, Number(currentBid) || 0.02);
  const cappedMax = Math.max(safeCurrent, Number(maxBid) || safeCurrent);
  return Math.min(cappedMax, Math.round(safeCurrent * 1.1 * 100) / 100);
}
