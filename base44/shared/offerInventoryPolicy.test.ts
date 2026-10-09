import {assertEquals} from 'jsr:@std/assert';
import {offerOnlyProductPatch} from './offerInventoryPolicy.ts';
const signal={fulfillment_channel:'MFN',mfn_quantity:0,listing_status_confirmed:true,listing_buyable:true,offer_active:true,listing_suppressed:false};
Deno.test('zero merchant stock cannot erase 20 available FBA units',()=>{const patch=offerOnlyProductPatch({fba_inventory:20},signal,signal,'now');assertEquals(patch.ads_eligibility_status,'eligible');for(const key of ['fba_inventory','available_quantity','status','inventory_status','catalog_sync_status','fulfillment_channel'])assertEquals(Object.hasOwn(patch,key),false);});
Deno.test('merchant units cannot unlock advertising when available FBA is zero',()=>{const s={...signal,mfn_quantity:20};assertEquals(offerOnlyProductPatch({fba_inventory:0},s,s,'now').ads_eligibility_status,'out_of_stock');});
Deno.test('unknown FBA availability stays unconfirmed',()=>assertEquals(offerOnlyProductPatch({},signal,signal,'now').ads_eligibility_status,'verification_pending'));
Deno.test('available FBA does not override Amazon offer suppression',()=>{const s={...signal,listing_suppressed:true};assertEquals(offerOnlyProductPatch({fba_inventory:20},s,s,'now').ads_eligibility_status,'listing_suppressed');});
