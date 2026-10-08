import {makeEntities} from 'file:///app/server/src/sdk/entities.ts';import {sql} from 'file:///app/server/src/db.ts';
import {verifiedBidEvidence} from 'file:///app/base44/shared/verifiedBidEvidence.ts';
import {resolveOperatingAcos,resolveSafeMaxCpc,economicsAreActionable} from 'file:///app/base44/shared/profitGuardPolicy.ts';
import {availableAdsStock,hasFreshAdsInventory} from 'file:///app/base44/shared/stockAdsPolicy.ts';
const aid='6a40448b9af1241f356e9fcc',db=makeEntities(),token=Deno.env.get('API_TOKEN')||Deno.env.get('ADMIN_PASSWORD')||'';
async function call(name,payload={}){const r=await fetch('http://127.0.0.1:8000/functions/'+name,{method:'POST',headers:{'content-type':'application/json','x-api-token':token},body:JSON.stringify({_service_role:true,amazon_account_id:aid,...payload}),signal:AbortSignal.timeout(240000)});const d=await r.json();if(!r.ok||d.ok===false)throw Error(name+': '+JSON.stringify(d.error||d.errors||d));return d;}
async function list(path,type,key,filter={}){const rows=[];let nextToken;do{const d=await call('amazonAdsCommand',{path,method:'POST',content_type:'application/vnd.'+type+'.v3+json',accept:'application/vnd.'+type+'.v3+json',payload:{...filter,maxResults:1000,...(nextToken?{nextToken}:{})}});rows.push(...(d.payload?.[key]||[]));nextToken=d.payload?.nextToken;}while(nextToken);return rows;}
try{
 const sync=await call('syncProductCatalogV2');console.log('AUDIT_SYNC='+JSON.stringify({ok:sync.ok}));
 const campaigns=await list('/sp/campaigns/list','spCampaign','campaigns',{stateFilter:{include:['ENABLED']}});
 const productAds=await list('/sp/productAds/list','spProductAd','productAds',{stateFilter:{include:['ENABLED']}});
 const adGroups=await list('/sp/adGroups/list','spAdGroup','adGroups',{stateFilter:{include:['ENABLED']}});
 const [products,econs,terms,keywords,targets,settings,snaps]=await Promise.all([
 db.Product.filter({amazon_account_id:aid},'id',5000),db.ProductEconomics.filter({amazon_account_id:aid},'id',5000),db.SearchTerm.filter({amazon_account_id:aid},'-date',20000),db.Keyword.filter({amazon_account_id:aid},'id',20000),db.ProductTarget.filter({amazon_account_id:aid},'id',10000),db.PerformanceSettings.filter({amazon_account_id:aid},'-updated_at',1),db.IntradaySpendSnapshot.filter({amazon_account_id:aid,spend_date:'2026-10-08'},'-observed_at',20000)]);
 const evidence=verifiedBidEvidence(terms), latest=new Map();for(const s of snaps)if(!latest.has(String(s.campaign_id)))latest.set(String(s.campaign_id),s);
 const groups=new Set(adGroups.map(a=>String(a.adGroupId))),items=[];
 for(const c of campaigns){const cid=String(c.campaignId);const ads=productAds.filter(a=>String(a.campaignId)===cid&&groups.has(String(a.adGroupId)));const offers=[...new Map(ads.map(a=>[a.sku+'|'+a.asin,a])).values()];
 if(!offers.length){items.push({cid,name:c.name,type:c.targetingType,budget:c.budget?.budget,reason:'no_enabled_ad_with_enabled_group'});continue;}
 for(const ad of offers){const ps=products.filter(p=>p.sku===ad.sku&&p.asin===ad.asin&&p.status!=='archived'&&p.catalog_sync_status!=='duplicate'),es=econs.filter(e=>e.sku===ad.sku&&e.asin===ad.asin);const p=ps.length===1?ps[0]:null,e=es.length===1?es[0]:null;
 const ev=evidence.filter(g=>g.campaignId===cid&&g.sku===ad.sku.toUpperCase()&&g.asin===ad.asin);const policy=resolveOperatingAcos(e,Number(settings[0]?.target_acos||20));
 let reason=ps.length!==1?'ambiguous_or_missing_product':!hasFreshAdsInventory(p)?'inventory_not_fresh':availableAdsStock(p)<=0?'no_available_fba':p.campaign_pause_lock?'manual_pause_lock':!economicsAreActionable(e)?'economics_incomplete':!ev.length?'no_verified_target_evidence':ev.every(g=>g.orders===0)?'no_verified_same_sku_orders':ev.some(g=>g.orders>0&&g.sales>0&&g.spend/g.sales*100<=policy.target_acos)?'profitable_conversion':'acos_above_product_target';
 const activeLocal=[...(c.targetingType==='AUTO'?targets:keywords)].filter(k=>String(k.campaign_id)===cid&&['ENABLED','ACTIVE'].includes(String(k.state||k.status).toUpperCase()));
 items.push({cid,name:c.name,type:c.targetingType,budget:c.budget?.budget,sku:ad.sku,asin:ad.asin,fba:p?availableAdsStock(p):null,reason,cost_confirmed:e?.costs_confirmed_by_user,cost:e?.unit_cost,econ_status:e?.economics_status,policy,local_active_targets:activeLocal.length,today:latest.get(cid)?{spend:latest.get(cid).spend,clicks:latest.get(cid).clicks,orders:latest.get(cid).orders}:null,evidence:ev.map(g=>({...g,acos:g.sales>0?g.spend/g.sales*100:null,safe_cpc:resolveSafeMaxCpc({economics:e,observedCvr:g.clicks?g.orders/g.clicks:0,observedAov:g.orders?g.sales/g.orders:0,operatingAcos:policy.target_acos})}))});}
 }
 for(const row of items)console.log('CAMPAIGN_AUDIT='+JSON.stringify(row));
 console.log('AUDIT_TOTAL='+JSON.stringify({amazon_enabled_campaigns:campaigns.length,auto:campaigns.filter(c=>c.targetingType==='AUTO').length,manual:campaigns.filter(c=>c.targetingType==='MANUAL').length,with_active_ads:new Set(items.filter(i=>i.sku).map(i=>i.cid)).size,reason_counts:items.reduce((a,i)=>(a[i.reason]=(a[i.reason]||0)+1,a),{}),same_sku_targets:evidence.length,terms:terms.length,spend_observed_at:snaps[0]?.observed_at,account_cap:settings[0]?.daily_budget_limit}));
}finally{await sql.end();}
