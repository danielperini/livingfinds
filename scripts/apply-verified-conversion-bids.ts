import {makeEntities} from 'file:///app/server/src/sdk/entities.ts';import {sql} from 'file:///app/server/src/db.ts';
import {availableAdsStock} from 'file:///app/base44/shared/stockAdsPolicy.ts';
import {resolveOperatingAcos,economicsAreActionable} from 'file:///app/base44/shared/profitGuardPolicy.ts';
const db=makeEntities(),aid='6a40448b9af1241f356e9fcc';const token=Deno.env.get('API_TOKEN')||Deno.env.get('ADMIN_PASSWORD')||'';
async function ads(path,method,payload,type){const r=await fetch('http://127.0.0.1:8000/functions/amazonAdsCommand',{method:'POST',headers:{'content-type':'application/json','x-api-token':token},body:JSON.stringify({_service_role:true,amazon_account_id:aid,operation:'user_conversion_economic_bid_adjustment',path,method,payload,content_type:'application/vnd.'+type+'.v3+json',accept:'application/vnd.'+type+'.v3+json'}),signal:AbortSignal.timeout(90000)});const d=await r.json();if(!d.ok)throw Error(JSON.stringify(d.errors||d.error));return d.payload;}
try{
const [products,econs,campaigns,rows]=await Promise.all([db.Product.filter({amazon_account_id:aid},'id',5000),db.ProductEconomics.filter({amazon_account_id:aid},'id',5000),db.Campaign.filter({amazon_account_id:aid},'id',10000),db.SearchTerm.filter({amazon_account_id:aid},'-date',20000)]);
const groups=new Map(),seen=new Set();
for(const r of rows){if(r.date<'2026-09-08'||r.date>'2026-10-06'||!r.advertised_sku)continue;const key=r.unique_key||[r.date,r.campaign_id,r.ad_group_id,r.target_id||r.keyword_id,r.search_term].join('|');if(seen.has(key))continue;seen.add(key);const target=String(r.source_target_id||r.target_id||r.keyword_id||'');if(!target)continue;const type=String(r.match_type).toLowerCase()==='auto'||String(r.source_target_type).includes('targeting')?'targets':'keywords';const gkey=[r.campaign_id,target,r.advertised_sku].join('|');const g=groups.get(gkey)||{campaign:String(r.campaign_id),target,sku:r.advertised_sku,asin:r.advertised_asin,type,spend:0,clicks:0,sales:0,orders:0};g.spend+=Number(r.spend||0);g.clicks+=Number(r.clicks||0);g.sales+=Number(r.same_sku_sales||0);g.orders+=Number(r.same_sku_orders||0);groups.set(gkey,g);}
let changes=0;const results=[];
for(const g of [...groups.values()].sort((a,b)=>b.spend-a.spend)){
 if(changes>=10)break;
 const p=products.find(p=>p.status!=='archived'&&String(p.sku).toUpperCase()===g.sku.toUpperCase()&&p.asin===g.asin);
 const e=econs.find(e=>String(e.sku).toUpperCase()===g.sku.toUpperCase()&&e.asin===g.asin);
 if(!p||availableAdsStock(p)<=0||p.campaign_pause_lock===true||!economicsAreActionable(e)||!String(e.fees_source).startsWith('sp_api')||!String(e.price_source).startsWith('sp_api'))continue;
 const policy=resolveOperatingAcos(e,15);if(!policy.break_even_acos)continue;
 const acos=g.sales>0?g.spend/g.sales*100:null;
 const reduce=g.clicks>=8&&g.spend>=5&&(!g.orders||acos>policy.break_even_acos);
 const increase=g.orders>=3&&g.clicks>=10&&acos!==null&&acos<=policy.target_acos;
 if(!reduce&&!increase)continue;
 const c=(await ads('/sp/campaigns/list','POST',{campaignIdFilter:{include:[g.campaign]},maxResults:100},'spCampaign')).campaigns?.[0];if(c?.state!=='ENABLED')continue;
 const type=g.type==='targets'?'spTargetingClause':'spKeyword',idKey=g.type==='targets'?'targetId':'keywordId',filterKey=g.type==='targets'?'targetIdFilter':'keywordIdFilter';
 const data=await ads('/sp/'+g.type+'/list','POST',{[filterKey]:{include:[g.target]},maxResults:100},type);const remote=data[g.type==='targets'?'targetingClauses':'keywords']?.find(x=>String(x[idKey])===g.target);if(remote?.state!=='ENABLED'||String(remote.campaignId)!==g.campaign)continue;
 let old=Number(remote.bid);if(!(old>0)&&g.type==='targets'){const ag=await ads('/sp/adGroups/list','POST',{adGroupIdFilter:{include:[remote.adGroupId]},maxResults:100},'spAdGroup');old=Number(ag.adGroups?.find(x=>String(x.adGroupId)===String(remote.adGroupId))?.defaultBid);}if(!(old>0))continue;const safe=Number(e.safe_max_cpc||0);if(increase&&!(safe>old))continue;
 const bid=Math.floor((reduce?Math.max(0.1,old*0.8):Math.min(old*1.1,safe,1))*100)/100;if(Math.abs(bid-old)<0.02)continue;
 await ads('/sp/'+g.type,'PUT',{[g.type==='targets'?'targetingClauses':'keywords']:[{[idKey]:g.target,bid}]},type);
 const after=await ads('/sp/'+g.type+'/list','POST',{[filterKey]:{include:[g.target]},maxResults:100},type);const actual=after[g.type==='targets'?'targetingClauses':'keywords']?.find(x=>String(x[idKey])===g.target);const confirmed=Number(actual?.bid)===bid;
 const evidence={...g,old_bid:old,new_bid:bid,confirmed,acos,break_even_acos:policy.break_even_acos};results.push(evidence);console.log('BID_RESULT='+JSON.stringify(evidence));
 if(confirmed){changes++;await db.AdsBidChangeLog.create({amazon_account_id:aid,campaign_id:g.campaign,keyword_id:g.target,target_id:g.target,asin:g.asin,sku:g.sku,old_bid:old,new_bid:bid,direction:reduce?'decrease':'increase',reason:'User conversion optimization; closed 30-day same-SKU report evidence',source:'user_conversion_review',created_at:new Date().toISOString(),amazon_confirmed:true});
 const entity=g.type==='keywords'?db.Keyword:db.ProductTarget;const records=await entity.filter({amazon_account_id:aid,[g.type==='keywords'?'keyword_id':'target_id']:g.target});for(const row of records)await entity.update(row.id,{bid,current_bid:bid,last_sync_at:new Date().toISOString()});}
}
console.log('BID_SUMMARY='+JSON.stringify({changes,results}));
}finally{await sql.end();}
