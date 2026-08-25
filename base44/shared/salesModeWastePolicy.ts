/** Deterministic waste progression used by Sales Mode before queueing mutations. */
export type WasteEvidence = {
  spend: number;
  sales: number;
  orders: number;
  clicks: number;
  ageDays: number;
  minAgeDays: number;
  minSpend: number;
  maxAcos: number;
  priorReductions: number;
  posteriorRecoveryProbability?: number;
};

export type WasteDecision = {
  action: "HOLD" | "REDUCE_BID_5" | "REDUCE_BID_10" | "PAUSE";
  reason: string;
  confidence: number;
  wasteScore: number;
};

const n = (value: unknown) =>
  Number.isFinite(Number(value)) ? Number(value) : 0;

export function isProtectedWinner30d(input: {
  orders30d: unknown;
  sales30d: unknown;
  spend30d: unknown;
  growthAcosCeiling: unknown;
  maximumAcos: unknown;
}): boolean {
  const orders = n(input.orders30d);
  const sales = n(input.sales30d);
  const spend = n(input.spend30d);
  const acos = sales > 0 ? spend / sales * 100 : Number.POSITIVE_INFINITY;
  const roas = spend > 0 ? sales / spend : 0;
  return orders >= 2 && sales > 0 && (
    (sales > spend && acos <= n(input.growthAcosCeiling)) ||
    (roas >= 4 && acos < n(input.maximumAcos))
  );
}

export function decideSalesModeWaste(input: WasteEvidence): WasteDecision {
  const spend = n(input.spend);
  const sales = n(input.sales);
  const orders = n(input.orders);
  const clicks = n(input.clicks);
  const proofSpend = Math.max(n(input.minSpend) * 2, 8);
  const acos = sales > 0 ? spend / sales * 100 : Number.POSITIVE_INFINITY;
  const persistentLoss = orders > 0 && acos >= n(input.maxAcos) &&
    spend >= proofSpend;
  const noSaleProof = orders === 0 && spend >= proofSpend && clicks >= 8;
  const mature = n(input.ageDays) >= n(input.minAgeDays);
  const recoveryLow = input.posteriorRecoveryProbability == null ||
    n(input.posteriorRecoveryProbability) < 0.20;
  const wasteScore = Math.round(
    Math.min(
      100,
      (noSaleProof ? 55 : 0) + (persistentLoss ? 35 : 0) +
        Math.min(10, spend / proofSpend * 5) + (recoveryLow ? 5 : 0),
    ),
  );

  if (!mature || (!noSaleProof && !persistentLoss)) {
    return {
      action: "HOLD",
      reason: "insufficient_economic_sample",
      confidence: 0.80,
      wasteScore,
    };
  }
  if (input.priorReductions < 1) {
    return {
      action: "REDUCE_BID_5",
      reason: "waste_detected_first_reduction",
      confidence: 0.88,
      wasteScore,
    };
  }
  if (input.priorReductions < 2) {
    return {
      action: "REDUCE_BID_10",
      reason: "waste_persistent_second_reduction",
      confidence: 0.92,
      wasteScore,
    };
  }
  if (recoveryLow && (noSaleProof || persistentLoss)) {
    return {
      action: "PAUSE",
      reason: "waste_persistent_after_reductions",
      confidence: 0.96,
      wasteScore,
    };
  }
  return {
    action: "HOLD",
    reason: "recovery_posterior_not_low_enough",
    confidence: 0.85,
    wasteScore,
  };
}
