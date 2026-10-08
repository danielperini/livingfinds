import {makeEntities} from 'file:///app/server/src/sdk/entities.ts';import {sql} from 'file:///app/server/src/db.ts';
import {resolveOperatingAcos,economicsAreActionable} from 'file:///app/base44/shared/profitGuardPolicy.ts';
const aid='6a40448b9af1241f356e9fcc',db=makeEntities(),token=Deno.env.get('API_TOKEN')||Deno.env.get('ADMIN_PASSWORD')||'';
async function call(name,payload={}){const r=await fetch('http://127.0.0.1:8000/functions/'+name,{method:'POST',headers:{'content-type':'application/json','x-api-token':token},body:JSON.stringify({_service_role:true,amazon_account_id:aid,...payload}),signal:AbortSignal.timeout(240000)});const d=await r.json();console.log('COST_REVIEW_RESULT='+JSON.stringify({name,http:r.status,...d}));if(!r.ok||d.ok===false)throw Error(name+' failed');return d;}
try{
 await call('importProductEconomics',{items:[{sku:'FBA-0010p',unit_cost:42},{sku:'FBA-0100',unit_cost:280},{sku:'W9-OL7U-LRW5',unit_cost:39}],run_decision_engine:false});
 const wanted=['FBA-0010P','FBA-0100','W9-OL7U-LRW5'];const products=(await db.Product.filter({amazon_account_id:aid},'id',5000)).filter(p=>wanted.includes(String(p.sku).toUpperCase())&&p.catalog_sync_status==='success'&&p.status==='active');
 for(const p of products)await call('runAutomaticRepricing',{operation:'full_evaluation',product_id:p.id,recommendation_only:true});
 await call('importProductEconomics',{items:[{sku:'FBA-0010p',unit_cost:42},{sku:'FBA-0100',unit_cost:280},{sku:'W9-OL7U-LRW5',unit_cost:39}],run_decision_engine:false});
 const es=(await db.ProductEconomics.filter({amazon_account_id:aid},'id',5000)).filter(e=>wanted.includes(String(e.sku).toUpperCase()));
 for(const e of es)console.log('COST_REVIEW_FINAL='+JSON.stringify({id:e.id,sku:e.sku,asin:e.asin,cost:e.unit_cost,price:e.current_price,fees:e.total_amazon_fees,fees_source:e.fees_source,fees_verified_at:e.fees_verified_at,tax:e.simple_national_tax_pct,total_variable:e.total_variable_cost_per_unit,confirmed:e.costs_confirmed_by_user,status:e.economics_status,actionable:economicsAreActionable(e),policy:resolveOperatingAcos(e,20),safe_max_cpc:e.safe_max_cpc}));
}finally{await sql.end();}
