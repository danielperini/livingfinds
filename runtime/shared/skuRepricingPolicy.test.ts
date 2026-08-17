import { decideSkuRepricing } from './skuRepricingPolicy.ts';

function assert(value: unknown, message = 'assertion failed'): asserts value {
  if (!value) throw new Error(message);
}

const base = {
  sku: 'FBA-0087B',
  asin: 'B0CHILD001',
  policy: {
    minimumConfidence: 0.90,
    minimumProfitAmount: 8,
    minimumProfitPercent: 8,
    maxDecreasePercentPerCycle: 3,
    maxIncreasePercentPerCycle: 5,
    maxDailyChangePercent: 8,
    targetAcos: 20,
  },
  economics: {
    currentPrice: 87.2,
    unitCost: 40.95,
    totalVariableCostPerUnit: 55,
    amazonFeePercent: 15,
    breakEvenAcos: 35,
    targetAcos: 20,
    profitAfterAds: 12,
  },
  market: {
    ownSellerId: 'SELLER',
    featuredOfferSellerId: 'OTHER',
    featuredOfferPrice: 89,
    lowestCompetitorPrice: 88.9,
    featuredOfferExpectedPrice: 88.8,
    wasPrice: 92,
  },
  performance: {
    adSpend: 100,
    adSales: 500,
    adOrders: 6,
    currentAcos: 20,
    daysObserved: 30,
  },
  inventory: {
    availableQuantity: 44,
    daysOfSupply: 35,
    signalQuality: 'sufficient',
  },
  confidenceSignals: {
    uniqueSkuMapping: true,
    listingFresh: true,
    economicsActionable: true,
    inventoryFresh: true,
    salesAndAdsFresh: true,
    competitiveSummaryFresh: true,
    foepAvailable: true,
    validationPreviewAccepted: true,
    noAnomalies: true,
  },
};

Deno.test('SKU com todos os sinais pode alterar preço automaticamente', () => {
  const decision = decideSkuRepricing(base);
  assert(decision.confidence >= 0.90);
  assert(decision.action === 'increase');
  assert(decision.proposedPrice > decision.currentPrice);
});

Deno.test('variação sem SKU inequívoco é bloqueada', () => {
  const decision = decideSkuRepricing({
    ...base,
    confidenceSignals: { ...base.confidenceSignals, uniqueSkuMapping: false },
  });
  assert(decision.action === 'blocked');
  assert(decision.blockers.includes('ambiguous_sku_mapping'));
});

Deno.test('estoque baixo nunca reduz preço', () => {
  const decision = decideSkuRepricing({
    ...base,
    market: { ...base.market, featuredOfferExpectedPrice: 75, featuredOfferPrice: 76 },
    inventory: { ...base.inventory, daysOfSupply: 5 },
  });
  assert(decision.proposedPrice >= base.economics.currentPrice);
});

Deno.test('ACoS acima da meta impede redução de preço', () => {
  const decision = decideSkuRepricing({
    ...base,
    market: { ...base.market, featuredOfferExpectedPrice: 75, featuredOfferPrice: 76 },
    performance: { ...base.performance, currentAcos: 31 },
  });
  assert(decision.proposedPrice >= base.economics.currentPrice);
});

Deno.test('prévia Amazon ausente bloqueia execução', () => {
  const decision = decideSkuRepricing({
    ...base,
    confidenceSignals: { ...base.confidenceSignals, validationPreviewAccepted: false },
  });
  assert(decision.action === 'blocked');
  assert(decision.blockers.includes('validation_preview_not_accepted'));
});
