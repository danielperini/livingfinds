import {
  aggregateSearchTermSnapshots,
  aggregateSearchTermSnapshotsByCampaign,
  aggregateSearchTerms,
  calculateSafeHarvestBid,
  calculateWinnerExactBudget,
  evaluateHarvestCandidate,
  isAsinSearchTerm,
  isTitleFragmentKeyword,
  matchesRequestedCampaignType,
  normalizeSearchTerm,
  resolveSameSkuAttribution,
} from './searchTermHarvestPolicy.ts';


Deno.test('mantém a evidência do termo separada por SKU e campanha de origem', () => {
  const rows = [
    {
      campaign_id: 'AUTO-RED', ad_group_id: 'G1', keyword_id: 'T1',
      advertised_asin: 'B0VARIANT1', advertised_sku: 'SKU-RED',
      search_term: 'lixeira automática branca', source_campaign_type: 'AUTO',
      source_target_type: 'AUTO', same_sku_attribution_verified: true,
      same_sku_orders: 1, same_sku_sales: 72.9, total_orders: 1, total_sales: 72.9,
      date: '2026-10-10', attribution_window_days: 7, clicks: 5, spend: 2,
    },
    {
      campaign_id: 'AUTO-BLACK', ad_group_id: 'G2', keyword_id: 'T2',
      advertised_asin: 'B0VARIANT1', advertised_sku: 'SKU-BLACK',
      search_term: 'lixeira automática branca', source_campaign_type: 'AUTO',
      source_target_type: 'AUTO', same_sku_attribution_verified: true,
      same_sku_orders: 3, same_sku_sales: 220, total_orders: 3, total_sales: 220,
      date: '2026-10-10', attribution_window_days: 7, clicks: 12, spend: 8,
    },
  ];
  const result = aggregateSearchTermSnapshotsByCampaign(rows);
  if (result.length !== 2) throw new Error(`esperava 2 evidências de campanha, recebeu ${result.length}`);
  const red = result.find((row) => row.sourceCampaignId === 'AUTO-RED');
  const black = result.find((row) => row.sourceCampaignId === 'AUTO-BLACK');
  if (red?.sku !== 'SKU-RED' || red.sameSkuOrders !== 1 || red.spend !== 2) throw new Error('misturou evidência da campanha vermelha');
  if (black?.sku !== 'SKU-BLACK' || black.sameSkuOrders !== 3 || black.spend !== 8) throw new Error('misturou evidência da campanha preta');
});

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

Deno.test('não soma conversões repetidas em snapshots móveis e deduplica a origem diária', () => {
  const rows = [
    { date: '2026-10-10', advertised_asin: 'B0FN4RCXY2', advertised_sku: 'SKU-1', search_term: 'lixeira inox sensor', campaign_id: 'C1', ad_group_id: 'A1', source_target_id: 'T1', source_target_type: 'close-match', spend: 0.20, clicks: 1, impressions: 10, same_sku_attribution_verified: true, same_sku_orders: 2, same_sku_sales: 100, total_orders: 2, total_sales: 100, attribution_window_days: 7, metrics_fresh_at: '2026-10-10T08:00:00Z' },
    { date: '2026-10-11', advertised_asin: 'B0FN4RCXY2', advertised_sku: 'SKU-1', search_term: 'lixeira inox sensor', campaign_id: 'C1', ad_group_id: 'A1', source_target_id: 'T1', source_target_type: 'close-match', spend: 0.30, clicks: 2, impressions: 12, same_sku_attribution_verified: true, same_sku_orders: 2, same_sku_sales: 100, total_orders: 2, total_sales: 100, attribution_window_days: 7, metrics_fresh_at: '2026-10-11T08:00:00Z' },
    { date: '2026-10-11', advertised_asin: 'B0FN4RCXY2', advertised_sku: 'SKU-1', search_term: 'lixeira inox sensor', campaign_id: 'C1', ad_group_id: 'A1', source_target_id: 'T1', source_target_type: 'close-match', spend: 0.35, clicks: 2, impressions: 14, same_sku_attribution_verified: true, same_sku_orders: 2, same_sku_sales: 100, total_orders: 2, total_sales: 100, attribution_window_days: 7, metrics_fresh_at: '2026-10-11T09:00:00Z' },
    { date: '2026-10-12', advertised_asin: 'B0FN4RCXY2', advertised_sku: 'SKU-1', search_term: 'lixeira inox sensor', campaign_id: 'C1', ad_group_id: 'A1', source_target_id: 'T1', source_target_type: 'close-match', spend: 0.15, clicks: 1, impressions: 8, same_sku_attribution_verified: true, same_sku_orders: 2, same_sku_sales: 100, total_orders: 2, total_sales: 100, attribution_window_days: 7, metrics_fresh_at: '2026-10-12T08:00:00Z' },
  ];
  const [aggregate] = aggregateSearchTermSnapshots(rows);
  if (aggregate.sameSkuOrders !== 2 || aggregate.sameSkuSales !== 100) throw new Error('a mesma conversão móvel foi somada mais de uma vez');
  if (Math.abs(aggregate.spend - 0.70) > 0.001 || aggregate.clicks !== 4 || aggregate.impressions !== 32) throw new Error('métricas diárias não foram deduplicadas e somadas corretamente');
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

Deno.test('exige mais de duas vendas verificadas do mesmo SKU e bloqueia venda halo', () => {
  const base = {
    asin: 'B0FN4RCXY2', sku: 'SKU-1', term: 'lixeira inox 15l', normalizedTerm: 'lixeira inox 15l',
    termFamilyKey: 'lixeira inox 15l', rawVariants: ['lixeira inox 15l'],
    impressions: 20, clicks: 3, spend: 0.8, totalOrders: 3, totalSales: 611.4,
    sameSkuOrders: 3, sameSkuSales: 611.4, haloOrders: 0, haloSales: 0, latestDate: '2026-07-31',
    sourceRows: [], sources: [], attributionVerified: true, skuResolutionVerified: true,
  };
  const eligible = evaluateHarvestCandidate({ aggregate: base, inStock: true, economicsActionable: true, breakEvenAcos: 40, safeBid: 0.45, alreadyExact: false, alreadyPromoted: false });
  if (!eligible.eligible) throw new Error(`três vendas do mesmo SKU deveriam promover: ${eligible.reason}`);
  const oneSale = evaluateHarvestCandidate({ aggregate: { ...base, totalOrders: 1, sameSkuOrders: 1, totalSales: 203.8, sameSkuSales: 203.8 }, inStock: true, economicsActionable: true, breakEvenAcos: 40, safeBid: 0.45, alreadyExact: false, alreadyPromoted: false });
  if (oneSale.eligible || oneSale.reason !== 'requires_more_than_two_verified_same_sku_orders') throw new Error('menos de três vendas não podem criar campanha manual');
  const twoSales = evaluateHarvestCandidate({ aggregate: { ...base, sameSkuOrders: 2 }, inStock: true, economicsActionable: true, breakEvenAcos: 40, safeBid: 0.45, alreadyExact: false, alreadyPromoted: false });
  if (twoSales.eligible || twoSales.reason !== 'requires_more_than_two_verified_same_sku_orders') throw new Error('duas vendas ainda não podem criar campanha manual');
  for (const breakEvenAcos of [null, 0, -5]) {
    if (evaluateHarvestCandidate({ aggregate: base, inStock: true, economicsActionable: true, breakEvenAcos, safeBid: 0.45, alreadyExact: false, alreadyPromoted: false }).eligible) throw new Error('margem ausente/negativa não pode promover');
  }
  const halo = evaluateHarvestCandidate({ aggregate: { ...base, sameSkuOrders: 0, sameSkuSales: 0, haloOrders: 1, haloSales: 203.8 }, inStock: true, economicsActionable: true, breakEvenAcos: 40, safeBid: 0.45, alreadyExact: false, alreadyPromoted: false });
  if (halo.eligible || halo.reason !== 'requires_more_than_two_verified_same_sku_orders') throw new Error('venda halo não pode promover');
});

Deno.test('identifica fragmento contíguo do título em sugestões geradas', () => {
  const title = 'Moedor de Café Elétrico Portátil Configuração Multi Moagem USB';
  if (!isTitleFragmentKeyword('moedor de cafe eletrico', title)) throw new Error('fragmento de título não identificado');
  if (isTitleFragmentKeyword('moedor de cafe eletrico portátil configuração multi moagem usb', title)) throw new Error('título completo não deve ser classificado como fragmento');
  if (isTitleFragmentKeyword('moedor de cafe recarregável', title)) throw new Error('termo de busca não contíguo foi bloqueado');
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
    spend: 1, totalOrders: 3, totalSales: 90, sameSkuOrders: 3, sameSkuSales: 90,
    haloOrders: 0, haloSales: 0, latestDate: '2026-08-25', sourceRows: [], sources: [],
    attributionVerified: true, skuResolutionVerified: true,
  };
  const result = evaluateHarvestCandidate({ aggregate, inStock: true, economicsActionable: true, breakEvenAcos: 40, safeBid: 0.5, alreadyExact: true, alreadyPromoted: false });
  if (result.eligible || result.reason !== 'exact_keyword_already_active') throw new Error('EXACT duplicada não foi bloqueada');
});

Deno.test('same ASIN search terms never merge sales from different SKUs', () => {
  const rows = ['FBA-0087', 'I1-NOI2-CU3W'].map(sku => ({
    advertised_asin: 'B0GFQ7SY5W', advertised_sku: sku, search_term: 'lixeira automatica 13l',
    same_sku_attribution_verified: true, same_sku_orders: 1, same_sku_sales: 72.9,
    clicks: 1, spend: 0.4, sku_resolution_status: 'resolved_campaign',
  }));
  const result = aggregateSearchTerms(rows);
  if (result.length !== 2 || result.some(row => row.sameSkuOrders !== 1)) throw new Error('SKUs misturados');
});
