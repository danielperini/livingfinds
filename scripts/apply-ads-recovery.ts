// Run only after deploying the recovery code. Uses existing guarded handlers.
import { sql, query } from "file:///app/server/src/db.ts";
import { campaignCoverageEligible } from "file:///app/base44/shared/campaignCoverageEligibility.ts";
import { hasFreshAdsInventory } from "file:///app/base44/shared/stockAdsPolicy.ts";
const aid="6a40448b9af1241f356e9fcc";
const skus=["FBA-0010p","W9-OL7U-LRW5","FBA-0010","FBA-0100","SKU-002314V","FBA-0076A","FBA-0008V","FBA-0008P","FBA-0087b","FBA-0087","FBA-0010b","FBA-0071","FBA-0024b"];
const token=Deno.env.get("API_TOKEN")||Deno.env.get("ADMIN_PASSWORD")||"";
async function call(name,payload={}) {
 const res=await fetch("http://127.0.0.1:8000/functions/"+name,{method:"POST",headers:{"content-type":"application/json","x-api-token":token},body:JSON.stringify({_service_role:true,amazon_account_id:aid,...payload}),signal:AbortSignal.timeout(240000)});
 const data=await res.json(); console.log("RECOVERY="+JSON.stringify({name,http:res.status,data}).slice(0,30000));return data;
}
try {
 const sync=await call("syncProductCatalogV2");
 if(sync.ok!==true)throw Error("Inventory not confirmed");
 await call("syncAmazonOfferAvailability",{skus,max_products:100});
 await call("autoStockCampaignGuard");
 const rows=await query("SELECT id,data FROM product");
 for(const row of rows) {
  const p={...row.data,id:row.id};
  if(p.amazon_account_id!==aid||p.status==="archived"||!skus.includes(p.sku))continue;
  console.log("RECOVERED_PRODUCT="+JSON.stringify({sku:p.sku,asin:p.asin,stock:p.available_quantity,lock:p.campaign_pause_lock,lock_actor:p.campaign_pause_locked_by,pause_reason:p.pause_reason,eligible:p.ads_eligibility_status,sync:p.last_catalog_sync_at}));
  if(campaignCoverageEligible(p)&&hasFreshAdsInventory(p)) {
   await call("createAutoCampaignForAsin",{asin:p.asin,sku:p.sku,product_name:p.product_name||"",launch_at_minimum:true});
  }
 }
 await call("refreshSameSkuSearchTermReports",{lookback_days:30});
 await call("verifyRemoteSkuCampaignFloor");
} finally { await sql.end(); }
