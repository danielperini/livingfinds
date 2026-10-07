const token=Deno.env.get("API_TOKEN")||Deno.env.get("ADMIN_PASSWORD")||"";
async function call(name,payload) {const r=await fetch("http://127.0.0.1:8000/functions/"+name,{method:"POST",headers:{"content-type":"application/json","x-api-token":token},body:JSON.stringify({_service_role:true,amazon_account_id:"6a40448b9af1241f356e9fcc",...payload}),signal:AbortSignal.timeout(180000)});const data=await r.json(); console.log(name+"="+JSON.stringify(data));if(!r.ok||data.ok===false)throw new Error(name+" failed");return data;}
await call("syncProductCatalogV2",{});
await call("syncAmazonIntradayCampaignMetrics",{action:"auto",trigger_type:"user_traffic_recovery"});
await call("enforceSkuProfitProtection",{dry_run:false,trigger_type:"user_traffic_recovery"});
import {sql,query} from "file:///app/server/src/db.ts";
try {
 const products=await query("SELECT id,data FROM product WHERE data->>'amazon_account_id'=$1 AND data->>'sku'=$2",["6a40448b9af1241f356e9fcc","FBA-0122"]);
 for(const row of products){const p=row.data;console.log("MICROPHONE="+JSON.stringify({id:row.id,sku:p.sku,asin:p.asin,name:p.product_name,status:p.status,offer_active:p.offer_active,listing_buyable:p.listing_buyable,fba:p.fba_inventory,total:p.total_quantity,reserved:p.reserved_inventory,is_new_asin:p.is_new_asin,synced:p.last_catalog_sync_at}));}
}finally{await sql.end();}
