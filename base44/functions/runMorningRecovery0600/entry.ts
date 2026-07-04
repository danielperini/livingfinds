import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const wait = (ms:number) => new Promise((resolve) => setTimeout(resolve, ms));

function brazilTime(){
  const parts = new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(new Date());
  return Object.fromEntries(parts.map((part)=>[part.type,part.value]));
}

async function log(base44:any, accountId:string, startedAt:string, status:string, summary:any, error:string|null=null){
  await base44.asServiceRole.entities.SyncExecutionLog.create({
    amazon_account_id: accountId,
    operation: 'morning_recovery_0600',
    status,
    trigger_type: 'scheduled_0600',
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    records_processed: Number(summary?.processed || summary?.recovered || 0),
    result_summary: JSON.stringify(summary).slice(0,4000),
    error_message: error ? String(error).slice(0,1000) : null,
  }).catch(()=>{});
}

Deno.serve(async(request)=>{
  const startedAt = new Date().toISOString();
  try{
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(()=>({}));
    if(!body._service_role) return Response.json({ok:false,error:'Uso interno'},{status:403});

    const time = brazilTime();
    const withinSchedule = Number(time.hour) === 6 && Number(time.minute) < 40;
    if(!withinSchedule && body.force !== true){
      return Response.json({ok:true,skipped:true,reason:'Fora da janela de repescagem das 06:00',brazil_time:`${time.hour}:${time.minute}`});
    }

    const accounts = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({id:body.amazon_account_id})
      : await base44.asServiceRole.entities.AmazonAccount.filter({status:'connected'});

    const allResults=[];
    for(const account of accounts){
      const result:any={amazon_account_id:account.id,failed_decisions:0,kickoffs:0,auto_repairs:0,keyword_repairs:0,suggestions:0,recovered:0,failed:0,details:[]};

      const failedDecisions = await base44.asServiceRole.entities.OptimizationDecision.filter({amazon_account_id:account.id,status:'failed'},'-created_at',100).catch(()=>[]);
      for(const decision of failedDecisions){
        try{
          const response = await base44.asServiceRole.functions.invoke('executeAutopilotDecision',{decision_id:decision.id,_service_role:true});
          const data = response?.data || response || {};
          const ok = data?.ok !== false && (data?.executed > 0 || data?.results?.some((item:any)=>item.ok));
          result.failed_decisions++;
          ok ? result.recovered++ : result.failed++;
          result.details.push({type:'decision',id:decision.id,action:decision.action,ok});
        }catch(error){result.failed_decisions++;result.failed++;result.details.push({type:'decision',id:decision.id,ok:false,error:error?.message||String(error)});}
        await wait(30000);
      }

      const kickoffRows = await base44.asServiceRole.entities.ProductKickoffQueue.filter({amazon_account_id:account.id,status:'failed'},'-scheduled_at',50).catch(()=>[]);
      for(const item of kickoffRows){
        try{
          let response;
          if(item.mode==='manual_only'){
            response = await base44.asServiceRole.functions.invoke('createManualCampaignV2',{amazon_account_id:item.amazon_account_id,asin:item.asin,sku:item.sku||null,product_name:item.product_name||item.asin,keyword:item.keyword,bid:0.5,budget:5,_service_role:true});
          }else{
            response = await base44.asServiceRole.functions.invoke('autoKickoffProductV3',{amazon_account_id:item.amazon_account_id,asin:item.asin,sku:item.sku||null,product_name:item.product_name||item.asin,max_keywords:4,_window_execution:true,_service_role:true});
          }
          const data=response?.data||response||{};
          const ok=data?.ok===true && (item.mode==='manual_only' || data?.completion_status==='complete');
          await base44.asServiceRole.entities.ProductKickoffQueue.update(item.id,{status:ok?'completed':'failed',completed_at:ok?new Date().toISOString():null,last_error:ok?null:String(data?.error||data?.message||'Repescagem sem conclusão').slice(0,500)}).catch(()=>{});
          result.kickoffs++;ok?result.recovered++:result.failed++;result.details.push({type:'kickoff',id:item.id,asin:item.asin,ok});
        }catch(error){result.kickoffs++;result.failed++;result.details.push({type:'kickoff',id:item.id,asin:item.asin,ok:false,error:error?.message||String(error)});}
        await wait(30000);
      }

      const autoRows = await base44.asServiceRole.entities.AutoCampaignRepairQueue.filter({amazon_account_id:account.id,status:'failed'},'-scheduled_at',50).catch(()=>[]);
      for(const item of autoRows){
        try{
          const response=await base44.asServiceRole.functions.invoke('repairIncompleteAutoCampaigns',{amazon_account_id:account.id,asins:[item.asin],_window_execution:true,_service_role:true});
          const data=response?.data||response||{};
          const ok=data?.results?.some((row:any)=>row.asin===item.asin&&row.complete===true)===true;
          await base44.asServiceRole.entities.AutoCampaignRepairQueue.update(item.id,{status:ok?'completed':'failed',completed_at:ok?new Date().toISOString():null,last_error:ok?null:String(data?.error||data?.results?.[0]?.error||'AUTO ainda incompleta').slice(0,500)}).catch(()=>{});
          result.auto_repairs++;ok?result.recovered++:result.failed++;result.details.push({type:'auto_repair',id:item.id,asin:item.asin,ok});
        }catch(error){result.auto_repairs++;result.failed++;result.details.push({type:'auto_repair',id:item.id,asin:item.asin,ok:false,error:error?.message||String(error)});}
        await wait(30000);
      }

      const keywordRows = await base44.asServiceRole.entities.KeywordRepairQueue.filter({amazon_account_id:account.id,status:'failed'},'-scheduled_at',50).catch(()=>[]);
      for(const item of keywordRows){
        try{
          const response=await base44.asServiceRole.functions.invoke('repairExactAdGroupIntegrity',{amazon_account_id:account.id,asin:item.asin,_service_role:true});
          const data=response?.data||response||{};
          const ok=data?.results?.some((row:any)=>row.asin===item.asin&&row.complete===true)===true;
          await base44.asServiceRole.entities.KeywordRepairQueue.update(item.id,{status:ok?'completed':'failed',last_error:ok?null:String(data?.error||data?.results?.[0]?.error||'Grupo ainda incompleto').slice(0,500)}).catch(()=>{});
          result.keyword_repairs++;ok?result.recovered++:result.failed++;result.details.push({type:'keyword_repair',id:item.id,asin:item.asin,ok});
        }catch(error){result.keyword_repairs++;result.failed++;result.details.push({type:'keyword_repair',id:item.id,asin:item.asin,ok:false,error:error?.message||String(error)});}
        await wait(30000);
      }

      const suggestionRows = await base44.asServiceRole.entities.KeywordSuggestion.filter({amazon_account_id:account.id,queue_status:'failed'},'-approved_at',50).catch(()=>[]);
      for(const item of suggestionRows){
        try{
          const response=await base44.asServiceRole.functions.invoke('createManualCampaignFromKeywordSuggestionV2',{amazon_account_id:account.id,suggestion_ids:[item.id],_window_execution:true,_service_role:true});
          const data=response?.data||response||{};
          const ok=data?.results?.some((row:any)=>row.id===item.id&&row.ok)===true;
          result.suggestions++;ok?result.recovered++:result.failed++;result.details.push({type:'suggestion',id:item.id,ok});
        }catch(error){result.suggestions++;result.failed++;result.details.push({type:'suggestion',id:item.id,ok:false,error:error?.message||String(error)});}
        await wait(30000);
      }

      result.processed=result.failed_decisions+result.kickoffs+result.auto_repairs+result.keyword_repairs+result.suggestions;
      await log(base44,account.id,startedAt,result.failed===0?'success':'error',result,result.failed?`${result.failed} item(ns) permaneceram com erro`:null);
      allResults.push(result);
    }

    return Response.json({ok:allResults.every((item:any)=>item.failed===0),schedule:'06:00 America/Sao_Paulo',spacing_seconds:30,accounts_processed:allResults.length,results:allResults});
  }catch(error){
    return Response.json({ok:false,error:error?.message||'Erro na repescagem das 06:00',started_at:startedAt},{status:500});
  }
});
