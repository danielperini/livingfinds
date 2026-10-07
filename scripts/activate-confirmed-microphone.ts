import {makeEntities} from 'file:///app/server/src/sdk/entities.ts';
import {sql} from 'file:///app/server/src/db.ts';
const db=makeEntities();const account='6a40448b9af1241f356e9fcc';const sku='FBA-0122';const asin='B0HLMF8PPD';
const token=Deno.env.get('API_TOKEN')||Deno.env.get('ADMIN_PASSWORD')||'';
async function call(name,payload={}){const r=await fetch('http://127.0.0.1:8000/functions/'+name,{method:'POST',headers:{'content-type':'application/json','x-api-token':token},body:JSON.stringify({_service_role:true,amazon_account_id:account,...payload}),signal:AbortSignal.timeout(240000)});const d=await r.json();console.log(name+'='+JSON.stringify(d));return d;}
try{
const sync=await call('syncProductCatalogV2');if(!sync.ok)throw Error('Inventory sync failed');
const products=(await db.Product.filter({amazon_account_id:account,sku,asin})).filter(p=>p.status!=='archived');
if(products.length!==1)throw Error('Ambiguous product');const p=products[0];if(p.campaign_pause_lock===true)throw Error('Manual pause');
const now=Date.now();await db.Product.update(p.id,{fba_stock_override:{quantity:20,source:'seller_confirmed',confirmed_at:new Date(now).toISOString(),expires_at:new Date(now+24*3600000).toISOString(),evidence:'Seller Central listing supplied by owner; explicit request to use 20 available FBA',sku,asin},ads_scope_status:'authorized',product_cost:80,cost_confirmed:true,cost_confirmation_required:false,price:159.90,buy_box_price:159.90,amazon_fees:26.79});
await call('syncAmazonOfferAvailability',{skus:[sku],max_products:1});
const result=await call('autoKickoffProductV2',{asin,sku,_window_execution:true});
if(result.auto_campaign?.ok){
 for(const q of await db.ProductKickoffQueue.filter({amazon_account_id:account,asin,sku}))if(['waiting_stock','scheduled'].includes(q.status))await db.ProductKickoffQueue.update(q.id,{status:'completed',completed_at:new Date().toISOString()});
 await db.Product.update(p.id,{kickoff_queued:false,kickoff_status:'completed',has_campaign:true,campaign_id:result.auto_campaign.campaign_id,campaign_status:'active'});
}
const all=await db.Product.filter({amazon_account_id:account},'id',5000);
const skus=['FBA-0122','FBA-0024b','FBA-0024c','FBA-0010p','W9-OL7U-LRW5','FBA-0010','FBA-0100','FBA-0076A','FBA-0008V','FBA-0008P','FBA-0087b','FBA-0087','FBA-0010b','FBA-0071'];
console.log('STOCK_REVIEW='+JSON.stringify(all.filter(p=>p.status!=='archived'&&skus.some(s=>s.toLowerCase()===String(p.sku).toLowerCase())).map(p=>({sku:p.sku,asin:p.asin,api_available:p.fba_inventory,total:p.total_quantity,reserved:p.reserved_inventory,override:p.fba_stock_override,kickoff:p.kickoff_status,campaign:p.campaign_id}))));
const health=await fetch('http://127.0.0.1:8000/health');console.log('SCHEDULER_HEALTH='+await health.text());
}finally{await sql.end();}
