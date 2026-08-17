const STOP_WORDS = new Set([
  'a', 'as', 'com', 'da', 'das', 'de', 'do', 'dos', 'e', 'em', 'o', 'os',
  'para', 'por', 'um', 'uma',
]);

export function normalizeFactoryKeyword(value: unknown): string {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

function meaningfulTokens(value: unknown): string[] {
  return normalizeFactoryKeyword(value)
    .split(' ')
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

export function calculateFactoryIntentScore(
  keyword: unknown,
  productName: unknown,
  category: unknown,
): number {
  const keywordTokens = [...new Set(meaningfulTokens(keyword))];
  if (keywordTokens.length === 0) return 0;

  const productTokens = new Set(meaningfulTokens(`${productName || ''} ${category || ''}`));
  const overlap = keywordTokens.filter((token) => productTokens.has(token)).length;
  const coverage = overlap / keywordTokens.length;
  const specificityBonus = keywordTokens.length >= 4 ? 10 : keywordTokens.length === 3 ? 6 : 0;
  const genericPenalty = keywordTokens.length <= 2 ? 15 : 0;
  const commercialTokens = new Set([
    'automatico', 'automatica', 'bivolt', 'eletrico', 'eletrica', 'inteligente',
    'portatil', 'profissional', 'sensor', 'touch', 'usb', 'wifi',
  ]);
  const commercialOverlap = keywordTokens.filter(
    (token) => commercialTokens.has(token) && productTokens.has(token),
  ).length;
  const commercialBonus = Math.min(12, commercialOverlap * 4);

  return Math.max(0, Math.min(
    100,
    Math.round(coverage * 80 + specificityBonus + commercialBonus - genericPenalty),
  ));
}

export function extractFactorySearchTermSignal(row: any) {
  const keyword = String(row?.search_term || row?.query || row?.keyword_text || '').trim();
  const asin = String(row?.advertised_asin || row?.asin || '').trim().toUpperCase();
  return {
    keyword,
    asin,
    metrics: {
      impressions: Number(row?.impressions || 0),
      clicks: Number(row?.clicks || 0),
      spend: Number(row?.spend || 0),
      orders: Math.max(
        Number(row?.orders_30d || 0),
        Number(row?.orders_14d || 0),
        Number(row?.orders_7d || 0),
        Number(row?.orders || 0),
      ),
      sales: Math.max(
        Number(row?.sales_30d || 0),
        Number(row?.sales_14d || 0),
        Number(row?.sales_7d || 0),
        Number(row?.sales || 0),
      ),
      campaign_id: String(row?.campaign_id || ''),
    },
  };
}

export function campaignFactoryPlanKey(
  asin: unknown,
  keyword: unknown,
  matchType: unknown = 'exact',
): string {
  return [
    'BR',
    String(asin || '').trim().toUpperCase(),
    normalizeFactoryKeyword(keyword),
    String(matchType || 'exact').toLowerCase(),
    'CAMPAIGN_FACTORY',
  ].join('|');
}

export function isFactoryEconomicallyHealthy(
  metrics: { sales?: unknown; spend?: unknown; acos?: unknown },
  maxAcos: number,
): boolean {
  const sales = Math.max(0, Number(metrics.sales || 0));
  const spend = Math.max(0, Number(metrics.spend || 0));
  const reportedAcos = Math.max(0, Number(metrics.acos || 0));
  if (sales <= 0) return false;

  // A atribuição da venda pode chegar antes do gasto ou sem o ACoS calculado.
  // Gasto zero é saudável; com gasto positivo, recalculamos o ACoS quando
  // necessário para não promover um termo deficitário por dado incompleto.
  const effectiveAcos = reportedAcos > 0 ? reportedAcos
    : spend > 0 ? (spend / sales) * 100
    : 0;
  return spend === 0 || effectiveAcos <= Math.max(0, Number(maxAcos || 0));
}
