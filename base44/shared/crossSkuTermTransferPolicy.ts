export type CrossSkuCandidateInput = {
  source: {
    asin: string;
    sku: string;
    uniqueSku: boolean;
    uniqueAsin: boolean;
    term: string;
    attributedOrders: number;
    attributedSales: number;
    spend: number;
    attributionVerified: boolean;
    breakEvenAcos: number;
    description?: string;
  };
  destination: {
    asin: string;
    sku: string;
    uniqueSku: boolean;
    uniqueAsin: boolean;
    availableFba: number | null;
    stockFresh: boolean;
    adsAuthorized: boolean;
    listingBuyable: boolean;
    economicsComplete: boolean;
    safeMaxCpc: number;
    exactAlreadyExists: boolean;
    promotionAlreadyExists: boolean;
    description?: string;
  };
  relevance: {
    heuristicScore: number;
    aiScore?: number | null;
    aiValidated?: boolean;
    minimumScore?: number;
    heuristicOnlyMinimum?: number;
    minimumHeuristicScore?: number;
  };
};

export type CrossSkuCandidateResult = {
  eligible: boolean;
  reason: string;
  effectiveRelevance: number;
};

const identity = (value: unknown) => String(value ?? '').trim().toUpperCase();
const finite = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;

/**
 * SKU is the primary seller-offer identity. A shared ASIN may represent distinct
 * sellable SKUs/variants; those remain distinct only when both SKU mappings are unique.
 * ASIN-only fallback is permitted solely for distinct, unique ASINs.
 */
export function areDistinctProductTargets(input: {
  source: { asin: string; sku: string; uniqueSku: boolean; uniqueAsin: boolean };
  destination: { asin: string; sku: string; uniqueSku: boolean; uniqueAsin: boolean };
}): boolean {
  const sourceSku = identity(input.source.sku);
  const destinationSku = identity(input.destination.sku);
  if (sourceSku && destinationSku) {
    return sourceSku !== destinationSku && input.source.uniqueSku && input.destination.uniqueSku;
  }
  const sourceAsin = identity(input.source.asin);
  const destinationAsin = identity(input.destination.asin);
  return Boolean(
    sourceAsin && destinationAsin && sourceAsin !== destinationAsin &&
    input.source.uniqueAsin && input.destination.uniqueAsin
  );
}


export function crossSkuAttributeConflict(term: unknown, sourceDescription: unknown, destinationDescription: unknown): string | null {
  const query = identity(term).toLowerCase();
  const source = identity(sourceDescription).toLowerCase();
  const destination = identity(destinationDescription).toLowerCase();
  const voltage = (text: string): string[] => text.match(/\b(?:110\s*v|127\s*v|220\s*v|bivolt)\b/g) || [];
  const sourceVoltage = voltage(source)[0];
  const destinationVoltage = voltage(destination)[0];
  if (sourceVoltage && destinationVoltage && sourceVoltage !== destinationVoltage &&
      sourceVoltage !== 'bivolt' && destinationVoltage !== 'bivolt' && query.includes(sourceVoltage)) {
    return 'cross_sku_voltage_mismatch';
  }
  const size = (text: string): string[] => text.match(/\b\d{1,4}\s*(?:l|ml|cm|mm|gb|w)\b/g) || [];
  const sourceSizes = size(source);
  const destinationSizes = size(destination);
  if (sourceSizes.length && destinationSizes.length &&
      !sourceSizes.some((value) => destinationSizes.includes(value)) &&
      sourceSizes.some((value) => query.includes(value))) {
    return 'cross_sku_size_mismatch';
  }
  const colorGroups = [
    ['preto', 'preta', 'black'],
    ['branco', 'branca', 'white'],
    ['cinza', 'gray', 'grey'],
    ['vermelho', 'vermelha', 'red'],
    ['azul', 'blue'],
    ['verde', 'green'],
  ];
  const sourceColorGroup = colorGroups.find((group) => group.some((color) => source.includes(color)));
  const destinationColorGroup = colorGroups.find((group) => group.some((color) => destination.includes(color)));
  if (sourceColorGroup && destinationColorGroup && sourceColorGroup !== destinationColorGroup &&
      sourceColorGroup.some((color) => query.includes(color))) {
    return 'cross_sku_color_mismatch';
  }
  const types = ['microfone lapela', 'microfone condensador', 'headset', 'moedor', 'lixeira', 'interruptor', 'fechadura', 'projetor', 'adaptador'];
  const sourceType = types.find((type) => source.includes(type));
  const destinationType = types.find((type) => destination.includes(type));
  if (sourceType && destinationType && sourceType !== destinationType && query.includes(sourceType)) {
    return 'cross_sku_product_type_mismatch';
  }
  return null;
}

/** Validate a cross-SKU term without transferring source sales/economics to destination. */
export function evaluateCrossSkuCandidate(input: CrossSkuCandidateInput): CrossSkuCandidateResult {
  const { source, destination, relevance } = input;
  const minScore = Math.max(0, finite(relevance.minimumScore) || 90);
  const minimumHeuristicScore = Math.max(0, finite(relevance.minimumHeuristicScore) || 70);
  const heuristicOnlyMinimum = Math.max(minScore, finite(relevance.heuristicOnlyMinimum) || 95);
  const heuristic = Math.max(0, Math.min(100, finite(relevance.heuristicScore)));
  const aiScore = relevance.aiScore == null ? null : Math.max(0, Math.min(100, finite(relevance.aiScore)));
  const effectiveRelevance = relevance.aiValidated && aiScore != null
    ? Math.round(heuristic * 0.4 + aiScore * 0.6)
    : heuristic;

  const reject = (reason: string): CrossSkuCandidateResult => ({
    eligible: false, reason, effectiveRelevance,
  });

  if (!areDistinctProductTargets({ source, destination })) return reject('same_or_ambiguous_product_identity');
  if (!source.attributionVerified || finite(source.attributedOrders) < 2 || finite(source.attributedSales) <= 0) {
    return reject('source_term_lacks_verified_same_sku_conversions');
  }
  const sourceAcos = finite(source.spend) > 0
    ? finite(source.spend) / finite(source.attributedSales) * 100
    : 0;
  if (finite(source.breakEvenAcos) <= 0 || sourceAcos > finite(source.breakEvenAcos)) {
    return reject('source_term_not_economically_proven');
  }
  if (String(source.term || '').trim().split(/\s+/).filter(Boolean).length < 3) {
    return reject('term_too_short_for_cross_sku_transfer');
  }
  if (destination.availableFba == null || !Number.isFinite(Number(destination.availableFba))) {
    return reject('destination_fba_unknown');
  }
  if (finite(destination.availableFba) <= 0) return reject('destination_fba_unavailable');
  if (!destination.stockFresh) return reject('destination_stock_stale');
  if (!destination.adsAuthorized) return reject('destination_ads_not_authorized');
  if (!destination.listingBuyable) return reject('destination_offer_not_buyable');
  if (!destination.economicsComplete || finite(destination.safeMaxCpc) <= 0) {
    return reject('destination_economics_or_safe_cpc_missing');
  }
  if (destination.exactAlreadyExists) return reject('destination_exact_already_exists');
  if (destination.promotionAlreadyExists) return reject('destination_promotion_already_exists');
  if (heuristic < minimumHeuristicScore) return reject('product_or_term_relevance_below_threshold');
  if (heuristic < heuristicOnlyMinimum && !relevance.aiValidated) return reject('ai_relevance_validation_required');
  if (relevance.aiValidated && aiScore == null) return reject('ai_relevance_score_invalid');
  if (relevance.aiValidated && aiScore != null && aiScore < minScore) return reject('ai_relevance_below_threshold');
  if (effectiveRelevance < minScore) return reject('combined_relevance_below_threshold');

  return { eligible: true, reason: 'verified_cross_sku_candidate', effectiveRelevance };
}

/**
 * Seed a destination test with the observed source CPC, capped by destination SKU
 * economics. This never copies source conversion rate, margin, or sales to destination.
 */
export function calculateCrossSkuSeedBid(input: {
  sourceObservedCpc: number;
  destinationSafeMaxCpc: number;
  minBid: number;
  maxBid: number;
}): number | null {
  const sourceCpc = finite(input.sourceObservedCpc);
  const destinationCap = finite(input.destinationSafeMaxCpc);
  const minBid = Math.max(0, finite(input.minBid));
  const maxBid = finite(input.maxBid);
  if (sourceCpc <= 0 || destinationCap <= 0 || maxBid < minBid) return null;
  const safeCap = Math.min(sourceCpc * 0.85, destinationCap, maxBid);
  if (safeCap < minBid) return null;
  return Math.round(safeCap * 100) / 100;
}

