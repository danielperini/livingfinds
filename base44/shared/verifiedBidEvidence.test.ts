import {assertEquals} from 'jsr:@std/assert';
import {verifiedBidEvidence} from './verifiedBidEvidence.ts';
const now=Date.parse('2026-10-08T13:00:00Z');
const r={date:'2026-10-01',metrics_fresh_at:'2026-10-08T12:00:00Z',same_sku_attribution_verified:true,advertised_sku:'SKU-A',advertised_asin:'ASIN-A',campaign_id:'1',source_target_id:'2',search_term:'microfone',clicks:10,spend:4,same_sku_orders:1,same_sku_sales:100};
Deno.test('only fresh verified closed-day attribution counts, no duplicate exports',()=>{
 const rows=verifiedBidEvidence([r,{...r}, {...r,date:'2026-10-08'}, {...r,search_term:'halo',same_sku_attribution_verified:false},{...r,search_term:'stale',metrics_fresh_at:'2026-10-01T12:00:00Z'}],now);
 assertEquals(rows.length,1);assertEquals(rows[0].clicks,10);assertEquals(rows[0].sales,100);
});
Deno.test('fresh clicks are not used for zero-conversion cuts before attribution matures',()=>{
 const rows=verifiedBidEvidence([{...r,date:'2026-10-06',same_sku_orders:0,same_sku_sales:0}],now);
 assertEquals(rows[0].clicks,10);assertEquals(rows[0].matureClicks,0);
});
Deno.test('two SKUs remain separate and unknown sales are not zero',()=>{
 assertEquals(verifiedBidEvidence([r,{...r,advertised_sku:'SKU-B'}],now).length,2);
 assertEquals(verifiedBidEvidence([{...r,same_sku_sales:null}],now).length,0);
});
