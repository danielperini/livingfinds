import { decideRepricing } from "./repricingPolicy.ts";

Deno.test("média de referência entra como candidato sem atravessar o piso", () => {
  const decision = decideRepricing({
    economics: {
      unitProductCost: 50, inboundFreight: 3, packagingCost: 2,
      additionalTax: 1, otherCost: 1, fbaFee: 10, fixedAmazonFee: 0,
      estimatedReturnCost: 2, adsCostPerOrder: 8, referralFeePct: 15,
      costsConfirmed: true, feesConfirmed: true, adsCostConfirmed: true,
      minimumMarginPct: 15, targetMarginPct: 20,
      manualMinPrice: null, manualMaxPrice: null,
    },
    currentPrice: 130,
    referenceAveragePrice: 132,
    competitionFresh: true,
    sellerFulfillmentType: "AFN",
    dailyUnits: 2, sessions: 50, conversionRate: 0.04, stock: 20,
    dataConfidence: 0.9,
    guardrails: {
      normalMaxChangePct: 3, dailyMaxChangePct: 10,
      minimumEffectiveChangePct: 1, cooldownHours: 6,
      minimumConfidence: 0.75,
    },
  });
  const reference = decision.candidates.find((candidate) =>
    candidate.sources.includes("amazon_reference_price_average")
  );
  if (!reference || reference.price !== 132 || reference.marginPct < 15) {
    throw new Error("média de referência não virou candidato econômico seguro");
  }
});
