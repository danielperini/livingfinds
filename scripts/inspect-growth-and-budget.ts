import {makeEntities} from 'file:///app/server/src/sdk/entities.ts';import {sql} from 'file:///app/server/src/db.ts';
import {resolveOperatingAcos,resolveSafeMaxCpc,economicsAreActionable} from 'file:///app/base44/shared/profitGuardPolicy.ts';
import {availableAdsStock,hasFreshAdsInventory} from 'file:///app/base44/shared/stockAdsPolicy.ts';
import {verifiedBidEvidence} from 'file:///app/base44/shared/verifiedBidEvidence.ts';
const db=makeEntities(),aid='6a40448b9af1241f356e9fcc';
try{
 for(const entity of ['PerformanceSettings','AutopilotConfig','BudgetConfiguration']){const rows=await db[entity].filter({amazon_account_id:aid},'-updated_at',5);console.log('BUDGET_SETTINGS='+JSON.stringify({entity,rows:rows.map(r=>Object.fromEntries(Object.entries(r).filter(([k])=>k==='id'||/budget|spend.*limit|nominal|overcommit/.test(k))))}));}
 const [products,econs,terms,snaps,camps]=await Promise.all([db.Product.filter({amazon_account_id:aid},'id',5000),db.ProductEconomics.filter({amazon_account_id:aid},'id',5000),db.SearchTerm.filter({amazon_account_id:aid},'-date',20000),db.IntradaySpendSnapshot.filter({amazon_account_id:aid,spend_date:'2026-10-08'},'-observed_at',10000),db.Campaign.filter({amazon_account_id:aid},'id',10000)]);
 const latest=new Map();for(const s of snaps)if(!latest.has(String(s.campaign_id)))latest.set(String(s.campaign_id),s);
 console.log('SPEND_TODAY='+JSON.stringify({snapshots:snaps.length,asof:snaps[0]?.observed_at,spend:[...latest.values()].reduce((a,s)=>a+Number(s.spend||0),0),sales:[...latest.values()].reduce((a,s)=>a+Number(s.sales||0),0),campaigns:[...latest.values()].filter(s=>s.spend>0).map(s=>({id:s.campaign_id,spend:s.spend,clicks:s.clicks,orders:s.orders}))}));
 for(const g of verifiedBidEvidence(terms)){
 const matches=r=>r.asin===g.asin&&String(r.sku).toUpperCase()===g.sku;
 const ps=products.filter(p=>p.status!=='archived'&&p.catalog_sync_status!=='duplicate'&&matches(p)),es=econs.filter(matches);if(ps.length!==1||es.length!==1)continue;const p=ps[0],e=es[0];
 if(!hasFreshAdsInventory(p)||availableAdsStock(p)<=0||p.campaign_pause_lock||!economicsAreActionable(e))continue;
 const policy=resolveOperatingAcos(e,20),acos=g.sales>0?g.spend/g.sales*100:null;
 if(g.orders<1||g.clicks<2||acos===null||acos>policy.target_acos)continue;
 const safe=resolveSafeMaxCpc({economics:e,observedCvr:g.orders/g.clicks,observedAov:g.sales/g.orders,operatingAcos:policy.target_acos});
 const c=camps.find(c=>String(c.campaign_id||c.amazon_campaign_id)===g.campaignId);
 console.log('GROWTH_CANDIDATE='+JSON.stringify({...g,stock:availableAdsStock(p),policy,acos,safe_cpc:safe,campaign_state:c?.state||c?.status,budget:c?.daily_budget,kind:c?.targeting_type||c?.amazon_targeting_type}));
 }
 console.log('ACTIVE_BUDGETS='+JSON.stringify(camps.filter(c=>String(c.state||c.status).toUpperCase()==='ENABLED').map(c=>({id:c.campaign_id||c.amazon_campaign_id,asin:c.asin,sku:c.sku,budget:c.daily_budget,name:c.name||c.campaign_name})).slice(0,80)));
}finally{await sql.end();}
