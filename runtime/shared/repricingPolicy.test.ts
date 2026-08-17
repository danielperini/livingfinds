import {
  commercialPrice90AtOrAbove,
  decideRepricing,
  economicsAtPrice,
  equivalentCompetitorOffers,
  estimateObservedElasticity,
  priceForNetMargin,
  validateRepricingEconomics,
} from "./repricingPolicy.ts";

Deno.test("arredonda sempre para cima no formato comercial terminado em ,90", () => {
  const cases = [[75, 75.90], [75.89, 75.90], [75.90, 75.90], [75.91, 76.90], [110, 110.90]];
  for (const [input, expected] of cases) {
    const actual = commercialPrice90AtOrAbove(input);
    if (actual !== expected) throw new Error(`${input} deveria resultar em ${expected}, recebeu ${actual}`);
    if (actual + 0.0001 < input) throw new Error("arredondamento reduziu o piso econômico");
  }
});

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

Deno.test("sugere redução segura quando preço supera concorrência e Ads converte abaixo de 3%", () => {
  const result = decideRepricing({
    economics,
    currentPrice: 130,
    competitorOffers: [{ totalPrice: 120, condition: "New", fulfillmentType: "AFN", available: true }],
    competitionFresh: true,
    sellerFulfillmentType: "AFN",
    dailyUnits: 1,
    sessions: 100,
    conversionRate: 0.03,
    adsClicks: 100,
    adsOrders: 2,
    adsConversionRate: 0.02,
    stock: 50,
    dataConfidence: 1,
    guardrails: {
      normalMaxChangePct: 3, dailyMaxChangePct: 10, minimumEffectiveChangePct: 1,
      cooldownHours: 6, minimumConfidence: 0.96,
    },
  });
  if (!(Number(result.suggestedPrice) < 130)) throw new Error("deveria sugerir redução");
  if ((result.projectedEconomics?.marginPct || 0) < 15) throw new Error("redução rompeu margem mínima");
});

Deno.test("bloqueia custo unitario negativo", () => {
  const result = validateRepricingEconomics({ ...economics, unitProductCost: -1 });
  if (result.complete || result.minimumProfitablePrice !== null) {
    throw new Error("custo negativo jamais pode liberar repricing");
  }
});

Deno.test("bloqueia custo vazio ou texto invalido", () => {
  for (const invalid of ["", "abc"] as unknown[]) {
    const result = validateRepricingEconomics({
      ...economics,
      unitProductCost: invalid as number,
    });
    if (result.complete) throw new Error(`custo invalido foi aceito: ${invalid}`);
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

Deno.test("bloqueia preco sugerido zero ou abaixo do piso", () => {
  const zero = economicsAtPrice(0, economics);
  const belowFloor = economicsAtPrice(109.99, economics);
  if (zero !== null) throw new Error("preco zero deveria ser invalido");
  if (!belowFloor || belowFloor.marginPct >= 15) {
    throw new Error("cenario abaixo do piso nao foi reproduzido");
  }
});

Deno.test("bloqueia piso rentavel ausente quando tarifas faltam", () => {
  const result = validateRepricingEconomics({
    ...economics,
    fbaFee: null,
    feesConfirmed: false,
  });
  if (result.complete || result.minimumProfitablePrice !== null) {
    throw new Error("piso ausente deveria bloquear");
  }
});

Deno.test("margem projetada abaixo de 15 por cento nunca e candidata", () => {
  const decision = decideRepricing({
    economics,
    currentPrice: 130,
    featuredOfferPrice: 100,
    featuredOfferExpectedPrice: 100,
    competitorOffers: [{ totalPrice: 100, condition: "New", fulfillmentType: "AFN", available: true }],
    competitionFresh: true,
    sellerFulfillmentType: "AFN",
    dailyUnits: 1,
    sessions: 30,
    conversionRate: 0.03,
    stock: 20,
    dataConfidence: 1,
    guardrails: { normalMaxChangePct: 30, dailyMaxChangePct: 30, minimumEffectiveChangePct: 1, cooldownHours: 6, minimumConfidence: 0.75 },
  });
  if (decision.candidates.some((candidate) => candidate.marginPct < 15)) {
    throw new Error("candidato abaixo da margem minima foi aceito");
  }
});

Deno.test("bloqueia produto sem estoque para reducao de preco", () => {
  const decision = decideRepricing({
    economics,
    currentPrice: 130,
    featuredOfferExpectedPrice: 120,
    competitionFresh: true,
    dailyUnits: 0,
    sessions: 30,
    conversionRate: 0,
    stock: 0,
    dataConfidence: 1,
    guardrails: { normalMaxChangePct: 10, dailyMaxChangePct: 10, minimumEffectiveChangePct: 1, cooldownHours: 6, minimumConfidence: 0.75 },
  });
  if (!decision.blocked || decision.suggestedPrice !== null) {
    throw new Error("produto sem estoque deveria preservar integralmente o preço");
  }
});

Deno.test("bloqueia tarifas ausentes e Ads sem historico confiavel", () => {
  const missingFees = validateRepricingEconomics({ ...economics, feesConfirmed: false });
  const missingAds = validateRepricingEconomics({ ...economics, adsCostConfirmed: false });
  if (missingFees.complete || missingAds.complete) {
    throw new Error("economia incompleta foi aceita");
  }
});

Deno.test("concorrencia desatualizada nao autoriza automacao", () => {
  const decision = decideRepricing({
    economics,
    currentPrice: 130,
    competitionFresh: false,
    dailyUnits: 2,
    sessions: 50,
    conversionRate: 0.04,
    stock: 20,
    dataConfidence: 1,
    guardrails: { normalMaxChangePct: 3, dailyMaxChangePct: 10, minimumEffectiveChangePct: 1, cooldownHours: 6, minimumConfidence: 0.75 },
  });
  if (decision.automaticEligible || !decision.blockReasons.some((reason) => reason.includes("concorr"))) {
    throw new Error("concorrencia desatualizada deveria bloquear automacao");
  }
});

Deno.test("nao compara MFN com FBA quando nao existe oferta equivalente", () => {
  const offers = equivalentCompetitorOffers([{ totalPrice: 80, condition: "New", fulfillmentType: "MFN", available: true }], "AFN");
  if (offers.length) throw new Error("oferta MFN foi usada como referencia para FBA");
});

Deno.test("tentativa manual abaixo do piso permanece bloqueada", () => {
  const result = validateRepricingEconomics({ ...economics, manualMaxPrice: 100 });
  if (result.complete || !result.reasons.some((reason) => reason.includes("máximo manual"))) {
    throw new Error("limite manual inseguro foi aceito");
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
