export type NoImpressionCalibrationAction =
  | 'BOOST_CONFIRMED_ZERO'
  | 'HOLD_CONFIRMED_ZERO'
  | 'RESOLVE_IMPRESSIONS'
  | 'RESOLVE_INELIGIBLE'
  | 'STALE_NO_DATA'
  | 'STALE_GUARDRAIL';

export type NoImpressionCalibrationInput = {
  keywordEnabled: boolean;
  campaignKnown: boolean;
  campaignState: string;
  campaignOperational: boolean;
  productEligibility: 'eligible' | 'ineligible' | 'unknown';
  structureReady: boolean;
  economicsReady: boolean;
  keywordMetricDays: number;
  keywordImpressions: number | null;
  recentBidChange: boolean;
  currentBid: number;
  maxBid: number;
};

export type NoImpressionCalibrationDecision = {
  action: NoImpressionCalibrationAction;
  reason: string;
};

export function shouldMaintainActiveNoImpressionAlert(
  action: NoImpressionCalibrationAction,
): boolean {
  return action === 'BOOST_CONFIRMED_ZERO' || action === 'HOLD_CONFIRMED_ZERO';
}

/**
 * Missing rows are unknown data, never zero delivery. A bid increase is only
 * allowed when two daily targeting rows confirm zero impressions and every
 * operational/economic guardrail is healthy.
 */
export function classifyNoImpressionCalibration(
  input: NoImpressionCalibrationInput,
): NoImpressionCalibrationDecision {
  const campaignState = String(input.campaignState || '').toLowerCase();

  if (!input.keywordEnabled) {
    return { action: 'RESOLVE_INELIGIBLE', reason: 'keyword_not_enabled' };
  }
  if (!input.campaignKnown) {
    return { action: 'STALE_GUARDRAIL', reason: 'campaign_state_unknown' };
  }
  if (campaignState !== 'enabled' || !input.campaignOperational) {
    return { action: 'RESOLVE_INELIGIBLE', reason: 'campaign_not_operational' };
  }
  if (input.productEligibility === 'ineligible') {
    return { action: 'RESOLVE_INELIGIBLE', reason: 'product_not_ads_eligible' };
  }
  if (input.productEligibility === 'unknown') {
    return { action: 'STALE_GUARDRAIL', reason: 'product_eligibility_unknown' };
  }
  if (!input.structureReady) {
    return { action: 'STALE_GUARDRAIL', reason: 'campaign_structure_incomplete' };
  }
  if (!input.economicsReady) {
    return { action: 'STALE_GUARDRAIL', reason: 'economics_not_ready' };
  }
  if (input.keywordMetricDays < 2 || input.keywordImpressions === null) {
    return { action: 'STALE_NO_DATA', reason: 'targeting_metrics_48h_incomplete' };
  }
  if (input.keywordImpressions > 0) {
    return { action: 'RESOLVE_IMPRESSIONS', reason: 'keyword_impressions_observed' };
  }
  if (input.recentBidChange) {
    return { action: 'HOLD_CONFIRMED_ZERO', reason: 'bid_change_cooldown_24h' };
  }
  if (input.currentBid >= input.maxBid) {
    return { action: 'HOLD_CONFIRMED_ZERO', reason: 'maximum_bid_reached' };
  }
  return { action: 'BOOST_CONFIRMED_ZERO', reason: 'confirmed_zero_impressions_48h' };
}
