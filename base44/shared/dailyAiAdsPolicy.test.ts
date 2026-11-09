import { assert, assertEquals } from 'jsr:@std/assert@1';
import {
  buildDailyAdsCandidates,
  clampBidChange,
  rebalanceBudgetPlan,
  validateRecommendation,
} from './dailyAiAdsPolicy.ts';

Deno.test('limita o conjunto da análise e protege campanhas pausadas', () => {
  const result = buildDailyAdsCandidates([
    { entity_id: 'winner', entity_type: 'campaign', state: 'enabled', spend: 10, sales: 100, orders: 2, clicks: 20, impressions: 1000, acos: 10, stock: 5 },
    { entity_id: 'paused', entity_type: 'campaign', state: 'paused', spend: 100, sales: 0, orders: 0, clicks: 20, impressions: 1000, acos: null, stock: 5 },
  ]);
  assertEquals(result.map((item) => item.entity_id), ['winner']);
});

Deno.test('redução respeita mínimo, teto e passo máximo de 15%', () => {
  assertEquals(clampBidChange(1, 0.1), 0.85);
  assertEquals(clampBidChange(0.2, 0), 0.2);
});

Deno.test('pausa não é autoaprovada sem último recurso', () => {
  const result = validateRecommendation(
    { entity_id: 'c1', action: 'pause_campaign', confidence: 0.99 },
    { entity_id: 'c1', entity_type: 'campaign', state: 'enabled', spend: 100, sales: 0, orders: 0, clicks: 100, impressions: 1000, acos: null, stock: 10 },
  );
  assert(!result.valid);
});

Deno.test('confiança de 80% permite somente ajuste de baixo risco', () => {
  const bid = validateRecommendation(
    { entity_id: 'k1', action: 'update_bid', proposed_value: 0.8, confidence: 0.80 },
    { entity_id: 'k1', entity_type: 'keyword', state: 'enabled', spend: 2, sales: 30, orders: 1, clicks: 4, impressions: 100, acos: 6.7, current_bid: 0.7, evidence_days: 2, stock: 5 },
  );
  const budget = validateRecommendation(
    { entity_id: 'c1', action: 'increase_budget', proposed_value: 11, confidence: 0.80 },
    { entity_id: 'c1', entity_type: 'campaign', state: 'enabled', spend: 2, sales: 0, orders: 0, clicks: 4, impressions: 100, acos: null, daily_budget: 10, stock: 5 },
  );
  assertEquals(bid.autoApprove, true);
  assertEquals(budget.autoApprove, false);
});

Deno.test('não reduz bid por comparação de apenas um dia', () => {
  const result = validateRecommendation(
    { entity_id: 'k1', action: 'reduce_bid', proposed_value: 0.5, confidence: 0.99 },
    { entity_id: 'k1', entity_type: 'keyword', state: 'enabled', spend: 4, sales: 0, orders: 0, clicks: 6, impressions: 100, acos: null, current_bid: 0.7, evidence_days: 1, stock: 5 },
  );
  assertEquals(result.valid, false);
  assertEquals(result.reason, 'REDUCTION_REQUIRES_MULTI_DAY_EVIDENCE');
});

Deno.test('plano separa vencedores de desperdício e calcula folga', () => {
  const plan = rebalanceBudgetPlan([
    { entity_id: 'win', entity_type: 'campaign', state: 'enabled', spend: 10, sales: 100, orders: 2, clicks: 20, impressions: 1000, acos: 10, daily_budget: 20, stock: 5 },
    { entity_id: 'loss', entity_type: 'campaign', state: 'enabled', spend: 20, sales: 0, orders: 0, clicks: 30, impressions: 1000, acos: null, daily_budget: 10, stock: 5 },
  ]);
  assertEquals(plan.winners, ['win']);
  assertEquals(plan.underperformers, ['loss']);
  assertEquals(plan.headroom, 70);
});

