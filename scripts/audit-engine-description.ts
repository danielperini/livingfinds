import {makeEntities} from 'file:///app/server/src/sdk/entities.ts';
import {sql,query} from 'file:///app/server/src/db.ts';
import {resolveOperatingAcos} from 'file:///app/base44/shared/profitGuardPolicy.ts';
const db=makeEntities(),aid='6a40448b9af1241f356e9fcc';
const pick=(o,keys)=>Object.fromEntries(keys.filter(k=>o[k]!==undefined).map(k=>[k,o[k]]));
try{
console.log('AUDIT_TIME='+new Date().toISOString());
console.log('HEALTH='+await (await fetch('http://127.0.0.1:8000/health')).text());
for(const [entity,keys,limit] of [
 ['Product',['sku','asin','fba_inventory','fba_total_inventory','fba_reserved_inventory','inventory_updated_at','last_inventory_sync','last_sync_at','fba_stock_override','campaign_pause_lock','kickoff_status'],300],
 ['SearchTermPromotion',['promotion_status','asin','source_search_term','error','last_error','created_at','updated_at'],100],
 ['AdsBidChangeLog',['created_at','sku','asin','campaign_id','old_bid','new_bid','reason','source','amazon_confirmed'],20],
 ['SyncRun',['function_name','status','started_at','completed_at','error','summary'],8],
 ['DailyProductAdsAssessment',['asin','sku','assessment_date','status','reason','block_reason','safe_max_cpc','target_acos'],6],
 ['PerformanceSettings',['min_bid','max_bid','target_acos','daily_budget','max_daily_budget','autopilot_enabled'],3],
 ['ProductEconomics',['sku','asin','current_price','unit_cost','purchase_cost','amazon_fee_amount','total_variable_cost_per_unit','break_even_acos','target_acos','safe_max_cpc','economics_status','price_source','fees_source','amazon_fee_percent','cost_confirmed','cost_source','unit_cost_source'],300]
]){try{const rows=await db[entity].filter({amazon_account_id:aid},'-updated_date',limit);let out=rows;
if(entity==='Product'){const fresh=rows.map(r=>r.last_sync_at||r.inventory_updated_at||r.updated_date).filter(Boolean).sort();console.log('CATALOG='+JSON.stringify({rows:rows.length,positive_fba:rows.filter(r=>Number(r.fba_inventory)>0).length,manual_locks:rows.filter(r=>r.campaign_pause_lock).length,latest:fresh.at(-1)}));out=rows.filter(r=>r.sku==='FBA-0122');}
if(entity==='ProductEconomics')out=rows.filter(r=>['FBA-0076A','FBA-0008V','FBA-0122'].includes(r.sku));
if(entity==='SearchTermPromotion'){const counts={};for(const r of rows)counts[r.promotion_status||'unset']=(counts[r.promotion_status||'unset']||0)+1;console.log('PROMOTION_COUNTS='+JSON.stringify(counts));out=rows.slice(0,4);}
if(entity==='ProductEconomics')console.log('ECONOMIC_POLICY='+JSON.stringify(out.map(e=>({sku:e.sku,policy:resolveOperatingAcos(e,20),gross_formula:(Number(e.current_price)-Number(e.total_variable_cost_per_unit))/Number(e.current_price)*100}))));
console.log('ENTITY='+JSON.stringify({entity,rows:out.map(r=>pick(r,keys))}));}catch(e){console.log('READ_ERROR='+entity+':'+e.message);}}
console.log('DECISIONS='+JSON.stringify(await query("SELECT data->>'status' status,data->>'action_type' action,count(*) FROM optimization_decision WHERE data->>'amazon_account_id'=$1 AND created_date >= NOW()-INTERVAL '24 hours' GROUP BY 1,2 ORDER BY count(*) DESC LIMIT 20",[aid])));
}finally{await sql.end();}
