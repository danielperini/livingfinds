const token=Deno.env.get('API_TOKEN')||Deno.env.get('ADMIN_PASSWORD')||'';const account='6a40448b9af1241f356e9fcc';
async function call(name,payload={}){const r=await fetch('http://127.0.0.1:8000/functions/'+name,{method:'POST',headers:{'content-type':'application/json','x-api-token':token},body:JSON.stringify({_service_role:true,amazon_account_id:account,...payload}),signal:AbortSignal.timeout(240000)});const d=await r.json();console.log('RESULT='+JSON.stringify({name,status:r.status,data:d}));return d;}
await call('importProductEconomics',{items:[{sku:'FBA-0008V',unit_cost:40},{sku:'FBA-0076A',unit_cost:40}],run_decision_engine:false,refresh_amazon_status:false});
await call('runDailyEconomicAssessment',{dry_run:false,force:true});
await call('ensureDailyReportsCurrent',{trigger_type:'corrected_report_definitions'});
await call('syncProductCatalogV2');
await call('runImmediateSameSkuSearchTermHarvest',{dry_run:false,lookback_days:30,max_promotions:5,require_fresh_inventory:true,target_asins:['B0DJ3RGHK6','B0GHP958MV','B0GR6GXS1B','B0GHP68123','B0FN4RCXY2','B0F45JG27L','B0FHX1HPMT','B0HBM8V2DP','B0GFQ7SY5W','B0HFB78DNP','B0HLMF8PPD'],trigger_type:'user_verified_conversion_creation'});
await call('enforceSkuProfitProtection',{dry_run:false,trigger_type:'user_conversion_bid_optimization'});
