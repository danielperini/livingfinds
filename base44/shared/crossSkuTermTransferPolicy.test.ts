import {
  areDistinctProductTargets,
  calculateCrossSkuSeedBid,
  crossSkuAttributeConflict,
  evaluateCrossSkuCandidate,
} from './crossSkuTermTransferPolicy.ts';

Deno.test('permite expandir entre SKUs distintos que compartilham ASIN', () => {
  if (!areDistinctProductTargets({
    source: { asin: 'B0SAMEASIN1', sku: 'FBA-RED', uniqueSku: true, uniqueAsin: false },
    destination: { asin: 'B0SAMEASIN1', sku: 'FBA-BLACK', uniqueSku: true, uniqueAsin: false },
  })) throw new Error('SKUs distintos do mesmo ASIN devem permanecer separados');
});

Deno.test('bloqueia SKU duplicado ou identidade ambígua', () => {
  if (areDistinctProductTargets({
    source: { asin: 'B0SAMEASIN1', sku: 'FBA-RED', uniqueSku: true, uniqueAsin: false },
    destination: { asin: 'B0SAMEASIN1', sku: 'FBA-RED', uniqueSku: true, uniqueAsin: false },
  })) throw new Error('mesmo SKU não é destino distinto');
  if (areDistinctProductTargets({
    source: { asin: 'B0SOURCE000', sku: 'FBA-SRC', uniqueSku: false, uniqueAsin: true },
    destination: { asin: 'B0DEST0000', sku: 'FBA-DST', uniqueSku: true, uniqueAsin: true },
  })) throw new Error('SKU ambíguo deve bloquear transferência');
});

const proven = {
  source: {
    asin: 'B0SOURCE000', sku: 'FBA-SRC', uniqueSku: true, uniqueAsin: true,
    term: 'lixeira automática com sensor', attributedOrders: 2, attributedSales: 160,
    spend: 16, attributionVerified: true, breakEvenAcos: 20,
  },
  destination: {
    asin: 'B0DEST0000', sku: 'FBA-DST', uniqueSku: true, uniqueAsin: true,
    availableFba: 12, stockFresh: true, adsAuthorized: true, listingBuyable: true,
    economicsComplete: true, safeMaxCpc: 0.62, exactAlreadyExists: false,
    promotionAlreadyExists: false,
  },
  relevance: { heuristicScore: 93, aiScore: 92, aiValidated: true },
};

Deno.test('aproveita termo com conversões verificadas, relevância e economia próprias do SKU destino', () => {
  const result = evaluateCrossSkuCandidate(proven);
  if (!result.eligible || result.effectiveRelevance !== 92) throw new Error(JSON.stringify(result));
});

Deno.test('não cria campanha quando a IA não validou a zona cinzenta', () => {
  const result = evaluateCrossSkuCandidate({
    ...proven,
    relevance: { heuristicScore: 93 },
  });
  if (result.eligible || result.reason !== 'ai_relevance_validation_required') throw new Error(JSON.stringify(result));
});

Deno.test('permite score heurístico muito alto quando a IA estiver indisponível', () => {
  const result = evaluateCrossSkuCandidate({
    ...proven,
    relevance: { heuristicScore: 97 },
  });
  if (!result.eligible) throw new Error(JSON.stringify(result));
});

Deno.test('bloqueia economia ausente, estoque desconhecido e destino sem autorização', () => {
  for (const patch of [
    { destination: { ...proven.destination, economicsComplete: false } },
    { destination: { ...proven.destination, availableFba: null } },
    { destination: { ...proven.destination, adsAuthorized: false } },
  ]) {
    const result = evaluateCrossSkuCandidate({ ...proven, ...patch });
    if (result.eligible) throw new Error('destino sem proteção deveria ser bloqueado');
  }
});

Deno.test('lance de expansão usa CPC de origem só como referência e obedece teto econômico do destino', () => {
  if (calculateCrossSkuSeedBid({
    sourceObservedCpc: 1.2, destinationSafeMaxCpc: 0.62, minBid: 0.25, maxBid: 3,
  }) !== 0.62) throw new Error('bid ultrapassou o safe CPC do destino');
  if (calculateCrossSkuSeedBid({
    sourceObservedCpc: 0.3, destinationSafeMaxCpc: 0.2, minBid: 0.25, maxBid: 3,
  }) !== null) throw new Error('não deve elevar bid acima do teto seguro para cumprir piso');
});

Deno.test('não transfere vendas do SKU de origem como resultado do destino', () => {
  const promotion = {
    destinationOrders: 0,
    destinationSales: 0,
    sourceOrders: proven.source.attributedOrders,
  };
  if (promotion.destinationOrders !== 0 || promotion.destinationSales !== 0 || promotion.sourceOrders === promotion.destinationOrders) {
    throw new Error('resultado da origem foi misturado ao destino');
  }
});

Deno.test('bloqueia falta de conversão same-SKU comprovada na origem', () => {
  const result = evaluateCrossSkuCandidate({
    ...proven,
    source: { ...proven.source, attributionVerified: false },
  });
  if (result.eligible || result.reason !== 'source_term_lacks_verified_same_sku_conversions') {
    throw new Error(JSON.stringify(result));
  }
});

Deno.test('a IA pode elevar um candidato de similaridade intermediária, mas a relevância combinada precisa atingir a meta', () => {
  const accepted = evaluateCrossSkuCandidate({ ...proven, relevance: { heuristicScore: 80, aiScore: 98, aiValidated: true, minimumScore: 90, minimumHeuristicScore: 70 } });
  if (!accepted.eligible || accepted.effectiveRelevance !== 91) throw new Error(JSON.stringify(accepted));
  const rejected = evaluateCrossSkuCandidate({ ...proven, relevance: { heuristicScore: 80, aiScore: 80, aiValidated: true, minimumScore: 90, minimumHeuristicScore: 70 } });
  if (rejected.eligible) throw new Error('score combinado abaixo da meta não deve criar campanha');
});

Deno.test('bloqueia termos de cor e tamanho incompatíveis entre SKUs', () => {
  if (crossSkuAttributeConflict('lixeira branca com sensor', 'Lixeira automática branca 15L', 'Lixeira automática preta 15L') !== 'cross_sku_color_mismatch') throw new Error('cor incompatível não bloqueada');
  if (crossSkuAttributeConflict('lixeira automática 15L', 'Lixeira automática 15L', 'Lixeira automática 12L') !== 'cross_sku_size_mismatch') throw new Error('tamanho incompatível não bloqueado');
  if (crossSkuAttributeConflict('lixeira automática com sensor', 'Lixeira automática branca 15L', 'Lixeira automática preta 12L') !== null) throw new Error('termo genérico foi bloqueado indevidamente');
});

