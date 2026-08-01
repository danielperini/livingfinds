import {
  decideRepricing,
  economicsAtPrice,
  equivalentCompetitorOffers,
  estimateObservedElasticity,
  priceForNetMargin,
  validateRepricingEconomics,
} from "./repricingPolicy.ts";

const economics = {
  unitProductCost: 50,
  inboundFreight: 3,
  packagingCost: 2,
  additionalTax: 1,
  otherCost: 1,
  fbaFee: 10,
  fixedAmazonFee: 0,
  estimatedReturnCost: 2,
  adsCostPerOrder: 8,
  referralFeePct: 15,
  costsConfirmed: true,
  feesConfirmed: true,
  adsCostConfirmed: true,
  minimumMarginPct: 15,
  targetMarginPct: 20,
  manualMinPrice: null,
  manualMaxPrice: null,
};

Deno.test("calcula pisos iterativos de 15% e 20%", () => {
  const minimum = priceForNetMargin(economics, 15)!;
  const target = priceForNetMargin(economics, 20)!;
  if (minimum !== 110 || target !== 118.47) {
    throw new Error(`pisos inesperados: ${minimum}, ${target}`);
  }
  if ((economicsAtPrice(minimum, economics)?.marginPct || 0) < 15) {
    throw new Error("piso rompeu margem mínima");
  }
});

Deno.test("bloqueia dados ausentes em vez de tratar Ads como zero", () => {
  const result = validateRepricingEconomics({
    ...economics,
    adsCostPerOrder: null,
    adsCostConfirmed: false,
  });
  if (
    result.complete || !result.reasons.some((reason) => reason.includes("Ads"))
  ) throw new Error("Ads ausente deveria bloquear");
});

Deno.test("bloqueia custo unitario zero em vez de criar piso artificial", () => {
  const result = validateRepricingEconomics({
    ...economics,
    unitProductCost: 0,
  });
  if (result.complete || result.minimumProfitablePrice !== null) {
    throw new Error("custo zero jamais pode liberar repricing");
  }
});

Deno.test("bloqueia preco atual zero sem calcular percentual ou sugestao", () => {
  const decision = decideRepricing({
    economics,
    currentPrice: 0,
    competitionFresh: true,
    dailyUnits: 0,
    sessions: 0,
    conversionRate: 0,
    stock: 1,
    dataConfidence: 1,
    guardrails: {
      normalMaxChangePct: 3,
      dailyMaxChangePct: 10,
      minimumEffectiveChangePct: 1,
      cooldownHours: 6,
      minimumConfidence: 0.75,
    },
  });
  if (!decision.blocked || decision.suggestedPrice !== null) {
    throw new Error("preco atual zero deveria bloquear integralmente");
  }
});

Deno.test("rejeita preço mínimo manual abaixo do piso rentável", () => {
  const result = validateRepricingEconomics({
    ...economics,
    manualMinPrice: 100,
  });
  if (
    result.complete ||
    !result.reasons.some((reason) =>
      reason.includes("preço mínimo manual".toLowerCase()) ||
      reason.includes("Preço mínimo manual")
    )
  ) {
    throw new Error("piso manual inválido deveria bloquear");
  }
});

Deno.test("filtra usados, indisponíveis, outliers e prioriza FBA contra FBA", () => {
  const offers = equivalentCompetitorOffers([
    {
      totalPrice: 100,
      condition: "New",
      fulfillmentType: "AFN",
      available: true,
    },
    {
      totalPrice: 102,
      condition: "New",
      fulfillmentType: "AFN",
      available: true,
    },
    {
      totalPrice: 20,
      condition: "New",
      fulfillmentType: "AFN",
      available: true,
    },
    {
      totalPrice: 90,
      condition: "Used",
      fulfillmentType: "AFN",
      available: true,
    },
    {
      totalPrice: 95,
      condition: "New",
      fulfillmentType: "MFN",
      available: true,
    },
  ], "AFN");
  if (offers.length !== 2 || offers.some((offer) => offer.totalPrice < 90)) {
    throw new Error("filtro de equivalência falhou");
  }
});

Deno.test("só aprende elasticidade de pares reais com mudança material", () => {
  const learned = estimateObservedElasticity([
    { price: 100, dailyUnits: 10 },
    { price: 110, dailyUnits: 8 },
    { price: 120, dailyUnits: 7 },
  ]);
  if (
    !learned.elasticity || learned.observations !== 2 || learned.confidence <= 0
  ) throw new Error("elasticidade real não calculada");
});

Deno.test("recupera margem abaixo de 15% sem perseguir menor concorrente", () => {
  const decision = decideRepricing({
    economics,
    currentPrice: 100,
    featuredOfferPrice: 90,
    featuredOfferExpectedPrice: 92,
    competitorOffers: [{
      totalPrice: 20,
      condition: "New",
      fulfillmentType: "AFN",
      available: true,
    }],
    competitionFresh: true,
    sellerFulfillmentType: "AFN",
    dailyUnits: 2,
    sessions: 50,
    conversionRate: 0.04,
    stock: 20,
    daysOfSupply: 10,
    dataConfidence: 0.9,
    guardrails: {
      normalMaxChangePct: 3,
      dailyMaxChangePct: 10,
      minimumEffectiveChangePct: 1,
      cooldownHours: 6,
      minimumConfidence: 0.75,
    },
  });
  if (!decision.emergencyMarginRecovery || decision.suggestedPrice !== 110) {
    throw new Error(`recuperação insegura: ${decision.suggestedPrice}`);
  }
});

Deno.test("sem tráfego nunca recomenda redução", () => {
  const decision = decideRepricing({
    economics,
    currentPrice: 130,
    featuredOfferPrice: 115,
    featuredOfferExpectedPrice: 115,
    competitorOffers: [{
      totalPrice: 115,
      condition: "New",
      fulfillmentType: "AFN",
      available: true,
    }],
    competitionFresh: true,
    sellerFulfillmentType: "AFN",
    dailyUnits: 0,
    sessions: 0,
    conversionRate: 0,
    stock: 20,
    dataConfidence: 0.9,
    elasticity: 1,
    elasticityConfidence: 0.9,
    guardrails: {
      normalMaxChangePct: 3,
      dailyMaxChangePct: 10,
      minimumEffectiveChangePct: 1,
      cooldownHours: 6,
      minimumConfidence: 0.75,
    },
  });
  if (Number(decision.suggestedPrice) < 130) {
    throw new Error("reduziu preço sem tráfego");
  }
});
