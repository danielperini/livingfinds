import { AMAZON_BID_CEILING_BRL } from './amazonBidCeiling.ts';

const n = (value: unknown, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const money = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

export function calculateIntradayTargetBid(params: {
  currentBid: number;
  minBid?: number;
  configuredTargetCpc?: number;
  intradayOverrideCpc?: number;
  observedCpc?: number;
  historicalCpc?: number;
  safeMaxCpc?: number | null;
  profitable?: boolean;
}): { targetBid: number; source: string; ceiling: number } {
  const minBid = Math.max(0.02, Math.min(AMAZON_BID_CEILING_BRL, n(params.minBid, 0.2)));
  const economicCeiling = n(params.safeMaxCpc) > 0
    ? Math.min(AMAZON_BID_CEILING_BRL, n(params.safeMaxCpc))
    : AMAZON_BID_CEILING_BRL;
  const configured = n(params.intradayOverrideCpc) > 0
    ? n(params.intradayOverrideCpc)
    : n(params.configuredTargetCpc);
  const observed = n(params.observedCpc);
  const historical = n(params.historicalCpc);

  const candidates = [
    configured > 0 ? configured : null,
    observed > 0 ? observed * (params.profitable ? 1 : 0.85) : null,
    historical > 0 ? historical : null,
    0.60,
  ].filter((value): value is number => value != null && value > 0)
    .sort((a, b) => a - b);
  const middle = candidates.length % 2
    ? candidates[Math.floor(candidates.length / 2)]
    : (candidates[candidates.length / 2 - 1] + candidates[candidates.length / 2]) / 2;
  // O piso operacional nunca pode superar o teto econômico do produto.
  const guarded = Math.max(Math.min(minBid, economicCeiling), Math.min(economicCeiling, middle));
  return {
    targetBid: money(guarded),
    source: configured > 0 ? 'configured_cpc_blended_with_observed' : 'observed_historical_cpc_blend',
    ceiling: money(economicCeiling),
  };
}

export function nextProfitableBid(currentBid: number, targetBid: number, maxIncreasePct = 10): number {
  const current = n(currentBid);
  const target = Math.min(AMAZON_BID_CEILING_BRL, n(targetBid));
  if (current <= 0 || target <= current) return money(current);
  return money(Math.min(target, current * (1 + Math.max(0, Math.min(10, n(maxIncreasePct, 10))) / 100)));
}
