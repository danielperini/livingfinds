import { assertEquals } from "jsr:@std/assert";
import { zeroSalesCircuitBreaker, availableInventory, resolveOperatingAcos, resolveSafeMaxCpc } from "./profitGuardPolicy.ts";

Deno.test('v23 inventory is exclusively available FBA', () => {
  assertEquals(availableInventory({ fba_inventory: 20, available_quantity: 0 }), 20);
  assertEquals(availableInventory({ fba_inventory: 0, available_quantity: 99 }), 0);
  assertEquals(availableInventory({ available_quantity: 99 }), -1);
});

Deno.test('thin product margins cannot be raised to the account target or a one-percent floor', () => {
  assertEquals(resolveOperatingAcos({ break_even_acos: 9.38 }, 15).target_acos, 7.5);
  assertEquals(resolveOperatingAcos({ break_even_acos: 0.5 }, 15).target_acos, 0.4);
  assertEquals(resolveOperatingAcos({ economics_status: 'complete', profit_before_ads: -4.07 }, 15).target_acos, 0);
});

Deno.test('old explicit CPC cannot override a lower observed economic ceiling', () => {
  assertEquals(resolveSafeMaxCpc({ economics: { safe_max_cpc: 1.2, current_price: 79.9 }, observedCvr: 0.04, operatingAcos: 9.4 }), 0.30);
  assertEquals(resolveSafeMaxCpc({ economics: { safe_max_cpc: 1.2 }, operatingAcos: 0 }), 0);
});

Deno.test("abre circuito de campanha única antes de acumular prejuízo sem vendas", () => {
  assertEquals(zeroSalesCircuitBreaker({
    clicks: 12, spend: 29.90, orders: 0, sales: 0, maximumProfitableCpa: 30,
  }), { triggered: true, spendLimit: 12 });
});

Deno.test("mantém aprendizado pequeno abaixo do limite econômico", () => {
  assertEquals(zeroSalesCircuitBreaker({
    clicks: 2, spend: 0.72, orders: 0, sales: 0, maximumProfitableCpa: 10,
  }), { triggered: false, spendLimit: 5 });
});

