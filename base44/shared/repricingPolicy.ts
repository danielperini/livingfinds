export const HARD_MINIMUM_MARGIN_PCT = 15;

export type RepricingEconomicInputs = {
  unitProductCost: number | null;
  inboundFreight: number;
  packagingCost: number;
  additionalTax: number;
  otherCost: number;
  fbaFee: number | null;
  fixedAmazonFee: number | null;
  estimatedReturnCost: number;
  adsCostPerOrder: number | null;
  referralFeePct: number | null;
  /** Alíquota efetiva sobre o preço de venda (Simples Nacional: 7% nesta conta). */
  salesTaxPct?: number | null;
  costsConfirmed: boolean;
  feesConfirmed: boolean;
  adsCostConfirmed: boolean;
  minimumMarginPct?: number;
  targetMarginPct?: number;
  manualMinPrice?: number | null;
  manualMaxPrice?: number | null;
};

export type RepricingGuardrails = {
  normalMaxChangePct: number;
  dailyMaxChangePct: number;
  minimumEffectiveChangePct: number;
  cooldownHours: number;
  minimumConfidence: number;
};

export type CompetitorOffer = {
  totalPrice: number;
  listingPrice?: number;
  shippingPrice?: number;
  condition?: string;
  fulfillmentType?: string;
  sellerId?: string;
  available?: boolean;
  deliveryEquivalent?: boolean | null;
  isFeatured?: boolean;
};

export type RepricingDecisionInput = {
  economics: RepricingEconomicInputs;
  currentPrice: number;
  featuredOfferPrice?: number | null;
  featuredOfferExpectedPrice?: number | null;
  referenceAveragePrice?: number | null;
  similarReferenceAveragePrice?: number | null;
  similarReferenceCount?: number;
  competitorOffers?: CompetitorOffer[];
  competitionFresh: boolean;
  sellerFulfillmentType?: string | null;
  dailyUnits: number;
  sessions: number;
  conversionRate: number;
  adsClicks?: number;
  adsOrders?: number;
  adsConversionRate?: number | null;
  stock: number;
  daysOfSupply?: number | null;
  elasticity?: number | null;
  elasticityConfidence?: number;
  dataConfidence: number;
  lastPriceChangeAt?: string | null;
  absoluteChangeLast24hPct?: number;
  guardrails: RepricingGuardrails;
};

export type PriceCandidate = {
  price: number;
  sources: string[];
  marginPct: number;
  unitProfit: number;
  expectedDailyUnits: number | null;
  expectedDailyProfit: number | null;
};

const finite = (value: unknown): value is number =>
  value !== null && value !== undefined && value !== "" &&
  Number.isFinite(Number(value));
const roundMoney = (value: number) =>
  Math.round((value + Number.EPSILON) * 100) / 100;

/** Primeiro preço comercial terminado em ,90 que não fica abaixo do piso. */
export function commercialPrice90AtOrAbove(value: number): number {
  if (!finite(value) || Number(value) <= 0) return 0;
  const whole = Math.floor(Number(value));
  const candidate = whole + 0.90;
  return roundMoney(candidate + 0.000001 >= Number(value) ? candidate : whole + 1.90);
}
const round4 = (value: number) =>
  Math.round((value + Number.EPSILON) * 10000) / 10000;
const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

export function normalizeSku(value: unknown): string {
  return String(value || "").trim().toUpperCase().replace(/\s+/g, "-").replace(
    /-{2,}/g,
    "-",
  );
}

export function resolveMargins(minimum?: number, target?: number) {
  const minimumMarginPct = Math.max(
    HARD_MINIMUM_MARGIN_PCT,
    finite(minimum) ? Number(minimum) : HARD_MINIMUM_MARGIN_PCT,
  );
  const targetMarginPct = Math.max(
    minimumMarginPct,
    finite(target) ? Number(target) : 20,
  );
  return { minimumMarginPct, targetMarginPct };
}

export function fixedUnitCosts(inputs: RepricingEconomicInputs): number | null {
  if (
    !inputs.costsConfirmed || !finite(inputs.unitProductCost) ||
    Number(inputs.unitProductCost) <= 0
  ) return null;
  if (
    !inputs.feesConfirmed || !finite(inputs.fbaFee) || Number(inputs.fbaFee) < 0
  ) return null;
  if (!finite(inputs.fixedAmazonFee) || Number(inputs.fixedAmazonFee) < 0) {
    return null;
  }
  if (
    !inputs.adsCostConfirmed || !finite(inputs.adsCostPerOrder) ||
    Number(inputs.adsCostPerOrder) < 0
  ) return null;
  const values = [
    inputs.unitProductCost,
    inputs.inboundFreight,
    inputs.packagingCost,
    inputs.additionalTax,
    inputs.otherCost,
    inputs.fbaFee,
    inputs.fixedAmazonFee,
    inputs.estimatedReturnCost,
    inputs.adsCostPerOrder,
  ];
  if (values.some((value) => !finite(value) || Number(value) < 0)) return null;
  return roundMoney(values.reduce((sum, value) => sum + Number(value), 0));
}

export function economicsAtPrice(
  price: number,
  inputs: RepricingEconomicInputs,
) {
  const fixed = fixedUnitCosts(inputs);
  const referralPct = finite(inputs.referralFeePct)
    ? Number(inputs.referralFeePct)
    : null;
  // Compatibilidade com registros antigos: a conta opera no Simples a 7%.
  const salesTaxPct = finite(inputs.salesTaxPct)
    ? Number(inputs.salesTaxPct)
    : 7;
  if (
    !finite(price) || price <= 0 || fixed === null || referralPct === null ||
    referralPct < 0 || salesTaxPct < 0 ||
    referralPct + salesTaxPct >= 100
  ) {
    return null;
  }
  const referralFee = price * referralPct / 100;
  const salesTax = price * salesTaxPct / 100;
  const unitProfit = price - fixed - referralFee - salesTax;
  return {
    price: roundMoney(price),
    fixedCosts: fixed,
    referralFee: roundMoney(referralFee),
    salesTax: roundMoney(salesTax),
    unitProfit: roundMoney(unitProfit),
    marginPct: round4(unitProfit / price * 100),
  };
}

/** Bisseção deliberada: encontra o menor centavo que satisfaz a margem solicitada. */
export function priceForNetMargin(
  inputs: RepricingEconomicInputs,
  requestedMarginPct: number,
): number | null {
  const fixed = fixedUnitCosts(inputs);
  const referralPct = finite(inputs.referralFeePct)
    ? Number(inputs.referralFeePct)
    : null;
  const salesTaxPct = finite(inputs.salesTaxPct)
    ? Number(inputs.salesTaxPct)
    : 7;
  const marginPct = Math.max(
    HARD_MINIMUM_MARGIN_PCT,
    Number(requestedMarginPct || 0),
  );
  if (
    fixed === null || referralPct === null ||
    referralPct < 0 || salesTaxPct < 0 ||
    referralPct + salesTaxPct + marginPct >= 99.9
  ) return null;

  let low = Math.max(0.01, fixed);
  let high = Math.max(low * 2, 1);
  for (let i = 0; i < 40; i += 1) {
    const result = economicsAtPrice(high, inputs);
    if (result && result.marginPct >= marginPct) break;
    high *= 2;
  }
  for (let i = 0; i < 80; i += 1) {
    const mid = (low + high) / 2;
    const result = economicsAtPrice(mid, inputs);
    if (result && result.marginPct >= marginPct) high = mid;
    else low = mid;
  }
  let cents = Math.ceil((high - 1e-9) * 100) / 100;
  while (cents > 0.01) {
    const previous = roundMoney(cents - 0.01);
    const previousEconomics = economicsAtPrice(previous, inputs);
    if (!previousEconomics || previousEconomics.marginPct < marginPct) break;
    cents = previous;
  }
  return roundMoney(cents);
}

export function validateRepricingEconomics(inputs: RepricingEconomicInputs) {
  const reasons: string[] = [];
  const margins = resolveMargins(
    inputs.minimumMarginPct,
    inputs.targetMarginPct,
  );
  if (
    !inputs.costsConfirmed || !finite(inputs.unitProductCost) ||
    Number(inputs.unitProductCost) <= 0
  ) {
    reasons.push(
      "Custo do produto não informado ou não confirmado pelo usuário.",
    );
  }
  for (
    const [label, value] of [
      ["Frete de entrada", inputs.inboundFreight],
      ["Embalagem", inputs.packagingCost],
      ["Impostos adicionais", inputs.additionalTax],
      ["Outros custos", inputs.otherCost],
      ["Custo estimado de devolução", inputs.estimatedReturnCost],
    ] as Array<[string, number]>
  ) {
    if (!finite(value) || Number(value) < 0) reasons.push(`${label} inválido.`);
  }
  if (finite(inputs.salesTaxPct) && Number(inputs.salesTaxPct) < 0) {
    reasons.push("Alíquota de imposto sobre a venda inválida.");
  }
  if (
    !inputs.feesConfirmed || !finite(inputs.fbaFee) ||
    !finite(inputs.fixedAmazonFee) || !finite(inputs.referralFeePct)
  ) {
    reasons.push("Tarifas reais da Amazon ainda não foram confirmadas.");
  }
  if (!inputs.adsCostConfirmed || !finite(inputs.adsCostPerOrder)) {
    reasons.push(
      "Custo de Ads por pedido ainda não possui histórico confiável.",
    );
  }
  if (margins.minimumMarginPct < HARD_MINIMUM_MARGIN_PCT) {
    reasons.push("Margem mínima inferior a 15%.");
  }
  if (margins.targetMarginPct < margins.minimumMarginPct) {
    reasons.push("Margem-alvo inferior à margem mínima.");
  }

  const minimumProfitablePrice = reasons.length === 0
    ? priceForNetMargin(inputs, margins.minimumMarginPct)
    : null;
  const targetMarginPrice = reasons.length === 0
    ? priceForNetMargin(inputs, margins.targetMarginPct)
    : null;
  if (
    minimumProfitablePrice !== null && finite(inputs.manualMinPrice) &&
    Number(inputs.manualMinPrice) > 0 &&
    Number(inputs.manualMinPrice) < minimumProfitablePrice
  ) {
    reasons.push(
      `Preço mínimo manual inferior ao piso rentável de ${
        minimumProfitablePrice.toFixed(2)
      }.`,
    );
  }
  if (
    minimumProfitablePrice !== null && finite(inputs.manualMaxPrice) &&
    Number(inputs.manualMaxPrice) > 0 &&
    Number(inputs.manualMaxPrice) < minimumProfitablePrice
  ) {
    reasons.push(
      `Preço máximo manual inferior ao piso rentável de ${
        minimumProfitablePrice.toFixed(2)
      }.`,
    );
  }
  if (
    finite(inputs.manualMinPrice) && finite(inputs.manualMaxPrice) &&
    Number(inputs.manualMinPrice) > 0 && Number(inputs.manualMaxPrice) > 0 &&
    Number(inputs.manualMinPrice) > Number(inputs.manualMaxPrice)
  ) {
    reasons.push("Preço mínimo manual superior ao preço máximo manual.");
  }
  return {
    complete: reasons.length === 0,
    reasons,
    ...margins,
    minimumProfitablePrice,
    targetMarginPrice,
  };
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function equivalentCompetitorOffers(
  offers: CompetitorOffer[],
  sellerFulfillmentType?: string | null,
) {
  const requestedFulfillment = String(sellerFulfillmentType || "")
    .toUpperCase();
  const sameCondition = offers.filter((offer) =>
    finite(offer.totalPrice) && offer.totalPrice > 0 &&
    offer.available !== false &&
    !String(offer.condition || "new").toLowerCase().includes("used")
  );
  const sameFulfillment = requestedFulfillment
    ? sameCondition.filter((offer) =>
      String(offer.fulfillmentType || "").toUpperCase() === requestedFulfillment
    )
    : sameCondition;
  // Falha fechada: uma oferta MFN nunca vira referência para nosso SKU FBA
  // (ou vice-versa) apenas porque não houve oferta do mesmo fulfillment.
  const deliveryEquivalent = sameFulfillment.filter((offer) =>
    offer.deliveryEquivalent !== false
  );
  const center = median(
    deliveryEquivalent.map((offer) => Number(offer.totalPrice)),
  );
  if (center === null) return [];
  return deliveryEquivalent.filter((offer) =>
    offer.totalPrice >= center * 0.55 && offer.totalPrice <= center * 1.8
  );
}

export function estimateObservedElasticity(
  points: Array<{ price: number; dailyUnits: number }>,
) {
  const sorted = points
    .filter((point) =>
      finite(point.price) && point.price > 0 && finite(point.dailyUnits) &&
      point.dailyUnits > 0
    )
    .slice(-12);
  const estimates: number[] = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const before = sorted[i - 1];
    const after = sorted[i];
    const priceRatio = after.price / before.price;
    const unitRatio = after.dailyUnits / before.dailyUnits;
    if (Math.abs(priceRatio - 1) < 0.01 || Math.abs(unitRatio - 1) < 0.01) {
      continue;
    }
    const estimate = -Math.log(unitRatio) / Math.log(priceRatio);
    if (finite(estimate) && estimate > 0) {
      estimates.push(clamp(estimate, 0.1, 5));
    }
  }
  const value = median(estimates);
  return {
    elasticity: value === null ? null : round4(value),
    observations: estimates.length,
    confidence: round4(Math.min(1, estimates.length / 5)),
  };
}

function hoursSince(value?: string | null) {
  if (!value) return Number.POSITIVE_INFINITY;
  const time = new Date(value).getTime();
  return Number.isFinite(time)
    ? (Date.now() - time) / 3600000
    : Number.POSITIVE_INFINITY;
}

export function decideRepricing(input: RepricingDecisionInput) {
  const validation = validateRepricingEconomics(input.economics);
  const current = economicsAtPrice(input.currentPrice, input.economics);
  if (
    !validation.complete || !current ||
    validation.minimumProfitablePrice === null ||
    validation.targetMarginPrice === null
  ) {
    return {
      blocked: true,
      blockReasons: validation.reasons.length
        ? validation.reasons
        : ["Preço atual inválido."],
      suggestedPrice: null,
      candidates: [] as PriceCandidate[],
      minimumProfitablePrice: validation.minimumProfitablePrice,
      targetMarginPrice: validation.targetMarginPrice,
      currentEconomics: current,
      decisionReason:
        "Dados econômicos incompletos; nenhum preço pode ser publicado.",
      emergencyMarginRecovery: false,
      confidence: 0,
    };
  }
  if (!finite(input.stock) || Number(input.stock) <= 0) {
    return {
      blocked: true,
      blockReasons: ["Produto sem estoque vendável confirmado."],
      suggestedPrice: null,
      candidates: [] as PriceCandidate[],
      minimumProfitablePrice: validation.minimumProfitablePrice,
      targetMarginPrice: validation.targetMarginPrice,
      currentEconomics: current,
      decisionReason: "Produto sem estoque; preço atual preservado.",
      emergencyMarginRecovery: false,
      confidence: 0,
    };
  }

  const minimumAllowed = Math.max(
    validation.minimumProfitablePrice,
    finite(input.economics.manualMinPrice) &&
      Number(input.economics.manualMinPrice) > 0
      ? Number(input.economics.manualMinPrice)
      : 0,
  );
  const maximumAllowed = finite(input.economics.manualMaxPrice) &&
      Number(input.economics.manualMaxPrice) > 0
    ? Number(input.economics.manualMaxPrice)
    : Number.POSITIVE_INFINITY;
  const emergencyMarginRecovery =
    current.marginPct < validation.minimumMarginPct;
  const equivalentOffers = equivalentCompetitorOffers(
    input.competitorOffers || [],
    input.sellerFulfillmentType,
  );
  const competitorMedian = median(
    equivalentOffers.map((offer) => offer.totalPrice),
  );
  const raw = new Map<number, Set<string>>();
  const add = (value: unknown, source: string) => {
    if (!finite(value) || Number(value) <= 0) return;
    const price = roundMoney(Number(value));
    if (!raw.has(price)) raw.set(price, new Set());
    raw.get(price)!.add(source);
  };
  add(input.currentPrice, "current_price");
  for (const pct of [-2, -1, 1, 2, 3]) {
    add(
      input.currentPrice * (1 + pct / 100),
      `current_${pct > 0 ? "+" : ""}${pct}%`,
    );
  }
  add(validation.minimumProfitablePrice, "minimum_profitable_price");
  add(validation.targetMarginPrice, "target_margin_price");
  if (input.competitionFresh) {
    add(input.featuredOfferExpectedPrice, "featured_offer_expected_price");
    add(input.featuredOfferPrice, "featured_offer_price");
    add(competitorMedian, "equivalent_competitor_median");
    add(input.referenceAveragePrice, "amazon_reference_price_average");
    add(input.similarReferenceAveragePrice, "similar_products_90pct_average");
  }

  const lowStock = input.stock > 0 &&
    (input.stock <= 5 ||
      (finite(input.daysOfSupply) && Number(input.daysOfSupply) <= 14));
  const noTraffic = input.sessions <= 0;
  const reliableElasticity = finite(input.elasticity) &&
    Number(input.elasticity) > 0 &&
    Number(input.elasticityConfidence || 0) >=
      input.guardrails.minimumConfidence;
  const currentDailyUnits = Math.max(0, Number(input.dailyUnits || 0));
  const adsClicks = Math.max(0, Number(input.adsClicks || 0));
  const adsConversionRate = finite(input.adsConversionRate)
    ? Number(input.adsConversionRate)
    : adsClicks > 0 ? Number(input.adsOrders || 0) / adsClicks : null;
  const candidates: PriceCandidate[] = [];

  for (const [price, sources] of raw.entries()) {
    if (price + 0.001 < minimumAllowed || price - 0.001 > maximumAllowed) {
      continue;
    }
    const changePct = (price - input.currentPrice) / input.currentPrice * 100;
    if (
      !emergencyMarginRecovery &&
      Math.abs(changePct) > input.guardrails.normalMaxChangePct + 0.01
    ) continue;
    if (
      !emergencyMarginRecovery &&
      Number(input.absoluteChangeLast24hPct || 0) + Math.abs(changePct) >
        input.guardrails.dailyMaxChangePct + 0.01
    ) continue;
    if (noTraffic && changePct < 0) continue;
    if (lowStock && changePct < 0) continue;
    const economic = economicsAtPrice(price, input.economics);
    if (
      !economic || economic.marginPct + 0.0001 < validation.minimumMarginPct
    ) continue;
    const expectedDailyUnits = Math.abs(changePct) < 0.01
      ? currentDailyUnits
      : reliableElasticity
      ? round4(
        currentDailyUnits *
          Math.pow(price / input.currentPrice, -Number(input.elasticity)),
      )
      : null;
    candidates.push({
      price,
      sources: [...sources],
      marginPct: economic.marginPct,
      unitProfit: economic.unitProfit,
      expectedDailyUnits,
      expectedDailyProfit: expectedDailyUnits === null
        ? null
        : roundMoney(economic.unitProfit * expectedDailyUnits),
    });
  }

  const currentCandidate =
    candidates.find((candidate) =>
      Math.abs(candidate.price - input.currentPrice) < 0.005
    ) || null;
  const targetMarginPrice = validation.targetMarginPrice as number;
  let selected = currentCandidate;
  let decisionReason =
    "Preço preservado: não há evidência econômica suficiente para uma alteração segura.";

  if (emergencyMarginRecovery) {
    selected = candidates
      .filter((candidate) => candidate.price + 0.001 >= minimumAllowed)
      .sort((a, b) => a.price - b.price)[0] || null;
    decisionReason = "Recuperação obrigatória da margem mínima de 15%.";
  } else if (
    reliableElasticity &&
    candidates.some((candidate) => candidate.expectedDailyProfit !== null)
  ) {
    const ranked = candidates
      .filter((candidate) => candidate.expectedDailyProfit !== null)
      .sort((a, b) =>
        Number(b.expectedDailyProfit) - Number(a.expectedDailyProfit)
      );
    const best = ranked[0] || currentCandidate;
    const currentProfit = Number(currentCandidate?.expectedDailyProfit || 0);
    if (
      best &&
      (currentProfit <= 0 ||
        Number(best.expectedDailyProfit) >= currentProfit * 1.02)
    ) {
      selected = best;
      decisionReason =
        "Preço selecionado pelo maior lucro diário esperado com elasticidade observada.";
    }
  } else if (
    adsClicks >= 20 && finite(adsConversionRate) && adsConversionRate < 0.03 &&
    input.competitionFresh &&
    finite(competitorMedian ?? input.similarReferenceAveragePrice) &&
    input.currentPrice > Number(competitorMedian ?? input.similarReferenceAveragePrice) * 1.03
  ) {
    const marketReference = Number(competitorMedian ?? input.similarReferenceAveragePrice);
    selected = candidates
      .filter((candidate) => candidate.price < input.currentPrice && candidate.price >= Math.min(marketReference, input.currentPrice))
      .sort((a, b) => a.price - b.price)[0] || candidates
      .filter((candidate) => candidate.price < input.currentPrice)
      .sort((a, b) => b.price - a.price)[0] || currentCandidate;
    decisionReason = selected && selected.price < input.currentPrice
      ? "Redução protegida: conversão Ads por clique abaixo de 3% e preço acima da concorrência, sem cruzar 15% de margem líquida."
      : decisionReason;
  } else if (lowStock && current.marginPct >= validation.minimumMarginPct) {
    selected = candidates
      .filter((candidate) =>
        candidate.price > input.currentPrice &&
        candidate.price <= targetMarginPrice
      )
      .sort((a, b) => a.price - b.price)[0] || currentCandidate;
    decisionReason = selected && selected.price > input.currentPrice
      ? "Aumento gradual para preservar cobertura de estoque e aproximar a margem-alvo."
      : decisionReason;
  } else if (current.marginPct < validation.targetMarginPct) {
    selected = candidates
      .filter((candidate) =>
        candidate.price > input.currentPrice &&
        candidate.price <= targetMarginPrice
      )
      .sort((a, b) => a.price - b.price)[0] || currentCandidate;
    decisionReason = selected && selected.price > input.currentPrice
      ? "Aumento gradual em direção à margem-alvo de 20%."
      : decisionReason;
  } else if (
    input.sessions > 0 && currentDailyUnits === 0 && input.competitionFresh &&
    finite(input.featuredOfferExpectedPrice)
  ) {
    selected = candidates
      .filter((candidate) =>
        candidate.price < input.currentPrice &&
        candidate.sources.includes("featured_offer_expected_price")
      )
      .sort((a, b) => b.price - a.price)[0] || currentCandidate;
    decisionReason = selected && selected.price < input.currentPrice
      ? "Redução limitada baseada no Featured Offer Expected Price real, sem cruzar o piso rentável."
      : decisionReason;
  }

  const suggestedPrice = selected?.price ?? input.currentPrice;
  const effectiveChangePct = Math.abs(
    (suggestedPrice - input.currentPrice) / input.currentPrice * 100,
  );
  const inCooldown =
    hoursSince(input.lastPriceChangeAt) < input.guardrails.cooldownHours;
  const confidence = emergencyMarginRecovery
    ? clamp(input.dataConfidence, 0, 1)
    : clamp(
      Math.min(
        input.dataConfidence,
        reliableElasticity
          ? Number(input.elasticityConfidence)
          : input.dataConfidence * 0.7,
      ),
      0,
      1,
    );
  const actionable =
    effectiveChangePct + 0.0001 >= input.guardrails.minimumEffectiveChangePct;
  const blockReasons: string[] = [];
  if (!input.competitionFresh && !emergencyMarginRecovery) {
    blockReasons.push(
      "Dados de concorrência estão ausentes ou desatualizados.",
    );
  }
  if (inCooldown) {
    blockReasons.push("Produto ainda está no período de cooldown.");
  }
  if (!actionable) {
    blockReasons.push("Alteração inferior ao mínimo efetivo configurado.");
  }
  if (
    !emergencyMarginRecovery && confidence < input.guardrails.minimumConfidence
  ) blockReasons.push("Confiança insuficiente para publicação automática.");

  return {
    blocked: false,
    blockReasons,
    suggestedPrice: roundMoney(suggestedPrice),
    candidates,
    minimumProfitablePrice: validation.minimumProfitablePrice,
    targetMarginPrice: validation.targetMarginPrice,
    currentEconomics: current,
    projectedEconomics: selected
      ? economicsAtPrice(selected.price, input.economics)
      : current,
    expectedDailyProfit: selected?.expectedDailyProfit ?? null,
    expectedDailyUnits: selected?.expectedDailyUnits ?? null,
    decisionReason,
    emergencyMarginRecovery,
    effectiveChangePct: round4(effectiveChangePct),
    confidence: round4(confidence),
    automaticEligible: actionable && !inCooldown &&
      (emergencyMarginRecovery ||
        confidence >= input.guardrails.minimumConfidence),
    competitorMedian: competitorMedian === null
      ? null
      : roundMoney(competitorMedian),
    equivalentOfferCount: equivalentOffers.length,
  };
}
