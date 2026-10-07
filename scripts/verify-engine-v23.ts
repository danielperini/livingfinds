const account = "6a40448b9af1241f356e9fcc";
const token = Deno.env.get("API_TOKEN") || Deno.env.get("ADMIN_PASSWORD") || "";
async function call(name, payload) {
 const r=await fetch("http://127.0.0.1:8000/functions/"+name,{method:"POST",headers:{"content-type":"application/json","x-api-token":token},body:JSON.stringify({amazon_account_id:account,_service_role:true,...payload}),signal:AbortSignal.timeout(240000)});
 const d=await r.json(); if(!r.ok||d.ok===false) throw new Error(name+":"+JSON.stringify(d).slice(0,500)); return d;
}
const costs={"FBA-0087b":40.95,"FBA-0010b":57.55,"FBA-0076A":40,"SKU-002314V":45,"FBA-0087":40.95,"FBA-0008P":40,"FBA-0010":54.60,"FBA-0024b":38.50,"FBA-0071":52.50,"SKU-002314A":45};
const costResult=await call("importProductEconomics",{items:Object.entries(costs).map(([sku,unit_cost])=>({sku,unit_cost,cost_source:"user_confirmed_2026_10_07"})),run_decision_engine:false});
console.log("COST_IMPORT="+JSON.stringify(costResult));
const discovery=await call("discoverDailyKickoffProducts",{});
console.log("DISCOVERY="+JSON.stringify(discovery));
const harvest=await call("runImmediateSameSkuSearchTermHarvest",{dry_run:true,persist:false,lookback_days:30,max_promotions:10,require_fresh_inventory:true});
console.log("HARVEST_PREVIEW="+JSON.stringify(harvest));
