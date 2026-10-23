import { assessSearchTerm } from './searchTermQuality.ts';
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

/** Preserve the literal customer query when an Exact keyword is created. */
export function normalizeLiteralSearchTerm(value: unknown): string {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Detecta keywords montadas recortando palavras contíguas do título do produto.
 * Usada apenas em fontes de sugestão (IA/catálogo); termos realmente observados
 * em Search Term Reports são avaliados pela evidência de conversão abaixo. */
export function isTitleFragmentKeyword(keyword: unknown, productTitle: unknown): boolean {
  const term = normalizeSearchTerm(keyword).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const title = normalizeSearchTerm(productTitle).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!term || !title || term === title) return false;
  const stopWords = new Set(['a', 'as', 'ao', 'aos', 'com', 'da', 'das', 'de', 'do', 'dos', 'e', 'em', 'na', 'nas', 'no', 'nos', 'o', 'os', 'para', 'por', 'sem', 'um', 'uma']);
  const termTokens = term.split(' ').filter((token) => token && !stopWords.has(token));
  const titleTokens = title.split(' ').filter((token) => token && !stopWords.has(token));
  if (termTokens.length < 2 || termTokens.length >= titleTokens.length) return false;
  return titleTokens.some((_, index) =>
    index + termTokens.length <= titleTokens.length &&
    termTokens.every((token, offset) => titleTokens[index + offset] === token)
  );
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
    if (!assessSearchTerm(term).accepted) continue;
    const normalizedTerm = normalizeSearchTerm(term);
    const termFamilyKey = canonicalSearchTermFamily(term);
    const asin = String(row.advertised_asin || row.asin || '').trim().toUpperCase();
    if (!term || !normalizedTerm || !termFamilyKey || !asin) continue;

    const skuKey = String(row.advertised_sku || row.sku || '').trim().toUpperCase();
    // Families are useful for reporting, but must not merge distinct customer
    // queries into a synthetic Exact keyword. Keep each literal phrase isolated.
    const key = `${asin}|${skuKey}|${normalizeLiteralSearchTerm(term)}`;
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
      source: String(row.attribution_source || 'persisted_same_sku_attribution'),
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
    if (attribution.source.includes('fallback')) {
      current.attributionFallbackReason = attribution.source;
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

/** Agrupa snapshots diarios sem somar várias vezes as mesmas conversões de
 * janelas móveis (7/14/30 dias). Custos e tráfego são somados uma vez por
 * origem/dia; pedidos e vendas usam o snapshot mais recente de cada origem. */
export function aggregateSearchTermSnapshots(rows: any[]): HarvestAggregate[] {
  return aggregateSearchTerms(rows).map((aggregate) => {
    const latestBySource = new Map<string, any>();
    const dailyBySource = new Map<string, Map<string, any>>();
    const sourceKey = (row: any) => [
      row.campaign_id || '', row.ad_group_id || '',
      row.source_target_id || row.target_id || row.keyword_id || '',
      canonicalMatchType(row.source_target_type || row.match_type, row.source_campaign_type || row.campaign_type),
    ].join('|');
    const newer = (candidate: any, current: any) => {
      const candidateFreshness = `${candidate.date || ''}|${candidate.metrics_fresh_at || candidate.synced_at || ''}|${candidate.report_job_id || ''}`;
      const currentFreshness = `${current.date || ''}|${current.metrics_fresh_at || current.synced_at || ''}|${current.report_job_id || ''}`;
      return candidateFreshness > currentFreshness;
    };

    for (const row of aggregate.sourceRows) {
      const origin = sourceKey(row);
      const currentLatest = latestBySource.get(origin);
      if (!currentLatest || newer(row, currentLatest)) latestBySource.set(origin, row);
      const date = String(row.date || '');
      if (!date) continue;
      const byDate = dailyBySource.get(origin) || new Map<string, any>();
      const currentDay = byDate.get(date);
      if (!currentDay || newer(row, currentDay)) byDate.set(date, row);
      dailyBySource.set(origin, byDate);
    }

    let impressions = 0;
    let clicks = 0;
    let spend = 0;
    let totalOrders = 0;
    let totalSales = 0;
    let sameSkuOrders = 0;
    let sameSkuSales = 0;
    let haloOrders = 0;
    let haloSales = 0;
    let attributionVerified = true;
    let latestDate = '';

    for (const [origin, latest] of latestBySource) {
      const latestDateForSource = String(latest.date || '');
      if (latestDateForSource > latestDate) latestDate = latestDateForSource;
      const attributionDays = Math.max(1, numberValue(latest.attribution_window_days, 7));
      const cutoff = latestDateForSource
        ? new Date(new Date(`${latestDateForSource}T00:00:00.000Z`).getTime() - (attributionDays - 1) * 86400000).toISOString().slice(0, 10)
        : '';
      for (const [date, row] of dailyBySource.get(origin) || []) {
        if (cutoff && date < cutoff || latestDateForSource && date > latestDateForSource) continue;
        impressions += numberValue(row.impressions);
        clicks += numberValue(row.clicks);
        spend += numberValue(row.spend ?? row.cost);
      }
      totalOrders += numberValue(latest.total_orders ?? latest.orders_7d ?? latest.orders_14d ?? latest.orders_30d);
      totalSales += numberValue(latest.total_sales ?? latest.sales_7d ?? latest.sales_14d ?? latest.sales_30d);
      sameSkuOrders += numberValue(latest.same_sku_orders);
      sameSkuSales += numberValue(latest.same_sku_sales);
      haloOrders += numberValue(latest.halo_orders);
      haloSales += numberValue(latest.halo_sales);
      attributionVerified = attributionVerified && latest.same_sku_attribution_verified === true;
    }

    return {
      ...aggregate,
      impressions, clicks, spend,
      totalOrders, totalSales, sameSkuOrders, sameSkuSales, haloOrders, haloSales,
      attributionVerified,
      latestDate,
    };
  });
}

/** Aggregate repeated snapshots per source, then keep campaigns isolated for decisions. */
export function aggregateSearchTermSnapshotsByCampaign(rows: any[]): Array<HarvestAggregate & { sourceCampaignId: string }> {
  const byCampaign = new Map<string, any[]>();
  for (const row of rows || []) {
    const campaignId = String(row.campaign_id || row.amazon_campaign_id || '');
    if (!campaignId) continue;
    const current = byCampaign.get(campaignId) || [];
    current.push(row);
    byCampaign.set(campaignId, current);
  }
  return [...byCampaign.entries()].flatMap(([sourceCampaignId, campaignRows]) =>
    aggregateSearchTermSnapshots(campaignRows).map((aggregate) => ({ ...aggregate, sourceCampaignId }))
  );
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
}): { eligible: boolean; reason: string; sameSkuAcos: number | null } {
  const { aggregate } = input;
  const sameSkuAcos = aggregate.sameSkuSales > 0 ? aggregate.spend / aggregate.sameSkuSales * 100 : null;
  if (isAsinSearchTerm(aggregate.term)) return { eligible: false, reason: 'product_target_not_keyword', sameSkuAcos };
  if (!aggregate.skuResolutionVerified || !aggregate.asin || !aggregate.sku) return { eligible: false, reason: 'sku_unresolved', sameSkuAcos };
  
  // NEW: Allow fallback single_advertised_sku as verified attribution
  const hasValidAttribution = aggregate.attributionVerified || aggregate.attributionFallbackReason?.includes('single_advertised_sku_fallback');
  if (!hasValidAttribution) return { eligible: false, reason: 'same_sku_attribution_unavailable', sameSkuAcos };
  
  if (aggregate.sameSkuOrders < 3 || aggregate.sameSkuSales <= 0) return { eligible: false, reason: 'requires_more_than_two_verified_same_sku_orders', sameSkuAcos };
  if (!input.inStock) return { eligible: false, reason: 'out_of_stock', sameSkuAcos };
  if (!input.economicsActionable || input.safeBid == null || input.breakEvenAcos == null || input.breakEvenAcos <= 0) return { eligible: false, reason: 'unsafe_or_missing_economics', sameSkuAcos };
  if (input.breakEvenAcos && sameSkuAcos != null && sameSkuAcos >= input.breakEvenAcos) return { eligible: false, reason: 'same_sku_acos_above_break_even', sameSkuAcos };
  if (input.alreadyExact) return { eligible: false, reason: 'exact_keyword_already_active', sameSkuAcos };
  if (input.alreadyPromoted) return { eligible: false, reason: 'promotion_already_registered', sameSkuAcos };
  return { eligible: true, reason: 'same_sku_sale_profitable', sameSkuAcos };
}

export function matchesRequestedCampaignType(requested: unknown, actual: unknown): boolean {
  const expected = String(requested || '').trim().toUpperCase();
  const observed = String(actual || '').trim().toUpperCase();
  return !expected || expected === observed;
}
