export type SameSkuAttribution = {
  windowDays: number;
  totalOrders: number;
  totalSales: number;
  sameSkuOrders: number;
  sameSkuSales: number;
  haloOrders: number;
  haloSales: number;
  verified: boolean;
  source: string;
};

export type HarvestSource = {
  campaignId: string;
  adGroupId: string;
  keywordId: string;
  matchType: string;
  campaignType: string;
};

export type HarvestAggregate = {
  asin: string;
  sku: string;
  term: string;
  normalizedTerm: string;
  termFamilyKey: string;
  rawVariants: string[];
  impressions: number;
  clicks: number;
  spend: number;
  totalOrders: number;
  totalSales: number;
  sameSkuOrders: number;
  sameSkuSales: number;
  haloOrders: number;
  haloSales: number;
  latestDate: string;
  sourceRows: any[];
  sources: HarvestSource[];
  attributionVerified: boolean;
  skuResolutionVerified: boolean;
  /**
   * NEW: Tracks deterministic fallback single_advertised_sku
   * "single_advertised_sku" = adgroup anuncios só este SKU, orders>0, nenhuma multipla coluna available
   * Nunca presumir quando houver múltiplos SKUs no adgroup ou quando colunas promoted/attributed forem explícitas
   */
  attributionFallbackReason?: string;
};

const own = (row: any, key: string) => Object.prototype.hasOwnProperty.call(row || {}, key);

export function numberValue(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function normalizeSearchTerm(value: unknown): string {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

const TERM_ALIASES: Record<string, string> = {
  'p': 'para',
  'p/': 'para',
  'pra': 'para',
  'pro': 'para o',
  'c': 'com',
  'c/': 'com',
  's': 'sem',
  's/': 'sem',
  'vc': 'voce',
  'tbm': 'tambem',
};

const TERM_TYPOS: Record<string, string> = {
  'lixera': 'lixeira',
  'lixiera': 'lixeira',
  'eletroncia': 'eletronica',
  'eletonica': 'eletronica',
  'automaticaa': 'automatica',
};

export function canonicalSearchTermFamily(value: unknown): string {
  const tokens = normalizeSearchTerm(value).split(' ').filter(Boolean);
  const resolved: string[] = [];
  for (const token of tokens) {
    if (TERM_TYPOS[token]) {
      resolved.push(TERM_TYPOS[token]);
      continue;
    }
    const alias = TERM_ALIASES[token];
    if (alias) {
      resolved.push(...alias.split(' '));
      continue;
    }
    resolved.push(token);
  }
  return resolved.join(' ').replace(/\s+/g, ' ').trim();
}

export function isAsinSearchTerm(value: unknown): boolean {
  // Product targets can use any 10-character ASIN, not only the current B0…
  // generation. They are targets, never customer search queries, and must not
  // become Manual Exact keywords (e.g. b07y44flcx).
  return /^[A-Z0-9]{10}$/i.test(String(value || '').trim());
}

function firstPresent(row: any, fields: string[]): { present: boolean; value: number; field: string } {
  for (const field of fields) {
    if (own(row, field)) return { present: true, value: numberValue(row[field]), field };
  }
  return { present: false, value: 0, field: '' };
}

/**
 * NEW: Avalia se um resultado pode usar fallback determinístico single_advertised_sku
 * Regra:
 *   - Não pode haver colunas promoted/attributed explícitas (aquelas significam "multi-sku adgroup")
 *   - Deve haver orders > 0 na janela
 *   - sku_resolution_status deve ser single_advertised_sku (ou similar signal)
 *   - Nunca presumir se não houver sinal claro
 */
function canUseSingleAdvertisedSkuFallback(row: any): boolean {
  // Se existem colunas promoted/attributed/same-sku/other-sku explícitas, NÃO usar fallback
  const explicitColumns = [
    'promoted_purchases_1d', 'promoted_purchases_7d', 'promoted_purchases_14d', 'promoted_purchases_30d',
    'promoted_sales_1d', 'promoted_sales_7d', 'promoted_sales_14d', 'promoted_sales_30d',
    'purchases_same_sku_1d', 'purchases_same_sku_7d', 'purchases_same_sku_14d', 'purchases_same_sku_30d',
    'purchases_other_sku_1d', 'purchases_other_sku_7d', 'purchases_other_sku_14d', 'purchases_other_sku_30d',
    'attributed_sales_same_sku_1d', 'attributed_sales_same_sku_7d', 'attributed_sales_same_sku_14d', 'attributed_sales_same_sku_30d',
    'sales_other_sku_1d', 'sales_other_sku_7d', 'sales_other_sku_14d', 'sales_other_sku_30d',
  ];
  for (const col of explicitColumns) {
    if (own(row, col)) return false;
  }

  // Se sku_resolution_status indica single_advertised_sku, OK
  const resolutionStatus = String(row.sku_resolution_status || '');
  if (resolutionStatus === 'single_advertised_sku') return true;

  // Sem sinal claro: não presumir
  return false;
}

export function resolveSameSkuAttribution(row: any): SameSkuAttribution {
  const windows = [7, 14, 30, 1];

  // Tentar fallback single_advertised_sku se disponível
  const canFallback = canUseSingleAdvertisedSkuFallback(row);
  if (canFallback) {
    for (const days of windows) {
      const totalOrders = firstPresent(row, [`purchases${days}d`]);
      const totalSales = firstPresent(row, [`sales${days}d`]);
      if (!totalOrders.present && !totalSales.present) continue;
      if (totalOrders.value > 0 || totalSales.value > 0) {
        // Fallback: 100% do total é mesmo SKU, pois adgroup anuncia só este SKU
        return {
          windowDays: days,
          totalOrders: totalOrders.value,
          totalSales: totalSales.value,
          sameSkuOrders: totalOrders.value,
          sameSkuSales: totalSales.value,
          haloOrders: 0,
          haloSales: 0,
          verified: true,
          source: `single_advertised_sku_fallback_${days}d`,
        };
      }
    }
  }

  // Path padrão: procura colunas explícitas
  for (const days of windows) {
    const totalOrders = firstPresent(row, [`purchases${days}d`]);
    const totalSales = firstPresent(row, [`sales${days}d`]);
    const sameOrders = firstPresent(row, [`purchasesSameSku${days}d`, `promotedPurchases${days}d`]);
    const sameSales = firstPresent(row, [`attributedSalesSameSku${days}d`, `promotedSales${days}d`]);
    const otherOrders = firstPresent(row, [`purchasesOtherSku${days}d`]);
    const otherSales = firstPresent(row, [`salesOtherSku${days}d`]);
    if (!totalOrders.present && !totalSales.present) continue;

    const resolvedSameOrders = sameOrders.present ? sameOrders.value
      : otherOrders.present ? Math.max(0, totalOrders.value - otherOrders.value) : 0;
    const resolvedSameSales = sameSales.present ? sameSales.value
      : otherSales.present ? Math.max(0, totalSales.value - otherSales.value) : 0;
    const verified = (sameOrders.present || otherOrders.present) && (sameSales.present || otherSales.present);

    return {
      windowDays: days,
      totalOrders: totalOrders.value,
      totalSales: totalSales.value,
      sameSkuOrders: resolvedSameOrders,
      sameSkuSales: resolvedSameSales,
      haloOrders: Math.max(0, totalOrders.value - resolvedSameOrders),
      haloSales: Math.max(0, totalSales.value - resolvedSameSales),
      verified,
      source: verified ? `${sameOrders.field || otherOrders.field}+${sameSales.field || otherSales.field}` : 'total_only',
    };
  }
  return { windowDays: 0, totalOrders: 0, totalSales: 0, sameSkuOrders: 0, sameSkuSales: 0, haloOrders: 0, haloSales: 0, verified: false, source: 'missing' };
}

export function canonicalMatchType(raw: unknown, campaignType: unknown): string {
  const value = normalizeSearchTerm(raw).replace(/_/g, '-');
  if (['exact', 'phrase', 'broad'].includes(value)) return value;
  if (['close-match', 'loose-match', 'substitutes', 'complements', 'auto'].includes(value)) return 'auto';
  if (String(campaignType || '').toUpperCase().includes('MANUAL')) return 'broad';
  return 'auto';
}

export function aggregateSearchTerms(rows: any[]): HarvestAggregate[] {
  const aggregates = new Map<string, HarvestAggregate>();
  for (const row of rows || []) {
    const term = String(row.search_term || row.searchTerm || '').trim();
    const normalizedTerm = normalizeSearchTerm(term);
    const termFamilyKey = canonicalSearchTermFamily(term);
    const asin = String(row.advertised_asin || row.asin || '').trim().toUpperCase();
    if (!term || !normalizedTerm || !termFamilyKey || !asin) continue;

    const key = `${asin}|${termFamilyKey}`;
    const current = aggregates.get(key) || {
      asin,
      sku: String(row.advertised_sku || row.sku || '').trim(),
      term,
      normalizedTerm,
      termFamilyKey,
      rawVariants: [],
      impressions: 0,
      clicks: 0,
      spend: 0,
      totalOrders: 0,
      totalSales: 0,
      sameSkuOrders: 0,
      sameSkuSales: 0,
      haloOrders: 0,
      haloSales: 0,
      latestDate: '',
      sourceRows: [],
      sources: [],
      attributionVerified: true,
      skuResolutionVerified: true,
      attributionFallbackReason: undefined,
    } satisfies HarvestAggregate;

    if (!current.rawVariants.includes(term)) current.rawVariants.push(term);
    const attribution = own(row, 'same_sku_attribution_verified') ? {
      totalOrders: numberValue(row.total_orders ?? row.orders_7d ?? row.orders_14d ?? row.orders_30d),
      totalSales: numberValue(row.total_sales ?? row.sales_7d ?? row.sales_14d ?? row.sales_30d),
      sameSkuOrders: numberValue(row.same_sku_orders),
      sameSkuSales: numberValue(row.same_sku_sales),
      haloOrders: numberValue(row.halo_orders),
      haloSales: numberValue(row.halo_sales),
      verified: row.same_sku_attribution_verified === true,
    } : resolveSameSkuAttribution(row);

    current.impressions += numberValue(row.impressions);
    current.clicks += numberValue(row.clicks);
    current.spend += numberValue(row.spend ?? row.cost);
    current.totalOrders += attribution.totalOrders;
    current.totalSales += attribution.totalSales;
    current.sameSkuOrders += attribution.sameSkuOrders;
    current.sameSkuSales += attribution.sameSkuSales;
    current.haloOrders += attribution.haloOrders;
    current.haloSales += attribution.haloSales;
    current.latestDate = String(row.date || '') > current.latestDate ? String(row.date || '') : current.latestDate;
    current.attributionVerified = current.attributionVerified && attribution.verified;
    current.skuResolutionVerified = current.skuResolutionVerified && !['missing', 'ambiguous'].includes(String(row.sku_resolution_status || 'resolved'));
    if (!current.sku && row.advertised_sku) current.sku = String(row.advertised_sku);

    // Track fallback reason
    const attributionSource =
      'source' in attribution && typeof attribution.source === 'string'
        ? attribution.source
        : 'unverified_total_only';

    if (attributionSource.includes('fallback')) {
      current.attributionFallbackReason = attributionSource;
    }

    current.sourceRows.push(row);

    const source: HarvestSource = {
      campaignId: String(row.campaign_id || ''),
      adGroupId: String(row.ad_group_id || ''),
      keywordId: String(row.keyword_id || ''),
      matchType: String(row.source_target_type || row.match_type || ''),
      campaignType: String(row.source_campaign_type || ''),
    };
    const sourceKey = `${source.campaignId}|${source.adGroupId}|${source.keywordId}|${source.matchType}`;
    if (source.campaignId && !current.sources.some((item) => `${item.campaignId}|${item.adGroupId}|${item.keywordId}|${item.matchType}` === sourceKey)) {
      current.sources.push(source);
    }
    aggregates.set(key, current);
  }
  return [...aggregates.values()];
}

export function calculateSafeHarvestBid(input: { observedCpc: number; safeCpc: number; minBid: number; maxBid: number }): number | null {
  const minBid = Math.max(0.02, numberValue(input.minBid, 0.25));
  const maxBid = Math.max(minBid, numberValue(input.maxBid, 3));
  const safeCpc = numberValue(input.safeCpc);
  if (safeCpc < minBid) return null;
  const observed = numberValue(input.observedCpc);
  const evidenceBid = observed > 0 ? observed * 0.90 : safeCpc * 0.75;
  return Math.round(Math.min(maxBid, safeCpc, Math.max(minBid, evidenceBid)) * 100) / 100;
}

export function calculateWinnerExactBudget(input: { observedCpc: number; safeCpc: number; sameSkuOrders: number; marginAmount: number; accountMinimum: number; accountMaximum: number }): number {
  const floor = Math.max(1, numberValue(input.accountMinimum, 5));
  const ceiling = Math.max(floor, numberValue(input.accountMaximum, 30));
  const cpc = Math.max(numberValue(input.observedCpc), numberValue(input.safeCpc) * 0.75, 0.25);
  const orders = Math.max(1, numberValue(input.sameSkuOrders));
  const marginRoom = Math.max(0, numberValue(input.marginAmount));
  return Math.round(Math.min(ceiling, Math.max(floor, cpc * Math.min(20, 8 + orders * 3), marginRoom * Math.min(2, 0.75 + orders * 0.25))) * 100) / 100;
}

export function winnerScore(input: { sameSkuOrders: number; clicks: number; spend: number; sameSkuSales: number }): number {
  const orders = numberValue(input.sameSkuOrders);
  const cvr = input.clicks > 0 ? orders / input.clicks : 0;
  const roas = input.spend > 0 ? input.sameSkuSales / input.spend : 0;
  return Math.round(Math.min(100, orders * 30 + cvr * 100 + Math.min(30, roas * 3)) * 100) / 100;
}

export function evaluateHarvestCandidate(input: {
  aggregate: HarvestAggregate;
  inStock: boolean;
  economicsActionable: boolean;
  breakEvenAcos: number | null;
  safeBid: number | null;
  alreadyExact: boolean;
  alreadyPromoted: boolean;
}): {
  eligible: boolean;
  reason: string;
  sameSkuAcos: number | null;
} {
  const aggregate = input.aggregate;

  const sameSkuAcos =
    aggregate.sameSkuSales > 0
      ? aggregate.spend /
        aggregate.sameSkuSales *
        100
      : null;

  /*
   * HARD GUARDS
   */
  if (
    isAsinSearchTerm(
      aggregate.term
    )
  ) {
    return {
      eligible:false,
      reason:'product_target_not_keyword',
      sameSkuAcos,
    };
  }

  if (
    !aggregate.skuResolutionVerified ||
    !aggregate.asin
  ) {
    return {
      eligible:false,
      reason:'sku_unresolved',
      sameSkuAcos,
    };
  }

  if (!input.inStock) {
    return {
      eligible:false,
      reason:'out_of_stock',
      sameSkuAcos,
    };
  }

  if (input.alreadyExact) {
    return {
      eligible:false,
      reason:'exact_keyword_already_active',
      sameSkuAcos,
    };
  }

  if (input.alreadyPromoted) {
    return {
      eligible:false,
      reason:'promotion_already_registered',
      sameSkuAcos,
    };
  }

  /*
   * ORIGEM
   */
  const autoSource =
    aggregate.sources.some(
      source =>
        String(
          source.campaignType || ''
        )
          .toUpperCase()
          .includes('AUTO')
    );

  const manualNonExactSource =
    aggregate.sources.some(
      source => {
        const type =
          String(
            source.campaignType || ''
          ).toUpperCase();

        const match =
          canonicalMatchType(
            source.matchType,
            source.campaignType
          );

        return (
          type.includes('MANUAL')
          &&
          match !== 'exact'
        );
      }
    );

  /*
   * VENDA SAME-SKU
   *
   * Venda comprovada tem precedência absoluta sobre
   * os thresholds de descoberta.
   */
  const sameSkuWinner =
    (
      aggregate.sameSkuOrders >= 1
      ||
      aggregate.sameSkuSales > 0
    )
    &&
    (
      aggregate.attributionVerified
      ||
      String(
        aggregate.attributionFallbackReason || ''
      ).includes(
        'single_advertised_sku_fallback'
      )
    );

  if (sameSkuWinner) {

    /*
     * Mesmo winner precisa de bid seguro para criação.
     * Não é rejeição por falta de evidência.
     */
    if (
      input.safeBid == null ||
      numberValue(input.safeBid) <= 0
    ) {
      return {
        eligible:false,
        reason:'winner_requires_safe_bid_repair',
        sameSkuAcos,
      };
    }

    if (autoSource) {
      return {
        eligible:true,
        reason:'auto_same_sku_sale_force_exact',
        sameSkuAcos,
      };
    }

    if (manualNonExactSource) {
      return {
        eligible:true,
        reason:'manual_same_sku_sale_force_exact',
        sameSkuAcos,
      };
    }

    return {
      eligible:true,
      reason:'same_sku_sale_force_exact',
      sameSkuAcos,
    };
  }

  /*
   * SEM VENDA:
   * economics continuam obrigatórios.
   */
  if (
    !input.economicsActionable ||
    input.safeBid == null ||
    numberValue(input.safeBid) <= 0
  ) {
    return {
      eligible:false,
      reason:'unsafe_or_missing_economics',
      sameSkuAcos,
    };
  }

  const words =
    normalizeSearchTerm(
      aggregate.term
    )
      .split(' ')
      .filter(Boolean)
      .length;

  const ctr =
    aggregate.impressions > 0
      ? aggregate.clicks /
        aggregate.impressions
      : 0;

  const observedCpc =
    aggregate.clicks > 0
      ? aggregate.spend /
        aggregate.clicks
      : 0;

  const safeBid =
    numberValue(
      input.safeBid
    );

  /*
   * PROMISSOR SEM VENDA
   */
  const promising =
    words >= 3 &&
    words <= 9 &&
    aggregate.impressions >= 200 &&
    aggregate.clicks >= 2 &&
    ctr >= 0.004 &&
    (
      observedCpc <= 0
      ||
      observedCpc <=
        safeBid * 1.25
    );

  if (promising) {
    return {
      eligible:true,
      reason:
        'promising_medium_long_tail_search_term',
      sameSkuAcos,
    };
  }

  /*
   * MANUAL BROAD/PHRASE CARA
   */
  const manualHighCost =
    manualNonExactSource &&
    words >= 2 &&
    aggregate.impressions >= 150 &&
    aggregate.clicks >= 5 &&
    observedCpc >
      safeBid * 1.10;

  if (manualHighCost) {
    return {
      eligible:true,
      reason:
        'manual_high_cost_search_term_isolation',
      sameSkuAcos,
    };
  }

  return {
    eligible:false,
    reason:'insufficient_harvest_evidence',
    sameSkuAcos,
  };
}

export function matchesRequestedCampaignType(requested: unknown, actual: unknown): boolean {
  const expected = String(requested || '').trim().toUpperCase();
  const observed = String(actual || '').trim().toUpperCase();
  return !expected || expected === observed;
}
