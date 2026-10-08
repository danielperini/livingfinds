import {makeEntities} from 'file:///app/server/src/sdk/entities.ts';import {sql} from 'file:///app/server/src/db.ts';
const aid='6a40448b9af1241f356e9fcc',db=makeEntities(),token=Deno.env.get('API_TOKEN')||Deno.env.get('ADMIN_PASSWORD')||'';
async function call(name,payload={}){const r=await fetch('http://127.0.0.1:8000/functions/'+name,{method:'POST',headers:{'content-type':'application/json','x-api-token':token},body:JSON.stringify({_service_role:true,amazon_account_id:aid,...payload}),signal:AbortSignal.timeout(240000)});return await r.json();}
try{
 console.log('FINAL_SYNC='+JSON.stringify(await call('syncAmazonIntradayCampaignMetrics')));
 console.log('FINAL_CONTROLLER='+JSON.stringify(await call('updateDailySpendController')));
 const settings=(await db.PerformanceSettings.filter({amazon_account_id:aid},'-updated_at',1))[0];
 const campaigns=await call('amazonAdsCommand',{path:'/sp/campaigns/list',method:'POST',content_type:'application/vnd.spCampaign.v3+json',payload:{campaignIdFilter:{include:['182671770305062']},maxResults:100}});
 const targets=await call('amazonAdsCommand',{path:'/sp/targets/list',method:'POST',content_type:'application/vnd.spTargetingClause.v3+json',payload:{targetIdFilter:{include:['483841461368064']},maxResults:100}});
 console.log('FINAL_AMAZON='+JSON.stringify({campaign:campaigns.payload?.campaigns?.map(c=>({id:c.campaignId,state:c.state,budget:c.budget})),target:targets.payload?.targetingClauses?.map(t=>({id:t.targetId,state:t.state,bid:t.bid})),account_cap:settings.daily_budget_limit,maximum_campaign_budget:settings.maximum_campaign_budget,allow_campaign_budget_overcommit:settings.allow_campaign_budget_overcommit}));
 const snapshots=await db.IntradaySpendSnapshot.filter({amazon_account_id:aid,spend_date:'2026-10-08'},'-observed_at',10000),latest=new Map();for(const s of snapshots)if(!latest.has(String(s.campaign_id)))latest.set(String(s.campaign_id),s);
 console.log('FINAL_SPEND='+JSON.stringify({spend:[...latest.values()].reduce((sum,s)=>sum+Number(s.spend||0),0),observed_at:snapshots[0]?.observed_at}));
}finally{await sql.end();}
