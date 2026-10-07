import {makeEntities} from 'file:///app/server/src/sdk/entities.ts';
import {sql} from 'file:///app/server/src/db.ts';
const db=makeEntities();const account='6a40448b9af1241f356e9fcc';const sku='FBA-0122';const asin='B0HLMF8PPD';
const token=Deno.env.get('API_TOKEN')||Deno.env.get('ADMIN_PASSWORD')||'';
async function call(name,payload={}){const r=await fetch('http://127.0.0.1:8000/functions/'+name,{method:'POST',headers:{'content-type':'application/json','x-api-token':token},body:JSON.stringify({_service_role:true,amazon_account_id:account,...payload}),signal:AbortSignal.timeout(180000)});const d=await r.json();console.log(name+'='+JSON.stringify(d));if(!r.ok||d.ok===false)throw Error(name+' failed');return d;}
try{
await call('syncProductCatalogV2');
await call('syncAmazonOfferAvailability',{skus:[sku],max_products:1});
const products=(await db.Product.filter({amazon_account_id:account,sku,asin})).filter(p=>p.status!=='archived');
if(products.length!==1)throw Error('Ambiguous product');const p=products[0];
if(p.campaign_pause_lock===true)throw Error('Explicit manual pause remains');
await db.Product.update(p.id,{ads_scope_status:'authorized',product_cost:80,cost_confirmed:true,cost_confirmation_required:false,price:p.price||159.90,buy_box_price:p.buy_box_price||149.90,amazon_fees:p.amazon_fees||25.49,kickoff_queued:true,kickoff_status:'scheduled'});
const existing=(await db.ProductKickoffQueue.filter({amazon_account_id:account,asin,sku})).find(q=>['scheduled','waiting_stock','processing'].includes(q.status));
const quantity=Number(p.fba_inventory||0);
let queue=existing;
if(!queue)queue=await db.ProductKickoffQueue.create({amazon_account_id:account,asin,sku,product_name:p.product_name,mode:'auto_plus_four',status:quantity>0?'scheduled':'waiting_stock',scheduled_at:new Date().toISOString(),queue_hour:0,queue_window:'00:00-01:00',attempt_count:0,max_attempts:5,last_error:quantity>0?null:'SP-API: disponível FBA zero; aguardando liberação das unidades reservadas',waiting_stock_since:quantity>0?null:new Date().toISOString()});
console.log('MIC_KICKOFF='+JSON.stringify({queue_id:queue.id,status:queue.status,fba_available:quantity,total:p.total_quantity,reserved:p.reserved_inventory,authorized:true,cost:80}));
if(quantity>0){const result=await call('autoKickoffProductV2',{asin,sku,_window_execution:true});if(result.auto_campaign?.ok)await db.ProductKickoffQueue.update(queue.id,{status:'completed',completed_at:new Date().toISOString()});}
}finally{await sql.end();}
