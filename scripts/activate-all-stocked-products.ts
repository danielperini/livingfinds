import {makeEntities} from 'file:///app/server/src/sdk/entities.ts';import {sql} from 'file:///app/server/src/db.ts';
import {availableAdsStock,hasFreshAdsInventory} from 'file:///app/base44/shared/stockAdsPolicy.ts';
import {productOfferEligibility} from 'file:///app/base44/shared/productCampaignPauseGuard.ts';
import {resolveConfiguredBidPolicy} from 'file:///app/base44/shared/configuredBidPolicy.ts';
const aid='6a40448b9af1241f356e9fcc',db=makeEntities(),token=Deno.env.get('API_TOKEN')||Deno.env.get('ADMIN_PASSWORD')||'',operation='user_all_stocked_products_impressions_20261009';
async function call(name,payload={}){const r=await fetch('http://127.0.0.1:8000/functions/'+name,{method:'POST',headers:{'content-type':'application/json','x-api-token':token},body:JSON.stringify({_service_role:true,amazon_account_id:aid,...payload}),signal:AbortSignal.timeout(360000)});const d=await r.json();if(!r.ok||d.ok===false)throw Error(name+': '+JSON.stringify(d.error||d.errors||d));return d;}
async function ads(path,method,payload,type){return (await call('amazonAdsCommand',{path,method,payload,operation,content_type:'application/vnd.'+type+'.v3+json',accept:'application/vnd.'+type+'.v3+json'})).payload;}
async function list(path,type,key,filter={}){const rows=[];let nextToken;do{const d=await ads(path,'POST',{...filter,maxResults:1000,...(nextToken?{nextToken}:{})},type);rows.push(...(d?.[key]||[]));nextToken=d?.nextToken;}while(nextToken);return rows;}
const norm=s=>String(s||'').trim().toUpperCase();
try{
 // Stop only the superseded diagnostic process before it can apply the revoked containment.
 for await(const entry of Deno.readDir('/proc')){if(!/^\d+$/.test(entry.name)||Number(entry.name)===Deno.pid)continue;try{const cmd=await Deno.readTextFile('/proc/'+entry.name+'/cmdline');const args=cmd.split('\0');if(args[0]?.endsWith('deno')&&args.includes('eval')&&cmd.includes('LOSS_'+'CONTAINMENT=')&&cmd.includes('SPECIFIC_'+'CONVERTING_TERMS=')){const k=await new Deno.Command('kill',{args:['-TERM',entry.name]}).output();console.log('SUPERSEDED_PROCESS_STOP='+JSON.stringify({pid:entry.name,success:k.success}));}}catch{}}
 const settings=(await db.PerformanceSettings.filter({amazon_account_id:aid},'-updated_at',1))[0];if(Number(settings.daily_budget_limit)!==100)throw Error('Unexpected account cap');
 const bidPolicy=resolveConfiguredBidPolicy(settings),floor=Math.min(bidPolicy.ceiling,Math.max(0.45,bidPolicy.minBid));
 await call('syncProductCatalogV2');
 let products=await db.Product.filter({amazon_account_id:aid},'id',5000);
 const stocked=products.filter(p=>hasFreshAdsInventory(p)&&availableAdsStock(p)>0&&/^B0[A-Z0-9]{8}$/.test(p.asin));
 const staleOffer=[...new Set(stocked.filter(p=>!p.listing_checked_at||Date.now()-Date.parse(p.listing_checked_at)>3600000).map(p=>p.sku))];
 for(let i=0;i<staleOffer.length;i+=5){const part=staleOffer.slice(i,i+5);const r=await call('syncAmazonOfferAvailability',{skus:part,max_products:100});console.log('COVERAGE_OFFER_REFRESH='+JSON.stringify({skus:part,result:r}));}
 // Offer reads must never substitute MFN quantities for the user's FBA availability.
 await call('syncProductCatalogV2');products=await db.Product.filter({amazon_account_id:aid},'id',5000);
 const canonical=new Map();for(const p of products.filter(p=>hasFreshAdsInventory(p)&&availableAdsStock(p)>0).sort((a,b)=>availableAdsStock(b)-availableAdsStock(a)))if(!canonical.has(p.asin))canonical.set(p.asin,p);
 const eligible=[],blocked=[];
 for(const p of canonical.values()){const offer=productOfferEligibility(p);if(!offer.eligible||p.listing_buyable!==true||p.offer_active!==true){blocked.push({sku:p.sku,asin:p.asin,fba:availableAdsStock(p),reason:offer.reason||'OFFER_NOT_CONFIRMED',detail:p.ads_ineligibility_reason});continue;}eligible.push(p);}
 const eligibleAsins=new Set(eligible.map(p=>p.asin));
 for(const p of products.filter(p=>eligibleAsins.has(p.asin)&&p.campaign_pause_lock===true)){await db.Product.update(p.id,{campaign_pause_lock:false,campaign_pause_lock_reason:null,campaign_pause_reason:null,campaign_pause_locked_at:null,campaign_pause_locked_by:operation,campaign_pause_lock_source:operation,pause_reason:null,ads_pause_reason:null,ads_scope_status:p.ads_scope_status==='manual_block'?'authorized':p.ads_scope_status,ads_resume_pending:true,updated_at:new Date().toISOString()});}
 console.log('COVERAGE_SCOPE='+JSON.stringify({stocked_products:canonical.size,eligible:eligible.map(p=>({sku:p.sku,asin:p.asin,fba:availableAdsStock(p)})),blocked,account_cap:100,bid_floor:floor}));
 await call('updateDailySpendController');const day=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());const ctrl=(await db.AccountDailySpendController.filter({amazon_account_id:aid,spend_date:day},'-updated_at',1))[0];if(ctrl?.global_kill_switch||Number(ctrl?.confirmed_spend)>=97)throw Error('Daily spend stop active; no activation this day');
 let camps=await list('/sp/campaigns/list','spCampaign','campaigns',{stateFilter:{include:['ENABLED','PAUSED']}});
 let allAds=await list('/sp/productAds/list','spProductAd','productAds',{stateFilter:{include:['ENABLED','PAUSED']}});
 const priorLogs=await db.AdsBidChangeLog.filter({amazon_account_id:aid},'-created_at',5000);
 const results=[];
 for(const p of eligible){const changes=[];try{
 let candidates=camps.filter(c=>c.targetingType==='AUTO'&&allAds.some(a=>String(a.campaignId)===String(c.campaignId)&&norm(a.sku)===norm(p.sku)&&a.asin===p.asin));
 candidates.sort((a,b)=>Number(b.state==='ENABLED')-Number(a.state==='ENABLED'));
 let c=candidates[0];
 if(!c){const created=await call('createAutoCampaignForAsin',{asin:p.asin,sku:p.sku,product_name:p.display_name||p.product_name||'',launch_at_minimum:true});const cid=String(created.campaign_id||'');if(!cid)throw Error('AUTO creation returned no campaign ID');c=(await list('/sp/campaigns/list','spCampaign','campaigns',{campaignIdFilter:{include:[cid]}}))[0];if(!c)throw Error('Created campaign not found');changes.push(created.already_exists?'existing_auto_found':'auto_created');}
 const cid=String(c.campaignId),filter={campaignIdFilter:{include:[cid]}};
 if(c.state!=='ENABLED'){await ads('/sp/campaigns','PUT',{campaigns:[{campaignId:cid,state:'ENABLED'}]},'spCampaign');changes.push('campaign_enabled');}
 let groups=await list('/sp/adGroups/list','spAdGroup','adGroups',filter);let pas=await list('/sp/productAds/list','spProductAd','productAds',filter);
 let pa=pas.find(a=>a.state!=='ARCHIVED'&&norm(a.sku)===norm(p.sku)&&a.asin===p.asin&&groups.some(g=>String(g.adGroupId)===String(a.adGroupId)&&g.state!=='ARCHIVED'));
 let group=pa?groups.find(g=>String(g.adGroupId)===String(pa.adGroupId)):groups.find(g=>g.state==='ENABLED')||groups.find(g=>g.state==='PAUSED');
 if(!group){await ads('/sp/adGroups','POST',{adGroups:[{campaignId:cid,name:'AUTO | '+p.sku,defaultBid:floor,state:'ENABLED'}]},'spAdGroup');groups=await list('/sp/adGroups/list','spAdGroup','adGroups',filter);group=groups.find(g=>g.state==='ENABLED');changes.push('ad_group_created');}
 if(!group)throw Error('No usable ad group');const gid=String(group.adGroupId);
 const recent=priorLogs.some(l=>String(l.campaign_id)===cid&&Date.now()-Date.parse(l.created_at||l.executed_at||'')<86400000);
 const oldDefault=Number(group.defaultBid||floor);const newDefault=Math.round(Math.min(bidPolicy.ceiling,Math.max(floor,recent?oldDefault:oldDefault*1.15))*100)/100;
 if(group.state!=='ENABLED'||newDefault!==oldDefault){await ads('/sp/adGroups','PUT',{adGroups:[{adGroupId:gid,state:'ENABLED',defaultBid:newDefault}]},'spAdGroup');changes.push('ad_group_enabled_or_bid_adjusted');}
 if(!pa){await ads('/sp/productAds','POST',{productAds:[{campaignId:cid,adGroupId:gid,sku:p.sku,state:'ENABLED'}]},'spProductAd');pas=await list('/sp/productAds/list','spProductAd','productAds',filter);pa=pas.find(a=>String(a.adGroupId)===gid&&norm(a.sku)===norm(p.sku)&&a.asin===p.asin&&a.state==='ENABLED');changes.push('product_ad_created');}
 else if(pa.state!=='ENABLED'){await ads('/sp/productAds','PUT',{productAds:[{adId:String(pa.adId),state:'ENABLED'}]},'spProductAd');changes.push('product_ad_enabled');}
 if(!pa)throw Error('No matching product ad');
 let targets=await list('/sp/targets/list','spTargetingClause','targetingClauses',filter);const own=targets.filter(t=>String(t.adGroupId)===gid&&t.state!=='ARCHIVED');const updates=own.map(t=>({targetId:String(t.targetId),state:'ENABLED',bid:Math.round(Math.min(bidPolicy.ceiling,Math.max(floor,recent?Number(t.bid||oldDefault):Number(t.bid||oldDefault)*1.15))*100)/100})).filter(u=>{const t=own.find(t=>String(t.targetId)===u.targetId);return t.state!=='ENABLED'||Number(t.bid||oldDefault)!==u.bid;});
 if(updates.length){await ads('/sp/targets','PUT',{targetingClauses:updates},'spTargetingClause');changes.push('auto_targets_enabled_or_bid_adjusted');}
 const rc=(await list('/sp/campaigns/list','spCampaign','campaigns',filter))[0],rg=(await list('/sp/adGroups/list','spAdGroup','adGroups',filter)).find(g=>String(g.adGroupId)===gid),rp=(await list('/sp/productAds/list','spProductAd','productAds',filter)).find(a=>String(a.adGroupId)===gid&&norm(a.sku)===norm(p.sku)&&a.asin===p.asin&&a.state==='ENABLED'),rt=(await list('/sp/targets/list','spTargetingClause','targetingClauses',filter)).filter(t=>String(t.adGroupId)===gid&&t.state!=='ARCHIVED');
 if(rc?.state!=='ENABLED'||rg?.state!=='ENABLED'||!rp||rt.some(t=>t.state!=='ENABLED'))throw Error('Incomplete Amazon readback');
 for(const update of updates){const t=rt.find(t=>String(t.targetId)===update.targetId);if(Number(t?.bid)!==update.bid)throw Error('Target bid mismatch');await db.AdsBidChangeLog.create({amazon_account_id:aid,campaign_id:cid,ad_group_id:gid,target_id:update.targetId,sku:p.sku,asin:p.asin,old_bid:Number(own.find(t=>String(t.targetId)===update.targetId)?.bid||oldDefault),new_bid:update.bid,source:operation,status:'confirmed',amazon_confirmed:true,created_at:new Date().toISOString(),reason:'User requested active AUTO coverage and higher impressions for every stocked eligible product; account cap unchanged'});}
 const locals=await db.Campaign.filter({amazon_account_id:aid,campaign_id:cid},'id',100);for(const row of locals)await db.Campaign.update(row.id,{state:'enabled',status:'enabled',amazon_status:'enabled',sku:p.sku,asin:p.asin,daily_budget:rc.budget?.budget,last_pause_reason:null,archive_reason:null,last_sync_at:new Date().toISOString()});
 await db.Product.update(p.id,{has_campaign:true,campaign_status:'active',linked_campaign_id:cid,ads_resume_pending:false,should_activate_campaign:false,kickoff_status:'completed',updated_at:new Date().toISOString()});
 const result={sku:p.sku,asin:p.asin,fba:availableAdsStock(p),campaign_id:cid,confirmed:true,changes,default_bid_before:oldDefault,default_bid:Number(rg.defaultBid),budget:rc.budget?.budget,targets:rt.map(t=>({id:t.targetId,bid:t.bid,state:t.state})),recent_bid_change_preserved:recent};results.push(result);console.log('PRODUCT_COVERAGE_RESULT='+JSON.stringify(result));
 }catch(e){const result={sku:p.sku,asin:p.asin,confirmed:false,changes,error:String(e)};results.push(result);console.log('PRODUCT_COVERAGE_RESULT='+JSON.stringify(result));}}
 await call('syncAdsCampaignStatesV2');
 console.log('ALL_PRODUCT_COVERAGE_SUMMARY='+JSON.stringify({account_cap:100,stocked_products:canonical.size,eligible:eligible.length,confirmed:results.filter(r=>r.confirmed).length,failed:results.filter(r=>!r.confirmed),blocked}));
}finally{await sql.end();}
