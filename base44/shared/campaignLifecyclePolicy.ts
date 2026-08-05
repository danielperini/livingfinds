export const CAMPAIGN_LIFECYCLE_VERSION = 'campaign-lifecycle-v1';

export type PromotionInput = {
  orders: number;
  sales: number;
  spend: number;
  targetAcos: number;
  sourceBid: number;
  alreadyPromoted: boolean;
};

export type AutoRetirementInput = {
  ageDays: number;
  consecutiveDaysWithoutSales: number;
  protectedWinner: boolean;
  inStock: boolean;
  structurallyComplete: boolean;
};

export type ManualBidInput = {
  currentBid: number;
  minBid: number;
  maxBid: number;
  impressions: number;
  clicks: number;
  orders: number;
  sales: number;
  spend: number;
  targetAcos: number;
  maxSpendWithoutSale: number;
  increment: number;
  maxIncreasePct: number;
  maxReductionPct: number;
};

export function promotionAcos(input: PromotionInput): number | null {
  if (input.sales <= 0) return null;
  return (input.spend / input.sales) * 100;
}

export function shouldPromoteTerm(input: PromotionInput): boolean {
  if (input.alreadyPromoted || input.orders < 2 || input.orders > 3 || input.sourceBid <= 0) return false;
  const acos = promotionAcos(input);
  return acos !== null && input.targetAcos > 0 && acos <= input.targetAcos;
}

export function inheritedPromotionBid(input: PromotionInput): number {
  return Math.round(Math.max(0.02, input.sourceBid) * 100) / 100;
}

export function shouldRetireAutoCampaign(input: AutoRetirementInput): boolean {
  return input.ageDays >= 30 && input.consecutiveDaysWithoutSales >= 3 &&
    !input.protectedWinner && input.inStock && input.structurallyComplete;
}

export function nextManualBid(input: ManualBidInput): { action: 'increase' | 'reduce' | 'hold'; bid: number; reason: string } {
  const current = Math.max(input.minBid, Math.min(input.maxBid, input.currentBid));
  const acos = input.sales > 0 ? (input.spend / input.sales) * 100 : null;
  if (input.orders === 0 && input.spend >= input.maxSpendWithoutSale) {
    const floor = Math.max(input.minBid, current * (1 - input.maxReductionPct / 100));
    return { action: 'reduce', bid: Math.round(floor * 100) / 100, reason: 'SPEND_WITHOUT_SALE' };
  }
  if (acos !== null && acos > input.targetAcos) {
    const reduced = Math.max(input.minBid, current * (1 - input.maxReductionPct / 100));
    return { action: 'reduce', bid: Math.round(reduced * 100) / 100, reason: 'ACOS_ABOVE_TARGET' };
  }
  if (input.orders > 0 && acos !== null && acos <= input.targetAcos && input.impressions > 0) {
    const absolute = current + Math.max(0, input.increment);
    const percentage = current * (1 + input.maxIncreasePct / 100);
    const increased = Math.min(input.maxBid, absolute, percentage);
    return { action: increased > current ? 'increase' : 'hold', bid: Math.round(increased * 100) / 100, reason: 'WINNER_WITHIN_TARGET' };
  }
  return { action: 'hold', bid: Math.round(current * 100) / 100, reason: 'INSUFFICIENT_EVIDENCE' };
}

export type BudgetCandidate = {
  campaignId: string;
  projectedSpend: number;
  currentBudget: number;
  orders: number;
  sales: number;
  spend: number;
  targetAcos: number;
  protectedWinner?: boolean;
};

export function allocateProjectedBudget(candidates: BudgetCandidate[], globalBudget: number) {
  const cap = Math.max(0, globalBudget);
  const ranked = [...candidates].sort((a, b) => {
    const score = (row: BudgetCandidate) => {
      const acos = row.sales > 0 ? (row.spend / row.sales) * 100 : Number.POSITIVE_INFINITY;
      return (row.protectedWinner ? 1000 : 0) + row.orders * 100 + (acos <= row.targetAcos ? 100 : 0) - Math.min(100, acos);
    };
    return score(b) - score(a);
  });
  const result: Record<string, number> = {};
  let remaining = cap;
  for (const row of ranked) {
    const requested = Math.max(0, Math.min(row.projectedSpend, row.currentBudget));
    const allocated = Math.min(remaining, requested);
    result[row.campaignId] = Math.round(allocated * 100) / 100;
    remaining = Math.max(0, remaining - allocated);
  }
  return { allocations: result, allocated: Math.round((cap - remaining) * 100) / 100, remaining: Math.round(remaining * 100) / 100 };
}
