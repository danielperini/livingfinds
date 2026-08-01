import { assertEquals } from "jsr:@std/assert";
import {
  stripUnsupportedCompetitorFacts,
  validateCompetitorSalesEstimate,
} from "./competitorDataPolicy.ts";

Deno.test("remove vendas e Ads concorrentes declarados como fatos", () => {
  const result = stripUnsupportedCompetitorFacts({
    competitor_sales: 20,
    competitor_roas: 4,
    featured_offer_price: 79.9,
  });
  assertEquals(result.sanitized, { featured_offer_price: 79.9 });
  assertEquals(result.removed.sort(), ["competitor_roas", "competitor_sales"]);
});

Deno.test("estimativa concorrente exige source inferred e confiança baixa ou média", () => {
  assertEquals(validateCompetitorSalesEstimate({
    competitor_sales_estimate: 12,
    competitor_sales_estimate_confidence: "medium",
    competitor_sales_estimate_source: "inferred",
  }).valid, true);
  assertEquals(validateCompetitorSalesEstimate({
    competitor_sales_estimate: 12,
    competitor_sales_estimate_confidence: "high",
    competitor_sales_estimate_source: "amazon_sp_api",
  }).valid, false);
});
