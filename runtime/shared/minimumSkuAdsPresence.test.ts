import { assertEquals } from 'jsr:@std/assert';
import { chooseMinimumPresenceHours, minimumPresenceGate } from './minimumSkuAdsPresence.ts';

Deno.test('produto com uma unidade recebe teto diário conservador', () => {
  assertEquals(minimumPresenceGate({ stock: 1, buyable: true, economicsComplete: true, profitBeforeAds: 20, safeMaxCpc: 0.70, minimumBid: 0.40 }),
    { eligible: true, reason: 'MINIMUM_PRESENCE_SAFE', dailyCap: 2.8 });
});

Deno.test('não anuncia sem estoque, economia ou CPC seguro', () => {
  assertEquals(minimumPresenceGate({ stock: 0, buyable: true, economicsComplete: true, profitBeforeAds: 20, safeMaxCpc: 0.7, minimumBid: 0.4 }).eligible, false);
  assertEquals(minimumPresenceGate({ stock: 2, buyable: true, economicsComplete: false, profitBeforeAds: 20, safeMaxCpc: 0.7, minimumBid: 0.4 }).eligible, false);
  assertEquals(minimumPresenceGate({ stock: 2, buyable: true, economicsComplete: true, profitBeforeAds: 20, safeMaxCpc: 0.2, minimumBid: 0.4 }).eligible, false);
});

Deno.test('seleciona as duas horas historicamente mais econômicas', () => {
  assertEquals(chooseMinimumPresenceHours([
    { hour: 9, spend: 5, sales: 0, clicks: 10 },
    { hour: 12, spend: 2, sales: 40, orders: 1, clicks: 4 },
    { hour: 18, spend: 3, sales: 60, orders: 1, clicks: 5 },
  ]), [12, 18]);
});

Deno.test('sem histórico usa duas horas diurnas conservadoras', () => {
  assertEquals(chooseMinimumPresenceHours([]), [11, 12]);
});
