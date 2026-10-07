import {sql,query} from "file:///app/server/src/db.ts";
try {
 const rows=await query("SELECT id,data FROM product WHERE data->>'amazon_account_id'=$1",["6a40448b9af1241f356e9fcc"]);
 for(const row of rows) {
  const p=row.data;
  if(["FBA-0122","FBA-0087","I1-NOI2-CU3W","FBA-0076A","SKU-002314V","FBA-0321"].includes(p.sku)&&p.status!=="archived") console.log("FBA_VERIFICATION="+JSON.stringify(Object.fromEntries(["sku","asin","fba_inventory","available_quantity","total_quantity","reserved_inventory","inbound_inventory","last_catalog_sync_at","catalog_sync_status","cost_confirmed","ads_scope_status","kickoff_discovery_status"].map(k=>[k,p[k]??null]))));
 }
} finally {await sql.end();}

const token=Deno.env.get("API_TOKEN")||Deno.env.get("ADMIN_PASSWORD")||"";
const costRes=await fetch("http://127.0.0.1:8000/functions/importProductEconomics",{method:"POST",headers:{"content-type":"application/json","x-api-token":token},body:JSON.stringify({_service_role:true,amazon_account_id:"6a40448b9af1241f356e9fcc",items:[{sku:"FBA-0122",unit_cost:80,cost_source:"user_confirmed_2026_10_07"}],run_decision_engine:false}),signal:AbortSignal.timeout(120000)});
console.log("MIC_COST="+JSON.stringify(await costRes.json()));
const res=await fetch("http://127.0.0.1:8000/functions/runImmediateSameSkuSearchTermHarvest",{method:"POST",headers:{"content-type":"application/json","x-api-token":token},body:JSON.stringify({_service_role:true,amazon_account_id:"6a40448b9af1241f356e9fcc",dry_run:true,persist:false,lookback_days:30,max_promotions:10,require_fresh_inventory:true}),signal:AbortSignal.timeout(120000)});
console.log("FINAL_HARVEST="+JSON.stringify(await res.json()));
