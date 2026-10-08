import { assertEquals } from "jsr:@std/assert";
import { zeroSalesCircuitBreaker, availableInventory, resolveOperatingAcos, resolveSafeMaxCpc, resolveBreakEvenAcos } from "./profitGuardPolicy.ts";

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


Deno.test('Amazon total fees are not subtracted twice', () => {
  const econ={current_price:71.9,total_variable_cost_per_unit:54.68,amazon_fee_amount:14.68,amazon_fee_percent:12,break_even_acos:23.95};
  assertEquals(resolveOperatingAcos(econ,20).break_even_acos,23.95);
  assertEquals(resolveOperatingAcos(econ,20).target_acos,19.16);
});
Deno.test('missing totals do not fabricate a microphone margin', () => {
  assertEquals(resolveBreakEvenAcos({current_price:159.9,unit_cost:80,amazon_fee_amount:26.79,amazon_fee_percent:13}),null);
  for(const v of [null,undefined,'',false,NaN]) assertEquals(resolveBreakEvenAcos({current_price:100,total_variable_cost_per_unit:v}),null);
  assertEquals(resolveBreakEvenAcos({current_price:100,total_variable_cost_per_unit:110,break_even_acos:20}),0);
  assertEquals(resolveBreakEvenAcos({break_even_acos:0,contribution_margin_percent:12}),0);
});

Deno.test('observed conversion replaces a modeled prior but never a manual CPC cap',()=>{
 const p={economics:{safe_max_cpc:0.49,safe_max_cpc_source:'modeled_prior_cvr'},observedCvr:0.1,observedAov:107.85,operatingAcos:13.56};
 assertEquals(resolveSafeMaxCpc(p),1.46);
 assertEquals(resolveSafeMaxCpc({...p,economics:{safe_max_cpc:0.49,safe_max_cpc_source:'manual_cap'}}),0.49);
});
