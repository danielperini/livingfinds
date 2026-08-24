/** Bid calculation, no-impression diagnosis, bounded correction and coverage policy. */
export type NoImpressionCause = 'TOO_EARLY' | 'BID_TOO_LOW' | 'ZERO_SPEND_PERSISTENT' | 'TARGETING_OR_CATALOG' | 'DELIVERY_OR_ACCOUNT' | 'INVALID_BID' | 'NONE';
export type NoImpressionAction = 'HOLD' | 'ADJUST_BID' | 'REVIEW_EXISTING' | 'FIX_TARGETING_OR_CATALOG' | 'FIX_ACCOUNT_OR_DELIVERY';

export interface InitialBidInput {
  observedCpcTerm?: number;
  observedCpcCampaign?: number;
  cvr: number;
  targetAcos: number;
  averageOrderValue: number;
  marginPerOrder?: number;
  marginRate?: number;
  safeMaxCpc: number;
  minBid?: number;
}
export interface InitialBidResult {
  initialBid: number;
  observedCpc: number;
  targetAcosRate: number;
  targetCpc: number;
  breakEvenCpc: number;
  economicMaxCpc: number;
  safeMaxCpc: number;
  formula: string;
}
export interface WinnerEconomics {
  sameSkuOrders: number;
  sameSkuSales: number;
  postAdsProfit: number;
  acos: number;
  economicAcosLimit: number;
}
export interface NoImpressionInput extends WinnerEconomics {
  impressions: number;
  spend: number;
  ageHours: number;
  currentBid: number;
  safeMaxCpc: number;
  observedCpcTerm?: number;
  observedCpcCampaign?: number;
  hasValidAsin?: boolean;
  accountHealthy?: boolean;
  targetingValid?: boolean;
  correctionPctApplied?: number;
  baselineBid?: number;
}
export interface NoImpressionDiagnosis {
  cause: NoImpressionCause;
  action: NoImpressionAction;
  reason: string;
  nextBid?: number;
  appliedPct?: number;
  correctionExhausted: boolean;
}
export interface ImpressionCoverageInput { createdAt: string | Date; impressions: number; }
export interface ImpressionCoverage {
  total: number;
  within24h: number;
  within48h: number;
  rate24h: number;
  rate48h: number;
  meets24h: boolean;
  meets48h: boolean;
  action: 'HEALTHY' | 'CORRECT_BIDS' | 'REVIEW_DELIVERY';
}

function n(value: unknown): number { const result = Number(value); return Number.isFinite(result) ? Math.max(0, result) : 0; }
function rate(value: unknown): number { const result = n(value); return result > 1 ? result / 100 : result; }
function money(value: number): number { return Math.round(Math.max(0, value) * 100) / 100; }
function hoursSince(value: string | Date, now: Date): number { const timestamp = value instanceof Date ? value.getTime() : Date.parse(value); return Number.isFinite(timestamp) ? Math.max(0, now.getTime() - timestamp) / 3600000 : Infinity; }

export function calculateInitialBid(input: InitialBidInput): InitialBidResult {
  const observedCpc = n(input.observedCpcTerm) || n(input.observedCpcCampaign);
  const cvr = rate(input.cvr);
  const targetAcosRate = rate(input.targetAcos);
  const averageOrderValue = n(input.averageOrderValue);
  const marginPerOrder = n(input.marginPerOrder) || averageOrderValue * rate(input.marginRate);
  const safeMaxCpc = money(input.safeMaxCpc);
  const targetCpc = averageOrderValue * targetAcosRate * cvr;
  const breakEvenCpc = marginPerOrder * cvr;
  const limits = [safeMaxCpc, targetCpc, breakEvenCpc].filter((value) => value > 0);
  const economicMaxCpc = money(Math.min(...limits, safeMaxCpc));
  const referenceCpc = observedCpc || economicMaxCpc;
  const minBid = Math.min(money(input.minBid ?? 0.02), safeMaxCpc);
  const initialBid = money(Math.min(safeMaxCpc, economicMaxCpc, Math.max(minBid, referenceCpc)));
  return { initialBid, observedCpc: money(observedCpc), targetAcosRate, targetCpc: money(targetCpc), breakEvenCpc: money(breakEvenCpc), economicMaxCpc, safeMaxCpc, formula: 'min(safeMaxCpc, targetAcos × AOV × CVR, marginPerOrder × CVR, max(minBid, observedCPC(term|campaign)))' };
}

export function isStrongWinner(input: WinnerEconomics): boolean {
  return n(input.sameSkuOrders) >= 1 && n(input.sameSkuSales) >= 1 && Number(input.postAdsProfit) > 0 && n(input.economicAcosLimit) > 0 && n(input.acos) <= n(input.economicAcosLimit);
}

export function diagnoseNoImpression(input: NoImpressionInput, now = new Date()): NoImpressionDiagnosis {
  if (n(input.impressions) > 0) return { cause: 'NONE', action: 'HOLD', reason: 'Impression observed.', correctionExhausted: false };
  if (n(input.currentBid) <= 0 || n(input.safeMaxCpc) <= 0) return { cause: 'INVALID_BID', action: 'REVIEW_EXISTING', reason: 'Bid or safeMaxCpc is not valid.', correctionExhausted: true };
  if (input.hasValidAsin === false || input.targetingValid === false) return { cause: 'TARGETING_OR_CATALOG', action: 'FIX_TARGETING_OR_CATALOG', reason: 'ASIN or targeting validation failed.', correctionExhausted: true };
  if (input.accountHealthy === false) return { cause: 'DELIVERY_OR_ACCOUNT', action: 'FIX_ACCOUNT_OR_DELIVERY', reason: 'Account or delivery health blocks serving.', correctionExhausted: true };
  if (n(input.ageHours) < 24) return { cause: 'TOO_EARLY', action: 'HOLD', reason: 'Less than 24 hours since creation; do not create another campaign.', correctionExhausted: false };
  const sourceCpc = n(input.observedCpcTerm) || n(input.observedCpcCampaign);
  const bidTooLow = sourceCpc > 0 && input.currentBid < sourceCpc;
  const persistent = n(input.spend) === 0 && n(input.ageHours) >= 48;
  const strongWinner = isStrongWinner(input);
  const applied = Math.min(0.15, n(input.correctionPctApplied));
  const nextPct = applied < 0.05 ? 0.05 : applied < 0.10 ? 0.10 : applied < 0.15 ? 0.15 : 0;
  const baseline = n(input.baselineBid) || n(input.currentBid);
  const nextBid = money(Math.min(n(input.safeMaxCpc), baseline * (1 + nextPct)));
  const canRaise = bidTooLow && strongWinner && nextPct > 0 && nextBid > n(input.currentBid) && nextBid <= n(input.safeMaxCpc);
  if (canRaise) return { cause: 'BID_TOO_LOW', action: 'ADJUST_BID', reason: `No impression after ${Math.round(input.ageHours)}h; strong winner and economics allow a bounded +${Math.round(nextPct * 100)}% correction.`, nextBid, appliedPct: nextPct, correctionExhausted: false };
  if (persistent) return { cause: 'ZERO_SPEND_PERSISTENT', action: 'REVIEW_EXISTING', reason: 'Zero spend persisted for at least 48 hours; correct the existing target/delivery instead of creating another campaign.', correctionExhausted: applied >= 0.15 || !strongWinner };
  if (bidTooLow) return { cause: 'BID_TOO_LOW', action: 'HOLD', reason: 'Bid is below source CPC, but bounded correction is not economically authorized.', correctionExhausted: applied >= 0.15 || !strongWinner };
  return { cause: 'DELIVERY_OR_ACCOUNT', action: 'FIX_ACCOUNT_OR_DELIVERY', reason: 'No impression without a bid signal; inspect serving, account, catalog and targeting on the existing campaign.', correctionExhausted: false };
}

export function evaluateImpressionCoverage(inputs: readonly ImpressionCoverageInput[], now = new Date()): ImpressionCoverage {
  const total = inputs.length;
  const within24h = inputs.filter((item) => n(item.impressions) > 0 && hoursSince(item.createdAt, now) <= 24).length;
  const within48h = inputs.filter((item) => n(item.impressions) > 0 && hoursSince(item.createdAt, now) <= 48).length;
  const rate24h = total ? within24h / total : 1;
  const rate48h = total ? within48h / total : 1;
  const meets24h = rate24h >= 0.8;
  const meets48h = rate48h >= 0.95;
  return { total, within24h, within48h, rate24h, rate48h, meets24h, meets48h, action: meets48h ? 'HEALTHY' : meets24h ? 'REVIEW_DELIVERY' : 'CORRECT_BIDS' };
}
