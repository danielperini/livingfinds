import { assertEquals } from "jsr:@std/assert@1";
import { listingOfferStatus, normalizeListingStates } from "./listingOfferStatus.ts";

Deno.test("normaliza status de listing retornado como array pela Amazon", () => {
  assertEquals(normalizeListingStates([{ status: ["BUYABLE", "DISCOVERABLE"] }]), [
    "BUYABLE",
    "DISCOVERABLE",
  ]);
  assertEquals(listingOfferStatus([{ status: ["BUYABLE", "DISCOVERABLE"] }]).offerActive, true);
});

Deno.test("aceita formato legado separado por virgula sem gerar falso negativo", () => {
  assertEquals(listingOfferStatus([{ status: "BUYABLE,DISCOVERABLE" }]).offerActive, true);
});

Deno.test("distingue oferta inativa de status ainda nao observado", () => {
  assertEquals(listingOfferStatus([{ status: ["INACTIVE"] }]), {
    states: ["INACTIVE"], statusKnown: true, offerActive: false,
  });
  assertEquals(listingOfferStatus([]), { states: [], statusKnown: false, offerActive: false });
});
