import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const wait = (ms:number) => new Promise(r => setTimeout(r, ms));
const norm = (v:any) => String(v || '').toLowerCase().trim().replace(/\s+/g, ' ');

function hourBR(){
  const p = new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Sao_Paulo',hour:'2-digit',hour12:false}).formatToParts(new Date());
  return Number(p.find(x=>x.type==='hour')?.value || 0);
}
function inWindow(){ return [0,1,2,3,13].includes(hourBR()); }
function nextSlot(){
  const parts = new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hour12:false}).formatToParts(new Date());
  const p = Object.fromEntries(parts.map(x=>[x.type,x.value]));
  const h = Number(p.hour || 0), day = `${p.year}-${p.month}-${p.day}`;
  if(h<3){const n=h+1;return{hour:n,window:`${String(n).padStart(2,'0')}:00-${String(n+1).padStart(2,'0')}:00`,at:new Date(`${day}T${String(n).padStart(2,'0')}:00:00-03:00`)}};
  if(h<13)return{hour:13,window:'13:00-14:00',at:new Date(`${day}T13:00:00-03:00`)};
  const t=new Date(`${day}T12:00:00-03:00`);t.setDate(t.getDate()+1);
  const d=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(t);
  return{hour:0,window:'00:00-01:00',at:new Date(`${d}T00:00:00-03:00`)};
}
async function ads(b:any,accountId:string,operation:string,method:string,path:string,payload:any,type:string){
  const r=await b.asServiceRole.functions.invoke('amazonAdsCommand',{amazon_account_id:accountId,operation,method,path,payload,content_type:type,accept:type,_service_role:true});
  return r?.data||r||{};
}
function listOf(r:any,key:string){const p=r?.payload||r||{};return Array.isArray(p?.[key])?p[key]:Array.isArray(p)?p:[];}
function createdId(r:any){const p=r?.payload||r||{};return p?.keywords?.success?.[0]?.keywordId||p?.success?.[0]?.keywordId||p?.keywords?.[0]?.keywordId||null;}
async function enqueue(b:any,accountId:string,asin:string,campaignId?:string,adGroupId?:string){
  const s=nextSlot();
  const found=await b.asServiceRole.entities.KeywordRepairQueue.filter({amazon_account_id:accountId,asin,status:'scheduled'},'-created_date',1).catch(()=>[]);
  if(!found.length)await b.asServiceRole.entities.KeywordRepairQueue.create({amazon_account_id:accountId,asin,campaign_id:campaignId||null,ad_group_id:adGroupId||null,status:'scheduled',queue_hour:s.hour,queue_window:s.window,scheduled_at:s.at.toISOString(),attempt_count:0});
  return s;
}
async function candidates(b:any,accountId:string,asin:string,product:any){
  const out:any[]=[];
  const add=(text:any,source:string)=>{const value=String(text||'').trim();if(value&&value.length<=80&&!out.some(x=>norm(x.keyword)===norm(value)))out.push({keyword:value,source});};
  const terms=await b.asServiceRole.entities.TermBank.filter({amazon_account_id:accountId,asin},'-performance_score',100).catch(()=>[]);
  for(const t of terms){if(['negative','archived'].includes(String(t.status)))continue;if(Number(t.orders||0)>=1||t.classification==='winner'||t.status==='active')add(t.term, 'term_bank');if(out.length>=4)break;}
  if(out.length<4){const rows=await b.asServiceRole.entities.SearchTerm.filter({amazon_account_id:accountId,advertised_asin:asin},'-orders_14d',100).catch(()=>[]);for(const r of rows){if(Number(r.orders_7d||0)+Number(r.orders_14d||0)>0)add(r.search_term,'search_term');if(out.length>=4)break;}}
  if(out.length<1)add(product?.product_name||product?.display_name||asin,'product_title');
  return out.slice(0,4);
}

Deno.serve(async(req)=>{try{
  const b=createClientFromRequest(req),body=await req.json().catch(()=>({}));
  const auth=await b.auth.isAuthenticated().catch(()=>false);
  if(!auth&&!body._service_role)return Response.json({ok:false,error:'Não autorizado'},{status:401});
  const accountId=body.amazon_account_id;if(!accountId)return Response.json({ok:false,error:'amazon_account_id obrigatório'},{status:400});
  const asins=[...new Set((Array.isArray(body.asins)&&body.asins.length?body.asins:['B0GNW1Q6V3']).map((x:any)=>String(x).trim()).filter(Boolean))];
  if(!body._window_execution&&!inWindow()){
    const queued=[];for(const asin of asins){const s=await enqueue(b,accountId,asin);queued.push({asin,queue_window:s.window});}
    return Response.json({ok:true,scheduled:true,queued:queued.length,results:queued,message:'Reparo de palavras-chave programado para a próxima janela Amazon.'});
  }

  const campaignsResult=await ads(b,accountId,'listManualCampaignsForKeywordRepair','POST','/sp/campaigns/list',{stateFilter:['ENABLED','PAUSED'],targetingTypeFilter:['MANUAL'],maxResults:500},'application/vnd.spCampaign.v3+json');
  if(!campaignsResult?.ok)return Response.json({ok:false,error:campaignsResult?.errors?.[0]?.message||'Falha ao listar campanhas manuais'});
  const remote=listOf(campaignsResult,'campaigns');
  const products=await b.asServiceRole.entities.Product.filter({amazon_account_id:accountId},'-updated_at',5000).catch(()=>[]);
  const productMap=new Map(products.map((p:any)=>[String(p.asin),p]));
  const results:any[]=[];

  for(const asin of asins){
    const matches=remote.filter((c:any)=>String(c.name||'').includes(asin));
    for(const campaign of matches){
      const campaignId=String(campaign.campaignId);
      const groupsResult=await ads(b,accountId,'listExactAdGroupsForRepair','POST','/sp/adGroups/list',{campaignIdFilter:[campaignId],stateFilter:['ENABLED','PAUSED'],maxResults:100},'application/vnd.spAdGroup.v3+json');
      if(!groupsResult?.ok){results.push({asin,campaign_id:campaignId,ok:false,error:groupsResult?.errors?.[0]?.message||'Falha ao listar grupos'});continue;}
      const groups=listOf(groupsResult,'adGroups').filter((g:any)=>String(g.name||'').includes('EXACT'));
      for(const group of groups){
        const adGroupId=String(group.adGroupId), item:any={asin,campaign_id:campaignId,ad_group_id:adGroupId,ad_group_name:group.name,added:[]};
        const kwResult=await ads(b,accountId,'listExactKeywordsForRepair','POST','/sp/keywords/list',{campaignIdFilter:[campaignId],adGroupIdFilter:[adGroupId],stateFilter:['ENABLED','PAUSED','ARCHIVED'],matchTypeFilter:['EXACT'],maxResults:100},'application/vnd.spKeyword.v3+json');
        if(!kwResult?.ok){item.ok=false;item.error=kwResult?.errors?.[0]?.message||'Falha ao listar keywords';results.push(item);continue;}
        const existing=listOf(kwResult,'keywords');
        const active=existing.filter((k:any)=>String(k.state||'').toUpperCase()==='ENABLED');
        if(active.length){item.ok=true;item.complete=true;item.existing_keywords=active.length;results.push(item);continue;}
        const terms=await candidates(b,accountId,asin,productMap.get(asin)||{});
        for(const term of terms){
          const create=await ads(b,accountId,'createMissingExactKeyword','POST','/sp/keywords',{keywords:[{campaignId,adGroupId,keywordText:term.keyword,matchType:'EXACT',state:'ENABLED',bid:{value:0.5,bidType:'DEFAULT'}}]},'application/vnd.spKeyword.v3+json');
          const id=createdId(create);
          if(id||create?.ok){item.added.push({keyword:term.keyword,source:term.source,keyword_id:id||null});await b.asServiceRole.entities.Keyword.create({amazon_account_id:accountId,campaign_id:campaignId,ad_group_id:adGroupId,keyword_id:id?String(id):`kw_${Date.now()}`,asin,keyword_text:term.keyword,keyword:term.keyword,match_type:'exact',state:'enabled',status:'enabled',current_bid:0.5,bid:0.5,source:'repair_exact_group',first_seen_at:new Date().toISOString(),last_seen_at:new Date().toISOString(),synced_at:new Date().toISOString()}).catch(()=>{});} 
          await wait(14000);
        }
        const verify=await ads(b,accountId,'verifyExactKeywordsAfterRepair','POST','/sp/keywords/list',{campaignIdFilter:[campaignId],adGroupIdFilter:[adGroupId],stateFilter:['ENABLED'],matchTypeFilter:['EXACT'],maxResults:100},'application/vnd.spKeyword.v3+json');
        const verified=listOf(verify,'keywords').filter((k:any)=>String(k.state||'').toUpperCase()==='ENABLED');
        item.ok=verified.length>0;item.complete=item.ok;item.active_keywords=verified.length;
        const local=await b.asServiceRole.entities.Campaign.filter({amazon_account_id:accountId,campaign_id:campaignId},'-updated_at',1).catch(()=>[]);
        if(local[0])await b.asServiceRole.entities.Campaign.update(local[0].id,{completion_status:item.ok?'complete':'incomplete',is_incomplete:!item.ok,keyword_count:verified.length,last_keyword_repair_at:new Date().toISOString(),last_repair_error:item.ok?null:'Grupo EXACT sem keyword ativa'}).catch(()=>{});
        if(!item.ok){const s=await enqueue(b,accountId,asin,campaignId,adGroupId);item.retry_scheduled=true;item.queue_window=s.window;}
        results.push(item);await wait(14000);
      }
    }
  }
  return Response.json({ok:results.every(x=>x.ok),checked:results.length,repaired:results.filter(x=>x.added?.length).length,complete:results.filter(x=>x.complete).length,incomplete:results.filter(x=>!x.complete).length,spacing_seconds:14,results});
}catch(e){return Response.json({ok:false,error:e?.message||'Erro ao reparar grupos EXACT'},{status:500});}});