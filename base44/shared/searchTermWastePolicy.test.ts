import { assertEquals } from "jsr:@std/assert@1";
import { aggregateSearchTermWasteTargets, dedupeSearchTermWasteRows, decideWasteProgression, firstWasteBid, isTermTargetWaste } from "./searchTermWastePolicy.ts";

const campaign = { asin: "B0GHP9PPWN", sku: "FBA-0008P", name: "AUTO | B0GHP9PPWN" };

Deno.test("deduplicates daily report revisions by newest observation", () => {
  const rows = [
    { unique_key: "same", date: "2026-10-13", campaign_id: "C1", target_id: "T1", search_term: "moedor café", spend: 4, metrics_fresh_at: "2026-10-14T08:00:00Z" },
    { unique_key: "same", date: "2026-10-13", campaign_id: "C1", target_id: "T1", search_term: "moedor café", spend: 5, metrics_fresh_at: "2026-10-14T09:00:00Z" },
  ];
  assertEquals(dedupeSearchTermWasteRows(rows).map((row) => row.spend), [5]);
});

Deno.test("aggregates AUTO rows by target, exact SKU, and one-day sales attribution", () => {
  const rows = [
    { date: "2026-10-13", campaign_id: "C1", target_id: "T1", search_term: "moedor café", search_term_original: "Moedor Café como digitado", normalized_search_term: "moedor café", advertised_asin: "B0GHP9PPWN", advertised_sku: "FBA-0008P", source_type: "AUTO_SEARCH_TERM", spend: 4, clicks: 4, orders_1d: 0, sales_1d: 0, orders_14d: 3, sales_14d: 100 },
    { date: "2026-10-13", campaign_id: "C1", target_id: "T1", search_term: "moedor portátil", search_term_original: "Moedor portátil como digitado", advertised_asin: "B0GHP9PPWN", advertised_sku: "FBA-0008P", source_type: "AUTO_SEARCH_TERM", spend: 6, clicks: 5, orders_1d: 0, sales_1d: 0, orders_14d: 3, sales_14d: 100 },
    { date: "2026-10-13", campaign_id: "C1", target_id: "T1", search_term: "moedor café", advertised_asin: "B0OTHERASIN", advertised_sku: "OTHER", source_type: "AUTO_SEARCH_TERM", spend: 100, clicks: 100, orders_1d: 0, sales_1d: 0 },
  ];
  const result = aggregateSearchTermWasteTargets(rows, new Map([["C1", campaign]]), { fromDate: "2026-10-01", throughDate: "2026-10-13" });
  assertEquals(result.length, 1);
  assertEquals(result[0].isAutomatic, true);
  assertEquals(result[0].spend, 10);
  assertEquals(result[0].orders, 0);
  assertEquals(result[0].terms.length, 2);
  assertEquals(result[0].terms[0].text, "Moedor portátil como digitado");
});

Deno.test("requires fresh, material no-sale evidence and computes a 30% first reduction", () => {
  const eligible = { spend: 12, sales: 0, orders: 0, clicks: 12, attributionComplete: true, latestDate: "2026-10-13", minimumSpend: 10, throughDate: "2026-10-14" };
  assertEquals(isTermTargetWaste(eligible), true);
  assertEquals(isTermTargetWaste({ ...eligible, sales: 1 }), false);
  assertEquals(isTermTargetWaste({ ...eligible, latestDate: "2026-10-01" }), false);
  assertEquals(isTermTargetWaste({ ...eligible, attributionComplete: false }), false);
  assertEquals(firstWasteBid(1.15), 0.81);
});

Deno.test("missing 1-day order or sales fields are not interpreted as zero sales", () => {
  const rows = [{ date: "2026-10-13", campaign_id: "C1", target_id: "T1", search_term: "moedor café", advertised_asin: "B0GHP9PPWN", advertised_sku: "FBA-0008P", spend: 15, clicks: 12 }];
  const [evidence] = aggregateSearchTermWasteTargets(rows, new Map([["C1", campaign]]), { fromDate: "2026-10-01", throughDate: "2026-10-13" });
  assertEquals(evidence.attributionComplete, false);
  assertEquals(isTermTargetWaste({ ...evidence, minimumSpend: 10, throughDate: "2026-10-14" }), false);
});

Deno.test("waste progression requires new evidence and never pauses a whole campaign", () => {
  assertEquals(decideWasteProgression({ priorConfirmedReductions: 0, hoursSinceLastReduction: 0, hoursSinceFirstReduction: 0, spendSinceLastReduction: 0, clicksSinceLastReduction: 0, ordersSinceLastReduction: 0, salesSinceLastReduction: 0, minimumSpend: 5 }), "REDUCE_BID_30");
  const second = { priorConfirmedReductions: 1, hoursSinceLastReduction: 24, hoursSinceFirstReduction: 24, spendSinceLastReduction: 5, clicksSinceLastReduction: 4, ordersSinceLastReduction: 0, salesSinceLastReduction: 0, minimumSpend: 5 };
  assertEquals(decideWasteProgression(second), "REDUCE_BID_10");
  assertEquals(decideWasteProgression({ ...second, spendSinceLastReduction: 0 }), "HOLD");
  const fourthDay = { ...second, priorConfirmedReductions: 2, hoursSinceFirstReduction: 72, termAfterLastReduction: { text: "termo completo", spend: 5, clicks: 8, orders: 0, sales: 0, attributionComplete: true } };
  assertEquals(decideWasteProgression(fourthDay), "NEGATIVE_EXACT");
  assertEquals(decideWasteProgression({ ...fourthDay, alreadyNegative: true }), "HOLD");
  assertEquals(decideWasteProgression({ ...fourthDay, hoursSinceFirstReduction: 48 }), "HOLD");
});
