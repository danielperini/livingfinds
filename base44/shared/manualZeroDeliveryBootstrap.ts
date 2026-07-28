export const BOOTSTRAP_MAX_ATTEMPTS = 2;
export const BOOTSTRAP_MAX_INCREASE_PCT = 20;
export const BOOTSTRAP_COOLDOWN_HOURS = 72;

const n = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
const r2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const norm = (value: unknown) => String(value || '').trim().toLowerCase();

export type BidCaps = {
  currentBid: number;
  suggestedLow?: number | null;
  suggestedMid?: number | null;
  safeMaxCpc?: number | null;
  maxBid?: number | null;
  sustainableCpc?: number | null;
};

export function calculateBootstrapBid(input: BidCaps) {
  const current = n(input.currentBid);
  if (current <= 0) return { eligible: false, reason: 'invalid_current_bid', bid: current };
  const economicCaps = [input.safeMaxCpc, input.sustainableCpc].map(n).filter((v) => v > 0);
  if (!economicCaps.length) return { eligible: false, reason: 'economic_cap_unavailable', bid: current };

  const low = n(input.suggestedLow);
  const mid = n(input.suggestedMid);
  const hardCaps = [...economicCaps, n(input.maxBid), mid].filter((v) => v > 0);
  const proposed = Math.max(current * 1.2, low);
  const bid = r2(Math.min(proposed, ...hardCaps));
  if (bid <= current) return { eligible: false, reason: 'caps_do_not_allow_increase', bid: current };
  return {
    eligible: true,
    reason: 'controlled_bootstrap_increase',
    bid,
    changePct: r2(((bid - current) / current) * 100),
  };
}

export function buildBootstrapIdempotencyKey(input: {
  accountId: string; campaignId: string; keywordId: string; attempt: number; window: string; bid: number;
}) {
  return [
    input.accountId, 'manual_zero_delivery_bootstrap', input.campaignId,
    input.keywordId, `attempt_${input.attempt}`, input.window, r2(input.bid).toFixed(2),
  ].join('|');
}

export function diagnoseZeroDelivery(input: any, now = new Date()) {
  if (norm(input.campaignType) !== 'sp') return { eligible: false, status: 'ineligible_campaign_type' };
  if (norm(input.targetingType) !== 'manual') return { eligible: false, status: 'ineligible_targeting_type' };
  if (norm(input.matchType) !== 'exact') return { eligible: false, status: 'ineligible_match_type' };
  if (!input.structureComplete) return { eligible: false, status: 'incomplete_structure' };
  if (!input.remoteEnabled) return { eligible: false, status: 'amazon_entity_not_enabled' };
  if (!input.metricsFresh) return { eligible: false, status: 'metrics_unavailable' };
  if (n(input.stock) <= 0 || input.stockEligible === false) return { eligible: false, status: 'out_of_stock' };
  if (input.listingEligible === false) return { eligible: false, status: 'listing_ineligible' };
  if (n(input.impressions) || n(input.clicks) || n(input.spend)) return { eligible: false, status: 'delivering' };
  const created = new Date(input.createdAt || 0);
  if (!Number.isFinite(created.getTime()) || now.getTime() - created.getTime() < 24 * 3600_000) {
    return { eligible: false, status: 'learning_under_24h' };
  }
  const attempts = n(input.attempts);
  if (attempts >= BOOTSTRAP_MAX_ATTEMPTS) return { eligible: false, status: 'replacement_review_required' };
  const last = input.lastRescueAt ? new Date(input.lastRescueAt) : null;
  if (last && Number.isFinite(last.getTime()) && now.getTime() - last.getTime() < BOOTSTRAP_COOLDOWN_HOURS * 3600_000) {
    return { eligible: false, status: 'cooldown' };
  }
  return { eligible: true, status: 'bootstrap_candidate', attempt: attempts + 1 };
}

export function classifyAmazonFailure(status: number) {
  if (status === 409 || status === 429 || status >= 500) return 'retryable';
  if (status >= 400) return 'terminal';
  return 'none';
}

export function eligibleForBudgetIncrease(profile: any) {
  const delivery = norm(profile?.campaign?.delivery_status);
  return Boolean(
    profile?.winner &&
    n(profile?.impressions ?? profile?.campaign?.impressions) > 0 &&
    n(profile?.spend) > 0 &&
    n(profile?.orders) > 0 &&
    n(profile?.sales) > 0 &&
    n(profile?.budgetRatio) >= 0.85 &&
    !delivery.includes('zero_delivery') &&
    !['out_of_stock', 'listing_ineligible', 'metrics_unavailable'].includes(delivery),
  );
}
