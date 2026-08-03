import { assertEquals } from "jsr:@std/assert@1";
import { clampAmazonBid, enforceBidCeilingOnPayload } from "./amazonBidCeiling.ts";

Deno.test("limita bid numerico e bid.value em R$1,00", () => {
  assertEquals(clampAmazonBid(2), 1);
  assertEquals(clampAmazonBid({ value: 2, currencyCode: "BRL" }), {
    value: 1,
    currencyCode: "BRL",
  });
});

Deno.test("limita keywords, ad groups e targeting clauses", () => {
  assertEquals(
    enforceBidCeilingOnPayload("/sp/keywords", "POST", {
      keywords: [{ keywordId: "k", bid: { value: 2, bidType: "DEFAULT" } }],
    }).keywords[0].bid.value,
    1,
  );
  assertEquals(
    enforceBidCeilingOnPayload("/sp/adGroups", "POST", {
      adGroups: [{ adGroupId: "a", defaultBid: 2 }],
    }).adGroups[0].defaultBid,
    1,
  );
  assertEquals(
    enforceBidCeilingOnPayload("/sp/targets", "PUT", {
      targetingClauses: [{ targetId: "t", bid: 2 }],
    }).targetingClauses[0].bid,
    1,
  );
});
