import {sql,query} from "file:///app/server/src/db.ts";
try {
 const rows=await query("SELECT id,data FROM product WHERE data->>'amazon_account_id'=$1",["6a40448b9af1241f356e9fcc"]);
 for(const row of rows) {
  const p=row.data;
  if(["FBA-0122","FBA-0087","I1-NOI2-CU3W","FBA-0076A","SKU-002314V","FBA-0321"].includes(p.sku)&&p.status!=="archived") console.log("FBA_VERIFICATION="+JSON.stringify(Object.fromEntries(["sku","asin","fba_inventory","available_quantity","total_quantity","reserved_inventory","inbound_inventory","last_catalog_sync_at","catalog_sync_status","cost_confirmed","ads_scope_status","kickoff_discovery_status"].map(k=>[k,p[k]??null]))));
 }
} finally {await sql.end();}
