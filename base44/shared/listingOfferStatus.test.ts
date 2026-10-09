import { assertEquals } from "jsr:@std/assert@1";
import { listingOfferStatus, normalizeListingStates, listingBuyability } from "./listingOfferStatus.ts";

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

Deno.test('BUYABLE fan with error 100581 attribute suppression is still buyable',()=>{
 const state=listingBuyability([{status:['DISCOVERABLE','BUYABLE']}],[{code:'100581',severity:'ERROR',enforcements:{actions:[{action:'ATTRIBUTE_SUPPRESSED'}]}}]);
 assertEquals(state.buyable,true);assertEquals(state.suppressed,false);assertEquals(state.issueCodes,['100581']);
});
Deno.test('actual listing suppression blocks even a cached BUYABLE status',()=>{
 for(const issue of [{enforcements:{actions:[{action:'LISTING_SUPPRESSED'}]}},{enforcementActions:['SEARCH_SUPPRESSED']}]) assertEquals(listingBuyability([{status:['BUYABLE']}],[issue]).buyable,false);
});
Deno.test('DISCOVERABLE alone never proves an offer can be purchased',()=>assertEquals(listingBuyability([{status:['DISCOVERABLE']}],[]).buyable,false));
