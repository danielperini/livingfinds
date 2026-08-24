import { assertEquals } from 'jsr:@std/assert@1';
import { boundedSoftRuleChange, classifyPortfolioCampaign, portfolioEfficiency } from './weeklyAiDecisionManagerPolicy.ts';
Deno.test('classifica cinco estados sem tratar zero venda novo como ineficiente', () => {
  assertEquals(classifyPortfolioCampaign({ impressions: 0, clicks: 0, spend: 0 }), 'UNDEREXPOSED');
  assertEquals(classifyPortfolioCampaign({ impressions: 30, clicks: 2, spend: 2 }), 'LEARNING');
  assertEquals(classifyPortfolioCampaign({ clicks: 12, spend: 20, orders: 0 }), 'INEFFICIENT');
  assertEquals(classifyPortfolioCampaign({ orders: 1, profit_after_ads: 10, acos: 10, target_acos: 20 }), 'EFFICIENT');
  assertEquals(classifyPortfolioCampaign({ orders: 3, profit_after_ads: 10, acos: 10, target_acos: 20 }), 'WINNER');
});
Deno.test('calcula eficiência e limita mudança soft a 25%', () => {
  const kpi = portfolioEfficiency([{ classification: 'WINNER', spend: 80 }, { classification: 'INEFFICIENT', spend: 20 }]);
  assertEquals(kpi.efficient_campaign_rate, 0.5); assertEquals(kpi.efficient_spend_share, 0.8);
  assertEquals(boundedSoftRuleChange('winner_bid_step', 0.1, 0.2).value, 0.125);
  assertEquals(boundedSoftRuleChange('safeMaxCpc', 1, 2).allowed, false);
});
