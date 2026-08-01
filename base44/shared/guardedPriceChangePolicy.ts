const ACTIVE_PRICE_STATUSES = new Set([
  "pending", "approved", "running", "submitted", "processing", "confirmed",
]);

const n = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;
const roundMoney = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

export function priceChangeUsedInWindow(input: {
  actions?: any[];
  history?: any[];
  nowMs?: number;
  windowHours?: number;
}) {
  const nowMs = input.nowMs ?? Date.now();
  const cutoff = nowMs - (input.windowHours ?? 24) * 3600000;
  const linkedHistoryIds = new Set<string>();
  const confirmedPairs = new Set<string>();
  let used = 0;
  for (const action of input.actions || []) {
    const timestamp = new Date(action.created_at || action.updated_at || 0).getTime();
    if (!ACTIVE_PRICE_STATUSES.has(String(action.status || "")) || timestamp < cutoff) continue;
    if (action.history_id) linkedHistoryIds.add(String(action.history_id));
    if (String(action.status) === "confirmed") {
      confirmedPairs.add(`${n(action.old_price).toFixed(2)}:${n(action.new_price).toFixed(2)}`);
    }
    used += Math.abs(n(action.new_price) - n(action.old_price));
  }
  for (const row of input.history || []) {
    const timestamp = new Date(row.changed_at || 0).getTime();
    if (row.history_type !== "price_confirmed" || timestamp < cutoff) continue;
    if (row.id && linkedHistoryIds.has(String(row.id))) continue;
    if (confirmedPairs.has(`${n(row.price_before).toFixed(2)}:${n(row.price_after).toFixed(2)}`)) continue;
    used += Math.abs(n(row.price_after) - n(row.price_before));
  }
  return roundMoney(used);
}

export function deterministicPriceConfidence(input: {
  economicsComplete: boolean;
  priceAndFeesFresh: boolean;
  inventoryFresh: boolean;
  equivalentCompetitionValid: boolean;
  salesAndConversionSufficient: boolean;
  adsMetricsMatured: boolean;
  priceHistorySufficient: boolean;
}) {
  const weights = {
    economics_complete: 25,
    price_and_fees_fresh: 15,
    inventory_fresh: 10,
    equivalent_competition_valid: 15,
    sales_and_conversion_sufficient: 15,
    ads_metrics_matured: 10,
    price_history_sufficient: 10,
  } as const;
  const flags = {
    economics_complete: input.economicsComplete,
    price_and_fees_fresh: input.priceAndFeesFresh,
    inventory_fresh: input.inventoryFresh,
    equivalent_competition_valid: input.equivalentCompetitionValid,
    sales_and_conversion_sufficient: input.salesAndConversionSufficient,
    ads_metrics_matured: input.adsMetricsMatured,
    price_history_sufficient: input.priceHistorySufficient,
  };
  const components = Object.fromEntries(
    Object.entries(weights).map(([key, weight]) => [key, flags[key as keyof typeof flags] ? weight : 0]),
  );
  const score = Object.values(components).reduce((sum, value) => sum + Number(value), 0);
  const missingData = Object.entries(flags).filter(([, present]) => !present).map(([key]) => key);
  return {
    score,
    components,
    missingData,
    reason: missingData.length
      ? `Confiança ${score}/100; ausentes: ${missingData.join(", ")}.`
      : "Confiança 100/100; todos os componentes determinísticos presentes.",
  };
}

export function applyGuardedPriceChange(input: {
  currentPrice: number;
  proposedPrice: number;
  decisionConfidence: number;
  priceChangeUsed24h: number;
  maximumPriceChangeAmount24h?: number;
  minimumPriceChangeAmount?: number;
  minimumAutomaticConfidence?: number;
}) {
  const maximum = Math.max(0, n(input.maximumPriceChangeAmount24h || 2));
  const minimum = Math.max(0, n(input.minimumPriceChangeAmount || 0.05));
  const threshold = n(input.minimumAutomaticConfidence || 90);
  const remaining = roundMoney(Math.max(0, maximum - n(input.priceChangeUsed24h)));
  const idealDifference = n(input.proposedPrice) - n(input.currentPrice);
  const allowedChange = roundMoney(Math.min(Math.abs(idealDifference), remaining));
  const guardedPrice = roundMoney(n(input.currentPrice) + Math.sign(idealDifference) * allowedChange);
  const status = Math.abs(idealDifference) < minimum
    ? "no_change"
    : input.decisionConfidence >= threshold
    ? allowedChange >= minimum ? "automatic_guarded" : "limit_exhausted"
    : input.decisionConfidence >= 75 ? "recommendation_only" : "insufficient_confidence";
  return {
    status,
    idealPrice: roundMoney(n(input.proposedPrice)),
    guardedPrice,
    priceChangeUsed24h: roundMoney(n(input.priceChangeUsed24h)),
    remainingPriceChange24h: remaining,
    allowedChange,
    automaticAllowed: status === "automatic_guarded",
  };
}
