import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const wait=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function ads(b:any,a:string,o:string,m:string,p:string,payload:any,t:string){const r=await b.asServiceRole.functions.invoke('amazonAdsCommand',{amazon_account_id:a,operation:o,method:m,path:p,payload,content_type:t,accept:t,_service_role:true});return r?.data||r||{};}
function list(r:any,k:string){const p=r?.payload||r||{};return Array.isArray(p?.[k])?p[k]:Array.isArray(p)?p:[];}
function id(r:any,g:string,f:string){const p=r?.payload||r||{};return p?.[g]?.success?.[0]?.[f]||p?.success?.[0]?.[f]||p?.[g]?.[0]?.[f]||null;}

Deno.serve(async(req)=>{try{
 const b=createClientFromRequest(req),x=await req.json().catch(()=>({}));if(!x._service_role||!x.amazon_account_id||!x.asin)return Response.json({ok:false,error:'Parâmetros inválidos'},{status:400});
 const accountId=x.amazon_account_id,asin=String(x.asin),products=await b.asServiceRole.entities.Product.filter({amazon_account_id:accountId,asin},'-updated_at',1).catch(()=>[]),product=products[0]||{};
 const cr=await ads(b,accountId,'listManualCampaignsIntegrity','POST','/sp/campaigns/list',{stateFilter:{include:['ENABLED','PAUSED']},targetingTypeFilter:['MANUAL'],maxResults:500},'application/vnd.spCampaign.v3+json');
 if(!cr?.ok)return Response.json({ok:false,error:cr?.errors?.[0]?.message||'Falha ao listar campanhas'});
 const results=[];
 for(const c of list(cr,'campaigns').filter((v:any)=>String(v.name||'').includes(asin))){const campaignId=String(c.campaignId),gr=await ads(b,accountId,'listExactGroupsIntegrity','POST','/sp/adGroups/list',{campaignIdFilter:[campaignId],stateFilter:{include:['ENABLED','PAUSED']},maxResults:100},'application/vnd.spAdGroup.v3+json');if(!gr?.ok)continue;
  for(const g of list(gr,'adGroups').filter((v:any)=>String(v.name||'').includes('EXACT'))){const adGroupId=String(g.adGroupId),item:any={campaign_id:campaignId,ad_group_id:adGroupId,asin,added_keywords:[],product_ad_created:false};
   const par=await ads(b,accountId,'listExactProductAdsIntegrity','POST','/sp/productAds/list',{campaignIdFilter:[campaignId],adGroupIdFilter:[adGroupId],stateFilter:{include:['ENABLED','PAUSED','ARCHIVED']},maxResults:100},'application/vnd.spProductAd.v3+json');
   let activeAds=list(par,'productAds').filter((v:any)=>String(v.state||'').toUpperCase()==='ENABLED');
   if(!activeAds.length){const created=await ads(b,accountId,'createExactProductAdIntegrity','POST','/sp/productAds',{productAds:[{campaignId,adGroupId,...(product?.sku?{sku:product.sku}:{asin}),state:'ENABLED'}]},'application/vnd.spProductAd.v3+json');if(!created?.ok&&created?.status!==207){item.ok=false;item.error=created?.errors?.[0]?.message||'Falha ao criar anúncio';results.push(item);continue;}item.product_ad_created=true;item.product_ad_id=id(created,'productAds','adId');await wait(14000);}
   const kr=await ads(b,accountId,'listExactKeywordsIntegrity','POST','/sp/keywords/list',{campaignIdFilter:[campaignId],adGroupIdFilter:[adGroupId],stateFilter:{include:['ENABLED','PAUSED','ARCHIVED']},matchTypeFilter:['EXACT'],maxResults:100},'application/vnd.spKeyword.v3+json');
   let activeKw=list(kr,'keywords').filter((v:any)=>String(v.state||'').toUpperCase()==='ENABLED');
   if(!activeKw.length){const terms=await b.asServiceRole.entities.TermBank.filter({amazon_account_id:accountId,asin},'-performance_score',10).catch(()=>[]);const candidates=terms.map((t:any)=>String(t.term||'').trim()).filter(Boolean).slice(0,4);if(!candidates.length)candidates.push(String(product?.product_name||product?.display_name||asin).slice(0,80));for(const keyword of candidates){const created=await ads(b,accountId,'createExactKeywordIntegrity','POST','/sp/keywords',{keywords:[{campaignId,adGroupId,keywordText:keyword,matchType:'EXACT',state:'ENABLED',bid:{value:0.5,bidType:'DEFAULT'}}]},'application/vnd.spKeyword.v3+json');if(created?.ok||id(created,'keywords','keywordId'))item.added_keywords.push(keyword);await wait(14000);}}
   const vk=await ads(b,accountId,'verifyExactKeywordsIntegrity','POST','/sp/keywords/list',{campaignIdFilter:[campaignId],adGroupIdFilter:[adGroupId],stateFilter:{include:['ENABLED']},matchTypeFilter:['EXACT'],maxResults:100},'application/vnd.spKeyword.v3+json');
   const va=await ads(b,accountId,'verifyExactProductAdsIntegrity','POST','/sp/productAds/list',{campaignIdFilter:[campaignId],adGroupIdFilter:[adGroupId],stateFilter:{include:['ENABLED']},maxResults:100},'application/vnd.spProductAd.v3+json');
   activeKw=list(vk,'keywords').filter((v:any)=>String(v.state||'').toUpperCase()==='ENABLED');activeAds=list(va,'productAds').filter((v:any)=>String(v.state||'').toUpperCase()==='ENABLED');item.active_keywords=activeKw.length;item.active_product_ads=activeAds.length;item.ok=activeKw.length>0&&activeAds.length>0;item.complete=item.ok;
   const local=await b.asServiceRole.entities.Campaign.filter({amazon_account_id:accountId,campaign_id:campaignId},'-updated_at',1).catch(()=>[]);if(local[0])await b.asServiceRole.entities.Campaign.update(local[0].id,{completion_status:item.ok?'complete':'incomplete',is_incomplete:!item.ok,keyword_count:activeKw.length,product_ad_count:activeAds.length,last_repair_error:item.ok?null:'Grupo EXACT sem keyword ativa ou anúncio ativo'}).catch(()=>{});results.push(item);await wait(14000);
  }
 }
 return Response.json({ok:results.every((r:any)=>r.ok),asin,checked:results.length,complete:results.filter((r:any)=>r.ok).length,incomplete:results.filter((r:any)=>!r.ok).length,results});
}catch(e){return Response.json({ok:false,error:e?.message||'Erro no reparo de integridade EXACT'},{status:500});}});
