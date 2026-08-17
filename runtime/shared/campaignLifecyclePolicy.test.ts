import { strict as assert } from 'node:assert';
import {
  allocateProjectedBudget,
  inheritedPromotionBid,
  nextManualBid,
  shouldPromoteTerm,
  shouldRetireAutoCampaign,
} from './campaignLifecyclePolicy.ts';

Deno.test('promove termo com 2 vendas e ACoS dentro da meta herdando bid', () => {
  const input = { orders: 2, sales: 100, spend: 15, targetAcos: 20, sourceBid: 0.7, alreadyPromoted: false };
  assert.equal(shouldPromoteTerm(input), true);
  assert.equal(inheritedPromotionBid(input), 0.7);
});

Deno.test('não promove termo sem confirmação econômica', () => {
  assert.equal(shouldPromoteTerm({ orders: 2, sales: 100, spend: 30, targetAcos: 20, sourceBid: 0.7, alreadyPromoted: false }), false);
  assert.equal(shouldPromoteTerm({ orders: 1, sales: 100, spend: 10, targetAcos: 20, sourceBid: 0.7, alreadyPromoted: false }), false);
});

Deno.test('pausa automática somente após 30 dias e 3 dias sem vendas', () => {
  assert.equal(shouldRetireAutoCampaign({ ageDays: 30, consecutiveDaysWithoutSales: 3, protectedWinner: false, inStock: true, structurallyComplete: true }), true);
  assert.equal(shouldRetireAutoCampaign({ ageDays: 29, consecutiveDaysWithoutSales: 3, protectedWinner: false, inStock: true, structurallyComplete: true }), false);
  assert.equal(shouldRetireAutoCampaign({ ageDays: 60, consecutiveDaysWithoutSales: 3, protectedWinner: true, inStock: true, structurallyComplete: true }), false);
});

Deno.test('manual reduz bid quando há gasto sem vendas', () => {
  const result = nextManualBid({ currentBid: 0.6, minBid: 0.2, maxBid: 3, impressions: 1000, clicks: 30, orders: 0, sales: 0, spend: 20, targetAcos: 15, maxSpendWithoutSale: 15, increment: 0.1, maxIncreasePct: 20, maxReductionPct: 15 });
  assert.equal(result.action, 'reduce');
  assert.equal(result.bid, 0.51);
});

Deno.test('manual vencedora sobe sem ultrapassar incremento e percentual', () => {
  const result = nextManualBid({ currentBid: 0.6, minBid: 0.2, maxBid: 3, impressions: 1000, clicks: 30, orders: 3, sales: 200, spend: 20, targetAcos: 15, maxSpendWithoutSale: 15, increment: 0.1, maxIncreasePct: 20, maxReductionPct: 15 });
  assert.equal(result.action, 'increase');
  assert.equal(result.bid, 0.7);
});

Deno.test('projeções nunca ultrapassam budget global', () => {
  const result = allocateProjectedBudget([
    { campaignId: 'winner', projectedSpend: 80, currentBudget: 80, orders: 4, sales: 200, spend: 20, targetAcos: 15, protectedWinner: true },
    { campaignId: 'weak', projectedSpend: 60, currentBudget: 60, orders: 0, sales: 0, spend: 20, targetAcos: 15 },
  ], 100);
  assert.equal(result.allocated, 100);
  assert.equal(result.allocations.winner, 80);
  assert.equal(result.allocations.weak, 20);
});
