import { AMAZON_BID_CEILING_BRL } from './amazonBidCeiling.ts';

export function proportionalActivationBid(settings: any, economics: any, assessment: any): number {
  const minBid = Math.max(0.02, Number(settings?.min_bid || 0.10));
  const configuredMax = Number(settings?.max_bid || AMAZON_BID_CEILING_BRL);
  const maxBid = Math.max(minBid, Math.min(AMAZON_BID_CEILING_BRL, configuredMax));
  const safeCpc = Number(assessment?.safe_max_cpc || economics?.safe_max_cpc || 0);
  const profitAfterAds = Number(assessment?.profit_after_ads ?? economics?.profit_after_ads ?? 0);
  const critical = profitAfterAds < 0 || ['unprofitable', 'no_sales_with_spend'].includes(
    String(assessment?.economic_status || economics?.economic_classification || '').toLowerCase()
  );
  const proportional = safeCpc > 0 ? safeCpc * (critical ? 0.55 : 0.80) : minBid;
  return Math.round(Math.min(maxBid, Math.max(minBid, proportional)) * 100) / 100;
}
