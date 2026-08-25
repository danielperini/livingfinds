import {
  aggregateSearchTerms,
  calculateSafeHarvestBid,
  calculateWinnerExactBudget,
  evaluateHarvestCandidate,
  isAsinSearchTerm,
  matchesRequestedCampaignType,
  normalizeSearchTerm,
  resolveSameSkuAttribution,
} from './searchTermHarvestPolicy.ts';

Deno.test('normaliza acentos, caixa e espaços para deduplicação', () => {
  if (normalizeSearchTerm('  Lixeira   Automática  ') !== 'lixeira automatica') throw new Error('normalização incorreta');
});

Deno.test('separa venda do mesmo SKU de venda halo na janela de 7 dias', () => {
  const result = resolveSameSkuAttribution({
    purchases7d: 3,
    sales7d: 300,
    purchasesSameSku7d: 2,
    attributedSalesSameSku7d: 210,
  });
  if (!result.verified || result.windowDays !== 7) throw new Error('atribuição não verificada');
  if (result.sameSkuOrders !== 2 || result.sameSkuSales !== 210) throw new Error('mesmo SKU incorreto');
  if (result.haloOrders !== 1 || result.haloSales !== 90) throw new Error('halo incorreto');
});

Deno.test('não transforma total de vendas em mesmo SKU quando a coluna promovida não existe', () => {
  const result = resolveSameSkuAttribution({ purchases7d: 1, sales7d: 105.9 });
  if (result.verified || result.sameSkuOrders !== 0 || result.sameSkuSales !== 0) {
    throw new Error('venda total não pode ser presumida como mesmo SKU');
  }
});

Deno.test('agrega o mesmo termo vindo de vaga e complementos sem duplicar campanha', () => {
  const rows = [
    {
      date: '2026-07-31', advertised_asin: 'B0FN4RCXY2', advertised_sku: 'SKU-1',
      search_term: 'Lixeira Automática com Sensor', campaign_id: 'C1', ad_group_id: 'A1',
      source_target_type: 'close-match', spend: 2.26, clicks: 1,
      total_orders: 1, total_sales: 105.9, same_sku_orders: 1, same_sku_sales: 105.9,
      halo_orders: 0, halo_sales: 0, same_sku_attribution_verified: true,
      sku_resolution_status: 'resolved_campaign',
    },
    {
      date: '2026-07-31', advertised_asin: 'B0FN4RCXY2', advertised_sku: 'SKU-1',
      search_term: 'lixeira automatica com sensor', campaign_id: 'C1', ad_group_id: 'A1',
      source_target_type: 'complements', spend: 0.6, clicks: 1,
      total_orders: 1, total_sales: 105.9, same_sku_orders: 1, same_sku_sales: 105.9,
      halo_orders: 0, halo_sales: 0, same_sku_attribution_verified: true,
      sku_resolution_status: 'resolved_campaign',
    },
  ];
  const result = aggregateSearchTerms(rows);
  if (result.length !== 1) throw new Error('termo duplicado');
  if (result[0].sameSkuOrders !== 2 || Math.abs(result[0].spend - 2.86) > 0.001) throw new Error('agregação incorreta');
  if (result[0].sources.length !== 2) throw new Error('fontes de segmentação não preservadas');
  if (!result[0].termFamilyKey) throw new Error('família do termo não foi atribuída');
  if (result[0].rawVariants.length !== 2) throw new Error('variantes brutas não foram preservadas');
});

Deno.test('bid inicial nunca ultrapassa o CPC econômico seguro', () => {
  const bid = calculateSafeHarvestBid({ observedCpc: 1.2, safeCpc: 0.72, minBid: 0.25, maxBid: 3 });
  if (bid !== 0.72) throw new Error(`bid inseguro: ${bid}`);
  const blocked = calculateSafeHarvestBid({ observedCpc: 0.5, safeCpc: 0.2, minBid: 0.25, maxBid: 3 });
  if (blocked !== null) throw new Error('deveria bloquear CPC abaixo do lance mínimo');
});

Deno.test('orçamento de EXACT vencedor usa economia e CPC em vez de valor fixo', () => {
  const budget = calculateWinnerExactBudget({ observedCpc: 1.2, safeCpc: 1.4, sameSkuOrders: 3, marginAmount: 18, accountMinimum: 5, accountMaximum: 30 });
  if (budget <= 15 || budget > 30) throw new Error(`orçamento vencedor não competitivo: ${budget}`);
});

Deno.test('uma venda do mesmo SKU é elegível, mas venda halo não é', () => {
  const base = {
    asin: 'B0FN4RCXY2', sku: 'SKU-1', term: 'lixeira inox 15l', normalizedTerm: 'lixeira inox 15l',
    termFamilyKey: 'lixeira inox 15l', rawVariants: ['lixeira inox 15l'],
    impressions: 10, clicks: 1, spend: 0.5, totalOrders: 1, totalSales: 203.8,
    sameSkuOrders: 1, sameSkuSales: 203.8, haloOrders: 0, haloSales: 0, latestDate: '2026-07-31',
    sourceRows: [], sources: [], attributionVerified: true, skuResolutionVerified: true,
  };
  const eligible = evaluateHarvestCandidate({ aggregate: base, inStock: true, economicsActionable: true, breakEvenAcos: 40, safeBid: 0.45, alreadyExact: false, alreadyPromoted: false });
  if (!eligible.eligible) throw new Error(`venda deveria promover: ${eligible.reason}`);
  const halo = evaluateHarvestCandidate({ aggregate: { ...base, sameSkuOrders: 0, sameSkuSales: 0, haloOrders: 1, haloSales: 203.8 }, inStock: true, economicsActionable: true, breakEvenAcos: 40, safeBid: 0.45, alreadyExact: false, alreadyPromoted: false });
  if (halo.eligible || halo.reason !== 'no_same_sku_sale') throw new Error('venda halo não pode promover');
});

Deno.test('não promove ASIN/target de dez caracteres como keyword', () => {
  if (!isAsinSearchTerm('b07y44flcx')) throw new Error('ASIN legado não identificado');
  if (!isAsinSearchTerm('B0FN4RCXY2')) throw new Error('ASIN atual não identificado');
  if (isAsinSearchTerm('lixeira auto')) throw new Error('consulta normal foi bloqueada');
});

Deno.test('harvest aceita compradores AUTO e MANUAL em passagens separadas', () => {
  if (!matchesRequestedCampaignType('AUTO', 'AUTO')) throw new Error('AUTO deveria ser aceito');
  if (!matchesRequestedCampaignType('MANUAL', 'MANUAL')) throw new Error('MANUAL deveria ser aceito');
  if (matchesRequestedCampaignType('MANUAL', 'AUTO')) throw new Error('AUTO vazou para MANUAL');
});

Deno.test('EXACT equivalente ativa não é duplicada', () => {
  const aggregate = {
    asin: 'B0FN4RCXY2', sku: 'SKU-1', term: 'lixeira inox', normalizedTerm: 'lixeira inox',
    termFamilyKey: 'lixeira inox', rawVariants: ['lixeira inox'], impressions: 20, clicks: 2,
    spend: 1, totalOrders: 1, totalSales: 30, sameSkuOrders: 1, sameSkuSales: 30,
    haloOrders: 0, haloSales: 0, latestDate: '2026-08-25', sourceRows: [], sources: [],
    attributionVerified: true, skuResolutionVerified: true,
  };
  const result = evaluateHarvestCandidate({ aggregate, inStock: true, economicsActionable: true, breakEvenAcos: 40, safeBid: 0.5, alreadyExact: true, alreadyPromoted: false });
  if (result.eligible || result.reason !== 'exact_keyword_already_active') throw new Error('EXACT duplicada não foi bloqueada');
});
