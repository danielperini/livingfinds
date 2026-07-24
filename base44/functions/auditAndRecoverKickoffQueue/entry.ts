import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';

const STALE_PROCESSING_MS = 30 * 60 * 1000;
const MAX_ATTEMPTS = 5;

function normalize(value:any){return String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim().replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ')}
function quantity(product:any){return Number(product?.fba_inventory??product?.available_quantity??product?.fulfillable_quantity??product?.stock??0)}
function isActive(value:any){return ['enabled','active'].includes(String(value||'').toLowerCase())}
function key(item:any){return `${item.amazon_account_id}|${item.asin}|${item.mode||''}|${normalize(item.keyword||'')}`}
function campaignAsin(campaign:any){return String(campaign?.asin||campaign?.advertised_asin||'')}
function campaignId(campaign:any){return String(campaign?.campaign_id||campaign?.amazon_campaign_id||'')}
function keywordText(keyword:any){return normalize(keyword?.keyword_text||keyword?.keyword||'')}
function keywordCampaignId(keyword:any){return String(keyword?.campaign_id||keyword?.amazon_campaign_id||'')}

Deno.serve(async(request)=>{
  try{
    const base44=createClientFromRequest(request);
    const body=await request.json().catch(()=>({}));
    const authenticated=await base44.auth.isAuthenticated().catch(()=>false);
    if(!authenticated&&!body._service_role)return Response.json({ok:false,error:'Não autorizado'},{status:401});

    const accountId=body.amazon_account_id||null;
    const recover=body.recover!==false;
    const [queue,products,campaigns,keywords]=await Promise.all([
      base44.asServiceRole.entities.ProductKickoffQueue.filter(accountId?{amazon_account_id:accountId}:{},'-created_at',5000).catch(()=>[]),
      base44.asServiceRole.entities.Product.filter(accountId?{amazon_account_id:accountId}:{},'-updated_at',5000).catch(()=>[]),
      base44.asServiceRole.entities.Campaign.filter(accountId?{amazon_account_id:accountId}:{},'-updated_at',10000).catch(()=>[]),
      base44.asServiceRole.entities.Keyword.filter(accountId?{amazon_account_id:accountId}:{},'-updated_at',20000).catch(()=>[]),
    ]);

    const productMap=new Map(products.map((product:any)=>[`${product.amazon_account_id}|${product.asin}`,product]));
    const campaignsByAsin=new Map<string,any[]>();
    for(const campaign of campaigns){
      const asin=campaignAsin(campaign);if(!asin)continue;
      const mapKey=`${campaign.amazon_account_id}|${asin}`;
      if(!campaignsByAsin.has(mapKey))campaignsByAsin.set(mapKey,[]);
      campaignsByAsin.get(mapKey)!.push(campaign);
    }
    const keywordsByCampaign=new Map<string,any[]>();
    for(const keyword of keywords){const id=keywordCampaignId(keyword);if(!id)continue;if(!keywordsByCampaign.has(id))keywordsByCampaign.set(id,[]);keywordsByCampaign.get(id)!.push(keyword)}

    const seen=new Map<string,any>();
    const report:any[]=[];
    let recovered=0;let waitingStock=0;let completedConfirmed=0;let staleUnlocked=0;let duplicates=0;let blocked=0;

    for(const item of [...queue].sort((a:any,b:any)=>new Date(a.created_at||a.created_date||0).getTime()-new Date(b.created_at||b.created_date||0).getTime())){
      const canonicalKey=key(item);
      const duplicateOf=seen.get(canonicalKey);
      if(duplicateOf&&item.status!=='completed'){
        duplicates++;
        if(recover)await base44.asServiceRole.entities.ProductKickoffQueue.update(item.id,{status:'cancelled',last_error:`Duplicidade da fila: ${duplicateOf.id}`,completed_at:new Date().toISOString(),started_at:null}).catch(()=>{});
        report.push({id:item.id,asin:item.asin,keyword:item.keyword||null,status:'duplicate_cancelled',duplicate_of:duplicateOf.id});
        continue;
      }
      seen.set(canonicalKey,item);

      const product=productMap.get(`${item.amazon_account_id}|${item.asin}`);
      const stock=quantity(product);
      const scope=product?.ads_scope_status||'not_authorized';
      const eligibility=product?.ads_eligibility_status||'unknown';
      const asinCampaigns=campaignsByAsin.get(`${item.amazon_account_id}|${item.asin}`)||[];
      const activeCampaigns=asinCampaigns.filter((campaign:any)=>isActive(campaign.state||campaign.status));
      const term=normalize(item.keyword||'');
      const exactExists=term?activeCampaigns.some((campaign:any)=>(keywordsByCampaign.get(campaignId(campaign))||[]).some((keyword:any)=>isActive(keyword.state||keyword.status)&&String(keyword.match_type||keyword.matchType||'').toLowerCase()==='exact'&&keywordText(keyword)===term)):false;
      const autoExists=activeCampaigns.some((campaign:any)=>String(campaign.targeting_type||campaign.targetingType||'').toLowerCase()==='auto'||normalize(campaign.name||campaign.campaign_name).startsWith('auto'));
      const implemented=item.mode==='manual_only'?exactExists:(autoExists&&activeCampaigns.length>0);

      if(implemented){
        completedConfirmed++;
        if(recover&&item.status!=='completed')await base44.asServiceRole.entities.ProductKickoffQueue.update(item.id,{status:'completed',completed_at:new Date().toISOString(),started_at:null,last_error:null,amazon_confirmed_at:new Date().toISOString()}).catch(()=>{});
        report.push({id:item.id,asin:item.asin,keyword:item.keyword||null,status:'implemented_confirmed',active_campaigns:activeCampaigns.length,exact_keyword_exists:exactExists,auto_exists:autoExists});
        continue;
      }

      if(!product||stock<=0||product.inventory_status==='out_of_stock'){
        waitingStock++;
        if(recover&&item.status!=='waiting_stock')await base44.asServiceRole.entities.ProductKickoffQueue.update(item.id,{status:'waiting_stock',scheduled_at:null,started_at:null,completed_at:null,last_error:'Aguardando estoque real da SP-API',waiting_stock_since:item.waiting_stock_since||new Date().toISOString(),stock_quantity_at_wait:stock}).catch(()=>{});
        report.push({id:item.id,asin:item.asin,keyword:item.keyword||null,status:'waiting_stock',stock});
        continue;
      }

      if(scope!=='authorized'||eligibility!=='eligible'){
        blocked++;
        if(recover)await base44.asServiceRole.entities.ProductKickoffQueue.update(item.id,{status:'cancelled',scheduled_at:null,started_at:null,last_error:`Kick-off bloqueado: scope=${scope}, eligibility=${eligibility}`}).catch(()=>{});
        report.push({id:item.id,asin:item.asin,keyword:item.keyword||null,status:'blocked_scope',scope,eligibility});
        continue;
      }

      const attempts=Number(item.attempt_count||0);
      const startedAt=new Date(item.started_at||item.updated_at||item.created_at||0).getTime();
      const stale=item.status==='processing'&&(!startedAt||Date.now()-startedAt>STALE_PROCESSING_MS);
      if(stale){staleUnlocked++}

      if(attempts>=MAX_ATTEMPTS&&item.status==='failed'){
        report.push({id:item.id,asin:item.asin,keyword:item.keyword||null,status:'max_attempts',attempts,last_error:item.last_error||null});
        continue;
      }

      if(recover&&['scheduled','failed','processing'].includes(String(item.status||''))){
        await base44.asServiceRole.entities.ProductKickoffQueue.update(item.id,{
          status:'scheduled',queue_hour:16,queue_window:'16:00-18:00',scheduled_at:new Date().toISOString(),started_at:null,completed_at:null,last_error:stale?'Lock antigo liberado e reagendado para a janela 16:00-18:00':item.last_error||null,
        }).catch(()=>{});
        recovered++;
      }
      report.push({id:item.id,asin:item.asin,keyword:item.keyword||null,status:'scheduled_recovered',previous_status:item.status,attempts,legacy_window:item.queue_window||null,stock});
    }

    if(recover&&recovered>0){
      await base44.asServiceRole.functions.invoke('processProductKickoffQueueV2',{amazon_account_id:accountId,force:true,batch_size:10,_service_role:true}).catch(()=>null);
    }

    return Response.json({
      ok:true,
      scanned:queue.length,
      implemented_confirmed:completedConfirmed,
      recovered,
      waiting_stock:waitingStock,
      blocked,
      duplicates_cancelled:duplicates,
      stale_processing_unlocked:staleUnlocked,
      execution_dispatched:recover&&recovered>0,
      canonical_window:'16:00-18:00 America/Sao_Paulo',
      results:report,
    });
  }catch(error:any){return Response.json({ok:false,error:error?.message||'Falha ao auditar fila de Kick-off',previous_data_preserved:true},{status:500})}
});
