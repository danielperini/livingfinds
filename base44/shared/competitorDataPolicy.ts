export type CompetitorEstimateConfidence = "low" | "medium";

export type CompetitorSalesEstimate = {
  competitor_sales_estimate: number;
  competitor_sales_estimate_confidence: CompetitorEstimateConfidence;
  competitor_sales_estimate_source: "inferred";
};

const FORBIDDEN_FACTUAL_FIELDS = new Set([
  "competitor_sales",
  "competitor_units",
  "competitor_orders",
  "competitor_revenue",
  "competitor_conversion_rate",
  "competitor_profit",
  "competitor_acos",
  "competitor_roas",
  "competitor_ad_spend",
  "competitor_cpc",
  "competitor_exact_stock",
]);

export function validateCompetitorSalesEstimate(value: any) {
  const reasons: string[] = [];
  const estimate = Number(value?.competitor_sales_estimate);
  if (!Number.isFinite(estimate) || estimate < 0) reasons.push("INVALID_ESTIMATE");
  if (!["low", "medium"].includes(value?.competitor_sales_estimate_confidence)) {
    reasons.push("CONFIDENCE_MUST_BE_LOW_OR_MEDIUM");
  }
  if (value?.competitor_sales_estimate_source !== "inferred") {
    reasons.push("SOURCE_MUST_BE_INFERRED");
  }
  return { valid: reasons.length === 0, reasons };
}

export function stripUnsupportedCompetitorFacts<T extends Record<string, any>>(
  value: T,
): { sanitized: T; removed: string[] } {
  const removed: string[] = [];
  const visit = (input: any): any => {
    if (Array.isArray(input)) return input.map(visit);
    if (!input || typeof input !== "object") return input;
    const output: Record<string, any> = {};
    for (const [field, nested] of Object.entries(input)) {
      if (FORBIDDEN_FACTUAL_FIELDS.has(field)) {
        removed.push(field);
        continue;
      }
      output[field] = visit(nested);
    }
    if ("competitor_sales_estimate" in output) {
      const validation = validateCompetitorSalesEstimate(output);
      if (!validation.valid) {
        delete output.competitor_sales_estimate;
        delete output.competitor_sales_estimate_confidence;
        delete output.competitor_sales_estimate_source;
        removed.push("invalid_competitor_sales_estimate");
      }
    }
    return output;
  };
  return { sanitized: visit(value) as T, removed };
}

export function competitorMetricScope() {
  return {
    own_commercial_metrics: "authorized_seller_only",
    competitor_offer_signals: "amazon_sp_api",
    competitor_commercial_metrics: "not_provided_by_amazon",
  } as const;
}
