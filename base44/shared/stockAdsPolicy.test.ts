import { assertEquals } from 'jsr:@std/assert';
import { stockAdsDecision } from './stockAdsPolicy.ts';

Deno.test('pauses advertising with zero units', () => {
  assertEquals(stockAdsDecision({ available_quantity: 0 }), 'pause');
});

Deno.test('activates advertising even with one or three units', () => {
  for (const quantity of [1, 2, 3, 8, 60, 92]) {
    assertEquals(stockAdsDecision({ available_quantity: quantity }), 'activate');
  }
});

Deno.test('does not guess when inventory is unknown', () => {
  assertEquals(stockAdsDecision({}), 'unknown');
  assertEquals(stockAdsDecision({ available_quantity: 'invalid' }), 'unknown');
  assertEquals(stockAdsDecision({ available_quantity: -1 }), 'unknown');
});

Deno.test('explicit zero available stock takes precedence over FBA stock', () => {
  assertEquals(stockAdsDecision({ available_quantity: 0, fba_inventory: 60 }), 'pause');
  assertEquals(stockAdsDecision({ fba_inventory: 1 }), 'activate');
});
