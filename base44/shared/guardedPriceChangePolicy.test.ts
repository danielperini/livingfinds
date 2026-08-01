import { assertEquals } from "jsr:@std/assert";
import { applyGuardedPriceChange, deterministicPriceConfidence, priceChangeUsedInWindow } from "./guardedPriceChangePolicy.ts";

Deno.test("limita preço ideal 105 a 102 com confiança 94", () => {
  const result = applyGuardedPriceChange({ currentPrice: 100, proposedPrice: 105, decisionConfidence: 94, priceChangeUsed24h: 0 });
  assertEquals(result.guardedPrice, 102);
  assertEquals(result.automaticAllowed, true);
  assertEquals(result.idealPrice, 105);
});

Deno.test("soma direções opostas e ações pendentes", () => {
  const used = priceChangeUsedInWindow({ nowMs: Date.parse("2026-08-01T12:00:00Z"), actions: [
    { status: "confirmed", old_price: 100, new_price: 101.5, created_at: "2026-08-01T08:00:00Z" },
    { status: "pending", old_price: 101.5, new_price: 101, created_at: "2026-08-01T10:00:00Z" },
  ] });
  assertEquals(used, 2);
});

Deno.test("confiança 84 gera somente recomendação", () => {
  assertEquals(applyGuardedPriceChange({ currentPrice: 100, proposedPrice: 102, decisionConfidence: 84, priceChangeUsed24h: 0 }).status, "recommendation_only");
});

Deno.test("pontuação auditável soma sete componentes", () => {
  const result = deterministicPriceConfidence({ economicsComplete: true, priceAndFeesFresh: true, inventoryFresh: true, equivalentCompetitionValid: true, salesAndConversionSufficient: true, adsMetricsMatured: false, priceHistorySufficient: false });
  assertEquals(result.score, 80);
  assertEquals(result.missingData, ["ads_metrics_matured", "price_history_sufficient"]);
});
