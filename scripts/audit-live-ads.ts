// Read-only production diagnosis. Never updates bids, campaigns or product records.
import { sql, query } from "file:///app/server/src/db.ts";
const asins = ["B0HFB78DNP","B0HBM8V2DP","B0DJ3RGHK6","B0GR6GXS1B","B0GNW1Q6V3","B0GHP68123","B0GHP958MV","B0GHP9PPWN","B0GFQ5YT3H","B0GFQ7SY5W","B0FN4RCXY2","B0FHX1HPMT","B0F45JG27L"];
const pick = (row, fields) => Object.fromEntries(fields.map(k => [k,row[k] ?? null]));
const load = async table => (await query(`SELECT id, created_date, updated_date, data FROM ${table} ORDER BY updated_date DESC LIMIT 12000`)).map(r => ({...r.data,id:r.id,created_date:r.created_date,updated_date:r.updated_date}));
try {
  const products = await load("product"), campaigns = await load("campaign"), keywords = await load("keyword");
  const economics = await load("product_economics"), logs = await load("sync_execution_log");
  for (const asin of asins) {
    const ps=products.filter(p=>p.asin===asin), cs=campaigns.filter(c=>c.asin===asin);
    const ids=new Set(cs.flatMap(c=>[c.id,c.campaign_id,c.amazon_campaign_id]).filter(Boolean));
    const ks=keywords.filter(k=>ids.has(k.campaign_id));
    const counts=rows=>rows.reduce((out,r)=>{const s=String(r.state||r.status||"unknown");out[s]=(out[s]||0)+1;return out;},{});
    const active=ks.filter(k=>["enabled","active"].includes(String(k.state||k.status).toLowerCase()));
    const bids=active.map(k=>Number(k.bid)).filter(Number.isFinite);
    console.log("PRODUCT_AUDIT="+JSON.stringify({asin,products:ps.map(p=>pick(p,["sku","available_quantity","catalog_sync_status","last_catalog_sync_at","cost_confirmed","ads_scope_status","ads_eligibility_status","campaign_pause_lock","pause_reason"])),campaigns:counts(cs),recent_campaigns:cs.filter(c=>Date.parse(c.created_date)>=Date.now()-4*86400000).map(c=>pick(c,["campaign_id","state","created_date"])),keywords:counts(ks),active_bid_range:bids.length?[Math.min(...bids),Math.max(...bids)]:null,economics:economics.filter(e=>e.asin===asin).slice(0,1).map(e=>pick(e,["safe_max_cpc","break_even_acos","profit_after_ads","contribution_margin_amount","updated_date"]))}));
  }
  const recent=logs.filter(l=>Date.parse(l.updated_date)>=Date.now()-2*86400000);
  const operations=new Set();
  for(const l of recent) {
    if(operations.has(l.operation)||!/(unified|kickoff|catalog|harvest|sales_mode|canonical)/i.test(l.operation||""))continue;
    operations.add(l.operation);
    console.log("ENGINE_LOG="+JSON.stringify(pick(l,["operation","status","started_at","completed_at","error_message","result_summary"])).slice(0,20000));
  }
} finally { await sql.end(); }
const token=Deno.env.get("API_TOKEN")||Deno.env.get("ADMIN_PASSWORD")||"";
for(const name of ["verifyRemoteSkuCampaignFloor","runImmediateSameSkuSearchTermHarvest"]) {
  const res=await fetch("http://127.0.0.1:8000/functions/"+name,{method:"POST",headers:{"content-type":"application/json","x-api-token":token},body:JSON.stringify({_service_role:true,dry_run:true,persist:false,lookback_days:30,max_promotions:2,require_fresh_inventory:true})});
  console.log("LIVE_CHECK="+JSON.stringify({name,http:res.status,data:await res.json()}).slice(0,35000));
}
