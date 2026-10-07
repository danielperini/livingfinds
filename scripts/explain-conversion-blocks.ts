import {makeEntities} from 'file:///app/server/src/sdk/entities.ts';import {sql} from 'file:///app/server/src/db.ts';
import {aggregateSearchTerms,calculateSafeHarvestBid} from 'file:///app/base44/shared/searchTermHarvestPolicy.ts';
import {economicsAreActionable,resolveOperatingAcos,resolveSafeMaxCpc} from 'file:///app/base44/shared/profitGuardPolicy.ts';
const db=makeEntities(),aid='6a40448b9af1241f356e9fcc';try{
const terms=await db.SearchTerm.filter({amazon_account_id:aid},'-date',20000);const econs=await db.ProductEconomics.filter({amazon_account_id:aid},'-updated_at',3000);const settings=(await db.PerformanceSettings.filter({amazon_account_id:aid},'-updated_at',1))[0];
const assessments=await db.DailyProductAdsAssessment.filter({amazon_account_id:aid},'-assessment_date',5000);
for(const a of aggregateSearchTerms(terms.filter(t=>t.date>='2026-09-08'&&t.same_sku_attribution_verified===true)).filter(a=>a.sameSkuOrders>0)){
const es=econs.filter(e=>String(e.sku).toUpperCase()===a.sku.toUpperCase()&&e.asin===a.asin);const e=es.length===1?es[0]:null;const assessment=assessments.find(x=>x.asin===a.asin);const policy=resolveOperatingAcos(e,settings.target_acos);const safe=resolveSafeMaxCpc({economics:e,observedCvr:a.sameSkuOrders/a.clicks,observedAov:a.sameSkuSales/a.sameSkuOrders,operatingAcos:policy.target_acos});
console.log('BLOCK_DETAIL='+JSON.stringify({sku:a.sku,term:a.term,orders:a.sameSkuOrders,sales:a.sameSkuSales,spend:a.spend,clicks:a.clicks,economyMatches:es.length,economicsStatus:e?.economics_status,actionable:economicsAreActionable(e,assessment),assessment:{status:assessment?.economic_status,data:assessment?.data_status,confidence:assessment?.confidence},policy,safe,min:settings.min_bid,bid:calculateSafeHarvestBid({observedCpc:a.spend/a.clicks,safeCpc:safe,minBid:settings.min_bid,maxBid:settings.max_bid})}));}
}finally{await sql.end();}
