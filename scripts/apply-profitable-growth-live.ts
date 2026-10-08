import {makeEntities} from 'file:///app/server/src/sdk/entities.ts';
import {sql} from 'file:///app/server/src/db.ts';
import {verifiedBidEvidence} from 'file:///app/base44/shared/verifiedBidEvidence.ts';
import {resolveOperatingAcos,resolveSafeMaxCpc,economicsAreActionable} from 'file:///app/base44/shared/profitGuardPolicy.ts';
import {availableAdsStock,hasFreshAdsInventory} from 'file:///app/base44/shared/stockAdsPolicy.ts';
import {campaignBudgetPolicy} from 'file:///app/base44/shared/campaignBudgetPolicy.ts';
const aid='6a40448b9af1241f356e9fcc',db=makeEntities(),token=Deno.env.get('API_TOKEN')||Deno.env.get('ADMIN_PASSWORD')||'';
const cid='182671770305062',tid='483841461368064',sku='FBA-0076A',asin='B0GHP68123',operation='user_verified_growth_2026_10_08_cap100';
async function call(name,payload){const r=await fetch('http://127.0.0.1:8000/functions/'+name,{method:'POST',headers:{'content-type':'application/json','x-api-token':token},body:JSON.stringify({_service_role:true,amazon_account_id:aid,...payload}),signal:AbortSignal.timeout(240000)});const d=await r.json();if(!r.ok||d.ok===false)throw Error(name+': '+JSON.stringify(d.error||d.errors||d));return d;}
async function ads(path,method,payload,type){return (await call('amazonAdsCommand',{path,method,payload,operation,content_type:'application/vnd.'+type+'.v3+json',accept:'application/vnd.'+type+'.v3+json'})).payload;}
try{
 if(campaignBudgetPolicy({maximum_campaign_budget:100,allow_campaign_budget_overcommit:true}).maximumCampaignBudget!==100)throw Error('Policy missing');
 const ps=(await db.PerformanceSettings.filter({amazon_account_id:aid},'-updated_at',1))[0];
 if(Number(ps?.daily_budget_limit)!==100)throw Error('Unexpected account cap; no change applied');
 const beforeLogs=await db.AdsBidChangeLog.filter({amazon_account_id:aid,source:operation},'-created_at',20);
 if(beforeLogs.length)throw Error('This exact growth operation already has an audit record; inspect it before retrying');
 await db.PerformanceSettings.update(ps.id,{allow_campaign_budget_overcommit:true,maximum_campaign_budget:100,updated_at:new Date().toISOString()});
 console.log('APPLIED_SETTINGS='+JSON.stringify({daily_budget_limit:100,maximum_campaign_budget:100,allow_campaign_budget_overcommit:true}));
 const controllers=await db.AccountDailySpendController.filter({amazon_account_id:aid,spend_date:'2026-10-08'},'-updated_at',10);
 console.log('ACCOUNT_CONTROLLERS='+JSON.stringify(controllers.map(c=>({id:c.id,cap:c.effective_daily_spend_cap,user_cap:c.user_daily_spend_cap,kill_switch:c.global_kill_switch,spend:c.confirmed_spend}))));
 if(controllers.some(c=>Number(c.effective_daily_spend_cap)!==100||c.global_kill_switch))throw Error('Controller cap/stop state requires reconciliation before growth');
 const cost=await call('importProductEconomics',{items:[{sku,unit_cost:40},{sku:'FBA-0008V',unit_cost:40},{sku:'FBA-0122',unit_cost:80}],run_decision_engine:false});console.log('COST_REFRESH='+JSON.stringify({ok:cost.ok,updated:cost.updated}));
 const catalog=await call('syncProductCatalogV2',{});console.log('STOCK_REFRESH='+JSON.stringify({ok:catalog.ok,updated:catalog.updated||catalog.products_updated}));
 const intraday=await call('syncAmazonIntradayCampaignMetrics',{});console.log('INTRADAY_REFRESH='+JSON.stringify(intraday));
 const [products,econs,terms,camps,snaps]=await Promise.all([db.Product.filter({amazon_account_id:aid,sku},'id',100),db.ProductEconomics.filter({amazon_account_id:aid,sku},'id',100),db.SearchTerm.filter({amazon_account_id:aid},'-date',20000),db.Campaign.filter({amazon_account_id:aid},'id',10000),db.IntradaySpendSnapshot.filter({amazon_account_id:aid,spend_date:'2026-10-08'},'-observed_at',10000)]);
 const latest=new Map();for(const s of snaps)if(!latest.has(String(s.campaign_id)))latest.set(String(s.campaign_id),s);const spend=[...latest.values()].reduce((n,s)=>n+Number(s.spend||0),0);
 console.log('ACCOUNT_SPEND='+JSON.stringify({spend,observed_at:snaps[0]?.observed_at,cap:100}));
 if(!snaps.length||Date.now()-Date.parse(snaps[0].observed_at)>90*60000||spend>=90)throw Error('Spend evidence stale or near cap');
 const p=products.filter(p=>p.asin===asin&&p.status!=='archived'&&p.catalog_sync_status!=='duplicate');const es=econs.filter(e=>e.asin===asin);
 if(p.length!==1||es.length!==1)throw Error('Ambiguous product/economics');const product=p[0],e=es[0];
 if(!hasFreshAdsInventory(product)||availableAdsStock(product)<=0||product.campaign_pause_lock||!economicsAreActionable(e)||e.fees_source!=='sp_api_product_fees')throw Error('Stock/economics not actionable');
 const g=verifiedBidEvidence(terms).find(g=>g.campaignId===cid&&g.keywordId===tid&&g.sku===sku&&g.asin===asin);if(!g||g.orders<2||g.clicks<10||g.sales<=0)throw Error('Insufficient verified conversions');
 const policy=resolveOperatingAcos(e,Number(ps.target_acos||20)),acos=g.spend/g.sales*100,safe=resolveSafeMaxCpc({economics:e,observedCvr:g.orders/g.clicks,observedAov:g.sales/g.orders,operatingAcos:policy.target_acos});
 if(acos>policy.target_acos||!safe)throw Error('No profitable growth evidence');
 const campaign=(await ads('/sp/campaigns/list','POST',{campaignIdFilter:{include:[cid]},maxResults:100},'spCampaign')).campaigns?.find(c=>String(c.campaignId)===cid);
 const target=(await ads('/sp/targets/list','POST',{targetIdFilter:{include:[tid]},maxResults:100},'spTargetingClause')).targetingClauses?.find(t=>String(t.targetId)===tid);
 if(campaign?.state!=='ENABLED'||target?.state!=='ENABLED'||String(target.campaignId)!==cid)throw Error('Campaign/target inactive');
 const agid=String(target.adGroupId);
 const adgroup=(await ads('/sp/adGroups/list','POST',{adGroupIdFilter:{include:[agid]},maxResults:100},'spAdGroup')).adGroups?.find(a=>String(a.adGroupId)===agid);
 const adsRows=(await ads('/sp/productAds/list','POST',{adGroupIdFilter:{include:[agid]},maxResults:1000},'spProductAd')).productAds||[];
 if(adgroup?.state!=='ENABLED'||String(adgroup.campaignId)!==cid||!adsRows.some(a=>a.state==='ENABLED'&&a.sku===sku&&a.asin===asin&&String(a.campaignId)===cid))throw Error('Product ad not serving in correct ad group');
 const oldBid=Number(target.bid||adgroup.defaultBid),oldBudget=Number(campaign.budget?.budget);
 const newBid=Math.floor(Math.min(oldBid*1.10,safe,Number(ps.max_bid||1.6))*100)/100;
 console.log('VERIFIED_GROWTH_PLAN='+JSON.stringify({...g,acos,policy,safe_cpc:safe,prior_source:e.safe_max_cpc_source,old_bid:oldBid,new_bid:newBid,old_budget:oldBudget,fba:availableAdsStock(product),expression:target.expression}));
 if(newBid>oldBid){
 const log=await db.AdsBidChangeLog.create({amazon_account_id:aid,campaign_id:cid,target_id:tid,sku,asin,old_bid:oldBid,new_bid:newBid,direction:'increase',source:operation,status:'pending',amazon_confirmed:false,reason:JSON.stringify({acos,target_acos:policy.target_acos,orders:g.orders,clicks:g.clicks,same_sku_verified:true,safe_cpc:safe}),created_at:new Date().toISOString()});
 await ads('/sp/targets','PUT',{targetingClauses:[{targetId:tid,bid:newBid}]},'spTargetingClause');
 const actual=(await ads('/sp/targets/list','POST',{targetIdFilter:{include:[tid]},maxResults:100},'spTargetingClause')).targetingClauses?.find(t=>String(t.targetId)===tid);
 const confirmed=Number(actual?.bid)===newBid;
 await db.AdsBidChangeLog.update(log.id,{status:confirmed?'confirmed':'confirming',amazon_confirmed:confirmed,verified_at:new Date().toISOString()});
 console.log('AMAZON_BID_RESULT='+JSON.stringify({campaign_id:cid,target_id:tid,old_bid:oldBid,requested_bid:newBid,actual_bid:actual?.bid,confirmed}));
 if(!confirmed)throw Error('Bid readback mismatch');
 for(const row of await db.ProductTarget.filter({amazon_account_id:aid,target_id:tid}))await db.ProductTarget.update(row.id,{bid:newBid,current_bid:newBid,last_sync_at:new Date().toISOString()});
 }
 const local=camps.find(c=>String(c.campaign_id||c.amazon_campaign_id)===cid);if(!local)throw Error('Campaign local mapping missing');
 const newBudget=Math.min(18,100);if(oldBudget<newBudget){const b=await call('adjustCampaignBudgets',{adjustments:[{campaign_id:cid,db_id:local.id,new_budget:newBudget,reason:'Verified same-SKU conversions; user authorized growth with unchanged account spending cap'}]});console.log('AMAZON_BUDGET_RESULT='+JSON.stringify(b));}
 const final=(await db.PerformanceSettings.filter({id:ps.id}))[0];console.log('FINAL_ACCOUNT_CAP='+JSON.stringify({daily_budget_limit:final.daily_budget_limit,maximum_campaign_budget:final.maximum_campaign_budget,allow_campaign_budget_overcommit:final.allow_campaign_budget_overcommit}));
}catch(e){console.log('LIVE_GROWTH_ERROR='+String(e));throw e;}finally{await sql.end();}
