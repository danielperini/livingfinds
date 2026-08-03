import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { chooseDuplicateWinner, classifyRemoteCampaign } from './campaignReconciliationPolicy.ts';

Deno.test('estado remoto enabled prevalece sobre amazon_status legado', () => {
  assertEquals(classifyRemoteCampaign({
    remote: { state: 'ENABLED', targetingType: 'AUTO' },
    local: { state: 'enabled', amazon_status: 'paused' }, product: { stock: 3 },
    adGroups: [{ state: 'ENABLED' }], productAds: [{ state: 'ENABLED' }],
  }), 'ATIVA_COMPLETA');
});

Deno.test('manual exige exatamente uma keyword exact ativa', () => {
  assertEquals(classifyRemoteCampaign({
    remote: { state: 'ENABLED', targetingType: 'MANUAL' }, product: { stock: 3 },
    adGroups: [{ state: 'ENABLED' }], productAds: [{ state: 'ENABLED' }],
    keywords: [{ state: 'ENABLED', matchType: 'EXACT' }, { state: 'ENABLED', matchType: 'EXACT' }],
  }), 'INCOMPLETA_REPARAVEL');
});

Deno.test('duplicada vencedora é escolhida por lucro e vendas antes de gasto', () => {
  const winner = chooseDuplicateWinner([
    { campaignId: 'high-spend', spend: 900, sales: 100, profit_after_ads: -800, orders: 1 },
    { campaignId: 'profitable', spend: 20, sales: 300, profit_after_ads: 100, orders: 4 },
  ]);
  assertEquals(winner.campaignId, 'profitable');
});

Deno.test('campanha vencedora é protegida', () => {
  assertEquals(classifyRemoteCampaign({
    remote: { state: 'ENABLED', targetingType: 'AUTO' },
    local: { state: 'enabled', spend: 10, sales: 100, orders: 2, profit_after_ads: 30 },
    product: { stock: 2 }, adGroups: [{ state: 'ENABLED' }], productAds: [{ state: 'ENABLED' }],
  }), 'PROTEGIDA_ALTA_PERFORMANCE');
});
