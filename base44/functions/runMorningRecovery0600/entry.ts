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

    const nowIso = new Date().toISOString();
    const todayBRT = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
    const yesterdayBRT = new Date(Date.now() - 3 * 3600000 - 86400000).toISOString().slice(0, 10);

    const allResults=[];
    for(const account of accounts){
      const result:any={amazon_account_id:account.id,stock_reactivated:0,failed_decisions:0,kickoffs:0,auto_repairs:0,keyword_repairs:0,suggestions:0,recovered:0,failed:0,kill_switch_recovered:0,details:[]};

      // PRIORIDADE 0: Recuperação do Kill Switch do dia anterior
      try{
        const prevControllers = await base44.asServiceRole.entities.AccountDailySpendController.filter(
          {amazon_account_id:account.id, spend_date:yesterdayBRT}, null, 1
        ).catch(()=>[]);
        const prevCtrl = prevControllers[0];

        if(prevCtrl?.global_kill_switch === true){
          const pausedIds: string[] = Array.isArray(prevCtrl.campaigns_paused_today) ? prevCtrl.campaigns_paused_today : [];

          if(pausedIds.length > 0){
            // Reativar via Amazon Ads API
            for(let i=0; i<pausedIds.length; i+=20){
              const batch = pausedIds.slice(i, i+20).map((id:string)=>({campaignId:String(id), state:'ENABLED'}));
              await base44.asServiceRole.functions.invoke('amazonAdsCommand',{
                _service_role:true,
                amazon_account_id:account.id,
                path:'/sp/campaigns',
                method:'PUT',
                content_type:'application/vnd.spCampaign.v3+json',
                payload:{campaigns:batch},
              }).catch(()=>{});
              // Atualizar estado local
              for(const campId of pausedIds.slice(i, i+20)){
                const cList = await base44.asServiceRole.entities.Campaign.filter(
                  {amazon_account_id:account.id, campaign_id:campId}, null, 1
                ).catch(()=>[]);
                const cAlt = cList[0] ? [] : await base44.asServiceRole.entities.Campaign.filter(
                  {amazon_account_id:account.id, amazon_campaign_id:campId}, null, 1
                ).catch(()=>[]);
                const camp = cList[0] || cAlt[0];
                if(camp) {
                  await base44.asServiceRole.entities.Campaign.update(camp.id,{
                    status:'enabled', state:'enabled', archive_reason:null, last_pause_reason:null,
                  }).catch(()=>{});
                }
              }
              await wait(300);
            }
            result.kill_switch_recovered = pausedIds.length;
          }

          // Criar controller do dia atual com kill_switch=false
          const perfList = await base44.asServiceRole.entities.PerformanceSettings.filter(
            {amazon_account_id:account.id}, '-updated_at', 1
          ).catch(()=>[]);
          const newCap = Number(perfList[0]?.daily_budget_limit || prevCtrl.effective_daily_spend_cap || 70);

          const todayCtrlList = await base44.asServiceRole.entities.AccountDailySpendController.filter(
            {amazon_account_id:account.id, spend_date:todayBRT}, null, 1
          ).catch(()=>[]);
          if(todayCtrlList[0]){
            await base44.asServiceRole.entities.AccountDailySpendController.update(todayCtrlList[0].id,{
              global_kill_switch:false, effective_daily_spend_cap:newCap, user_daily_spend_cap:newCap,
              confirmed_spend:0, remaining_spend:newCap, cap_status:'safe', updated_at:nowIso,
            }).catch(()=>{});
          } else {
            await base44.asServiceRole.entities.AccountDailySpendController.create({
              amazon_account_id:account.id, spend_date:todayBRT, global_kill_switch:false,
              effective_daily_spend_cap:newCap, user_daily_spend_cap:newCap,
              confirmed_spend:0, remaining_spend:newCap, cap_status:'safe',
              timezone:'America/Sao_Paulo', created_at:nowIso, updated_at:nowIso,
            }).catch(()=>{});
          }

          // Resolver alerta daily_cap_reached do dia anterior
          const capAlerts = await base44.asServiceRole.entities.Alert.filter(
            {amazon_account_id:account.id, alert_type:'daily_cap_reached', status:'active'}, '-created_at', 5
          ).catch(()=>[]);
          for(const a of capAlerts){
            await base44.asServiceRole.entities.Alert.update(a.id,{
              status:'resolved', resolved_at:nowIso, resolution_reason:'Novo dia iniciado — campanhas reativadas automaticamente',
            }).catch(()=>{});
          }

          result.details.push({type:'kill_switch_recovery', recovered:pausedIds.length, new_cap:newCap, ok:true});
        }
      }catch(e:any){
        result.details.push({type:'kill_switch_recovery', ok:false, error:e?.message||String(e)});
      }

      // PRIORIDADE 1: Reativar campanhas AUTO pausadas por estoque antes de qualquer outra tarefa
      try{
        const reactivateRes = await base44.asServiceRole.functions.invoke('reactivatePausedWithStock',{
          amazon_account_id:account.id,
          _service_role:true,
          targeting_type_filter:'AUTO',
          include_incomplete:true,
        });
        const rdata = reactivateRes?.data || reactivateRes || {};
        result.stock_reactivated = rdata.reactivated || 0;
        result.details.push({type:'stock_reactivation',reactivated:rdata.reactivated||0,skipped_no_stock:rdata.skipped_no_stock||0,ok:rdata.ok!==false});
      }catch(e:any){
        result.details.push({type:'stock_reactivation',ok:false,error:e?.message||String(e)});
      }

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