import { assertEquals } from 'jsr:@std/assert';
import { proportionalActivationBid } from '../../shared/activationBidPolicy.ts';

Deno.test('uses configured floor when economics are missing', () => {
  assertEquals(proportionalActivationBid({ min_bid: 0.12, max_bid: 2 }, null, null), 0.12);
});

Deno.test('keeps a loss-making SKU active with a low proportional bid', () => {
  assertEquals(proportionalActivationBid(
    { min_bid: 0.10, max_bid: 2 },
    { safe_max_cpc: 0.40, profit_after_ads: -5 },
    null,
  ), 0.22);
});

Deno.test('caps healthy activation bid below safe CPC and configured maximum', () => {
  assertEquals(proportionalActivationBid(
    { min_bid: 0.10, max_bid: 0.50 },
    { safe_max_cpc: 1, profit_after_ads: 10 },
    null,
  ), 0.50);
});
