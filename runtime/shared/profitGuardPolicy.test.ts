import { assertEquals } from "jsr:@std/assert";
import { zeroSalesCircuitBreaker } from "./profitGuardPolicy.ts";

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

