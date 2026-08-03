import { assertEquals } from "jsr:@std/assert@1";
import { keywordIdsAboveEconomicCeiling, winnerBidEligibility } from "./winnerBidPolicy.ts";

const now = Date.parse("2026-08-03T05:00:00Z");
const fresh = "2026-08-03T04:00:00Z";

Deno.test("libera R$1,50 somente para winner com ACoS dentro da meta", () => {
  assertEquals(winnerBidEligibility({ orders: 2, sales: 100, acos: 20, performance_confirmed_at: fresh }, 25, now).ceiling, 1.5);
  assertEquals(winnerBidEligibility({ orders: 2, sales: 100, acos: 30, performance_confirmed_at: fresh }, 25, now).ceiling, 1);
  assertEquals(winnerBidEligibility({ orders: 0, sales: 0, acos: 0, performance_confirmed_at: fresh }, 25, now).ceiling, 1);
});

Deno.test("bloqueia excecao quando os dados estao vencidos", () => {
  assertEquals(winnerBidEligibility({ orders: 3, sales: 100, acos: 10, performance_confirmed_at: "2026-07-20T00:00:00Z" }, 25, now).ceiling, 1);
});

Deno.test("identifica somente keywords que pedem excecao", () => {
  assertEquals(keywordIdsAboveEconomicCeiling({ keywords: [
    { keywordId: "a", bid: 0.8 },
    { keywordId: "b", bid: { value: 1.2 } },
  ] }), ["b"]);
});
