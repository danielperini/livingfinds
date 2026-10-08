import {makeEntities} from 'file:///app/server/src/sdk/entities.ts';
import {sql} from 'file:///app/server/src/db.ts';
import {resolveOperatingAcos} from 'file:///app/base44/shared/profitGuardPolicy.ts';
import {availableAdsStock} from 'file:///app/base44/shared/stockAdsPolicy.ts';
const aid='6a40448b9af1241f356e9fcc',db=makeEntities();
const token=Deno.env.get('API_TOKEN')||Deno.env.get('ADMIN_PASSWORD')||'';
async function call(name,payload){const r=await fetch('http://127.0.0.1:8000/functions/'+name,{method:'POST',headers:{'content-type':'application/json','x-api-token':token},body:JSON.stringify({_service_role:true,amazon_account_id:aid,...payload}),signal:AbortSignal.timeout(240000)});const d=await r.json();console.log('FIX_RESULT='+JSON.stringify({name,http:r.status,data:d}));return d;}
try{
 const probe=resolveOperatingAcos({current_price:71.9,total_variable_cost_per_unit:54.68,amazon_fee_amount:14.68,amazon_fee_percent:12,break_even_acos:23.95},20);
 if(probe.break_even_acos!==23.95)throw Error('Corrected policy not deployed');
 await call('importProductEconomics',{items:[{sku:'FBA-0076A',unit_cost:40},{sku:'FBA-0008V',unit_cost:40},{sku:'FBA-0122',unit_cost:80}],run_decision_engine:false});
 await call('syncProductCatalogV2',{});
 await call('confirmSameSkuSearchTermPromotions',{max_promotions:50});
 await call('runDailyEconomicAssessment',{force:true,assessment_date:'2026-10-07'});
 await call('runImmediateSameSkuSearchTermHarvest',{dry_run:true,lookback_days:30,max_promotions:5,require_fresh_inventory:true});
 await call('smartBidFromCpc',{dry_run:true,max_actions:10,trigger_type:'user_economic_fix_review'});
 const econs=await db.ProductEconomics.filter({amazon_account_id:aid},'-updated_at',5000);
 console.log('FIX_ECONOMICS='+JSON.stringify(econs.filter(e=>['FBA-0076A','FBA-0008V','FBA-0122'].includes(e.sku)).map(e=>({sku:e.sku,cost:e.unit_cost,status:e.economics_status,cost_confirmed:e.costs_confirmed_by_user,price:e.current_price,tax_pct:e.simple_national_tax_pct,cost_total:e.total_variable_cost_per_unit,policy:resolveOperatingAcos(e,20)}))));
 const products=await db.Product.filter({amazon_account_id:aid,sku:'FBA-0122'});console.log('FIX_MIC_STOCK='+JSON.stringify(products.map(p=>({sku:p.sku,api_available:p.fba_inventory,used_for_ads:availableAdsStock(p),kickoff:p.kickoff_status}))));
}catch(e){console.log('FIX_ERROR='+String(e));throw e;}finally{await sql.end();}
