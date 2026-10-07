import {sql,query} from 'file:///app/server/src/db.ts';
const token=Deno.env.get('API_TOKEN')||Deno.env.get('ADMIN_PASSWORD')||'';const account='6a40448b9af1241f356e9fcc';
async function call(name,payload={}){const r=await fetch('http://127.0.0.1:8000/functions/'+name,{method:'POST',headers:{'content-type':'application/json','x-api-token':token},body:JSON.stringify({_service_role:true,amazon_account_id:account,...payload}),signal:AbortSignal.timeout(240000)});const d=await r.json();console.log('RESULT='+JSON.stringify({name,status:r.status,data:d}));return d;}
try{
await call('syncProductCatalogV2');
await call('ensureDailyReportsCurrent',{trigger_type:'user_campaign_review'});
for(let i=0;i<4;i++){const d=await call('syncAmazonIntradayCampaignMetrics',{action:'auto',trigger_type:'user_campaign_review'});if(d.results?.some(r=>r.skipped||r.status==='pending'||r.status==='polling'))break;}
await call('runImmediateSameSkuSearchTermHarvest',{dry_run:false,lookback_days:30,max_promotions:5,require_fresh_inventory:true,target_asins:['B0DJ3RGHK6','B0GHP958MV','B0GR6GXS1B','B0GHP68123','B0FN4RCXY2','B0F45JG27L','B0FHX1HPMT','B0HBM8V2DP','B0GFQ7SY5W','B0HFB78DNP','B0HLMF8PPD'],trigger_type:'user_campaign_review'});
await call('enforceSkuProfitProtection',{dry_run:false,trigger_type:'user_campaign_review'});
await call('runIntradaySalesRecovery',{dry_run:true,_canonical_orchestrator:'runUnifiedDecisionEngine',trigger_type:'user_campaign_review'});
console.log('DECISION_ACTIVITY='+JSON.stringify(await query("SELECT data->>'status' status,data->>'action_type' action,count(*) FROM optimization_decision WHERE data->>'amazon_account_id'=$1 AND COALESCE(data->>'created_at',data->>'created_date','') >= '2026-10-07' GROUP BY 1,2 ORDER BY count(*) DESC LIMIT 20",[account])));
console.log('PENDING_PROMOTIONS='+JSON.stringify(await query("SELECT data->>'promotion_status' status,count(*) FROM search_term_promotion WHERE data->>'amazon_account_id'=$1 GROUP BY 1",[account])));
}finally{await sql.end();}
