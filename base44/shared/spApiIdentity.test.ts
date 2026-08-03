import { assertEquals } from "jsr:@std/assert";
import {
  resolveSellerId,
  selectSpApiSamples,
  sellerIdFromAdsProfiles,
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

Deno.test("extrai Seller ID do accountInfo do perfil Ads preferido", () => {
  const profiles = [
    { profileId: "111", accountInfo: { id: "VENDOR", type: "vendor" } },
    { profileId: "222", accountInfo: { id: "A2SELLERID", type: "seller" } },
  ];
  assertEquals(sellerIdFromAdsProfiles(profiles, "222"), "A2SELLERID");
});

Deno.test("Listings usa SKU mesmo sem ASIN e diagnóstico identifica cobertura", () => {
  const samples = selectSpApiSamples([{ sku: "SKU-1" }, { asin: "B0001" }]);
  assertEquals(samples.listing?.sku, "SKU-1");
  assertEquals(samples.asin?.asin, "B0001");
  assertEquals(samples.pricing, null);
});

Deno.test("diagnostico prioriza SKU ativo com estoque e marketplace correto", () => {
  const samples = selectSpApiSamples([
    { sku: "ANTIGO", asin: "B000000001", archived: true, stock: 20 },
    { sku: "SEM-ESTOQUE", asin: "B000000002", stock: 0, marketplace_id: "BR" },
    { sku: "ATIVO", asin: "B000000003", stock: 4, status: "active", marketplace_id: "BR" },
    { sku: "OUTRO-MKT", asin: "B000000004", stock: 10, marketplace_id: "US" },
  ], "BR");
  assertEquals(samples.listing?.sku, "ATIVO");
  assertEquals(samples.pricing?.sku, "ATIVO");
  assertEquals(samples.listingCandidates.map((item) => item.sku), ["ATIVO", "SEM-ESTOQUE"]);
});
