export type SkuEconomicState =
  | 'NORMAL'
  | 'VIGILANT'
  | 'DEFENSIVE'
  | 'LOSS_CONFIRMED'
  | 'NOT_BUYABLE';

const finite = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export function classifySkuEconomicState(input: {
  realRevenue?: number | null;
  adSpend?: number | null;
  contributionBeforeAds?: number | null;
  targetAcosPercent?: number | null;
  breakEvenAcosPercent?: number | null;
  buyable?: boolean;
  offerActive?: boolean;
  listingSuppressed?: boolean;
  adsEligible?: boolean;
}) {
  if (
    input.buyable === false
    || input.offerActive === false
    || input.listingSuppressed === true
    || input.adsEligible === false
  ) {
    return { state: 'NOT_BUYABLE' as SkuEconomicState, block_growth: true, pause_all_campaigns: true };
  }

  const revenue = Math.max(0, finite(input.realRevenue));
  const spend = Math.max(0, finite(input.adSpend));
  const contribution = finite(input.contributionBeforeAds);
  const targetAcos = Math.max(0, finite(input.targetAcosPercent));
  const breakEvenAcos = Math.max(0, finite(input.breakEvenAcosPercent));
  const finalProfit = contribution - spend;
  const realAcos = revenue > 0 ? (spend / revenue) * 100 : null;

  if (spend > 0 && finalProfit <= 0) {
    return { state: 'LOSS_CONFIRMED' as SkuEconomicState, block_growth: true, pause_all_campaigns: false, final_profit: finalProfit, real_acos: realAcos };
  }
  if (finalProfit < 0 || (realAcos != null && breakEvenAcos > 0 && realAcos > breakEvenAcos)) {
    return { state: 'DEFENSIVE' as SkuEconomicState, block_growth: true, pause_all_campaigns: false, final_profit: finalProfit, real_acos: realAcos };
  }
  if (realAcos != null && targetAcos > 0 && realAcos > targetAcos) {
    return { state: 'VIGILANT' as SkuEconomicState, block_growth: true, pause_all_campaigns: false, final_profit: finalProfit, real_acos: realAcos };
  }
  return { state: 'NORMAL' as SkuEconomicState, block_growth: false, pause_all_campaigns: false, final_profit: finalProfit, real_acos: realAcos };
}
