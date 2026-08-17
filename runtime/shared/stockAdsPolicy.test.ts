import { assertEquals } from 'jsr:@std/assert';
import { stockAdsDecision } from './stockAdsPolicy.ts';

Deno.test('pauses advertising with zero or one unit', () => {
  assertEquals(stockAdsDecision({ available_quantity: 0 }), 'pause');
  assertEquals(stockAdsDecision({ available_quantity: 1 }), 'pause');
});

Deno.test('activates advertising from two units', () => {
  assertEquals(stockAdsDecision({ available_quantity: 2 }), 'activate');
});

Deno.test('does not guess when inventory is unknown', () => {
  assertEquals(stockAdsDecision({}), 'unknown');
});
