import { assertEquals } from "jsr:@std/assert";
import {
  resolveSellerId,
  selectSpApiSamples,
  sellerIdFromParticipations,
} from "./spApiIdentity.ts";

Deno.test("resolve Seller ID canônico e aliases sem aceitar espaços", () => {
  assertEquals(resolveSellerId({ seller_id: "  A123  " }).sellerId, "A123");
  assertEquals(resolveSellerId({ selling_partner_id: "A456" }).sellerId, "A456");
  assertEquals(resolveSellerId({}, { SP_SELLER_ID: "A789" }).sellerId, "A789");
});

Deno.test("extrai Seller ID da resposta oficial de participações", () => {
  assertEquals(sellerIdFromParticipations({ payload: [{ seller: { sellerId: "A123" } }] }), "A123");
});

Deno.test("Listings usa SKU mesmo sem ASIN e diagnóstico identifica cobertura", () => {
  const samples = selectSpApiSamples([{ sku: "SKU-1" }, { asin: "B0001" }]);
  assertEquals(samples.listing?.sku, "SKU-1");
  assertEquals(samples.asin?.asin, "B0001");
  assertEquals(samples.pricing, null);
});
