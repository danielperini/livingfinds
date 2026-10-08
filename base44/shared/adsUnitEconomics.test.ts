import { assertEquals } from 'jsr:@std/assert';
import { calculateAdsUnitEconomics, adsEconomicsStatus } from './adsUnitEconomics.ts';
const base={costs_confirmed_by_user:true,current_price:71.9,unit_cost:40,amazon_fee_amount:14.68,amazon_fee_percent:12,fba_fee:6.05,amazon_fixed_fee:0,price_source:'sp_api_listings_items',fees_source:'sp_api_product_fees',fees_verified_at:'2026-10-08T10:00:00Z'};
Deno.test('confirmed cost stays partial when historical advertising CPA is missing',()=>{
 assertEquals(adsEconomicsStatus(base,false),'partial');
 assertEquals(adsEconomicsStatus({...base,costs_confirmed_by_user:false},false),'missing_cost');
 assertEquals(adsEconomicsStatus({...base,fees_source:'sp_api_error_429'},false),'missing_fees');
});
Deno.test('fee total replaces component fees and returns are counted once',()=>{
 assertEquals(calculateAdsUnitEconomics(base)?.total_variable_cost_per_unit,54.68);
 assertEquals(calculateAdsUnitEconomics({...base,estimated_return_cost:2,simple_national_tax_pct:7})?.total_variable_cost_per_unit,61.71);
 assertEquals(calculateAdsUnitEconomics({...base,current_price:159.9,unit_cost:80,amazon_fee_amount:26.79})?.break_even_acos,33.21);
});
Deno.test('missing, negative and unconfirmed inputs cannot invent a margin',()=>{
 assertEquals(calculateAdsUnitEconomics({...base,unit_cost:null}),null);
 assertEquals(calculateAdsUnitEconomics({...base,costs_confirmed_by_user:false}),null);
 assertEquals(calculateAdsUnitEconomics({...base,amazon_fee_amount:null,amazon_fee_percent:null}),null);
 assertEquals(calculateAdsUnitEconomics({...base,other_variable_cost_per_unit:-1}),null);
});
