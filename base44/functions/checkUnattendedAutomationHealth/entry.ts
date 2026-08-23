import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

const s=(v:unknown)=>String(v||'').trim();
const low=(v:unknown)=>s(v).toLowerCase();

Deno.serve(async(request)=>{
  try{
    const base44:any=createClientFromRequest(request) as any;
    const body:any=await request.json().catch(()=>({}));
    if(!body._service_role){
      const ok=await base44.auth.isAuthenticated().catch(()=>false);
      if(!ok)return Response.json({ok:false,error:'Não autorizado'},{status:401});
    }

    const accounts=body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({id:body.amazon_account_id},undefined,1).catch(()=>[])
      : await base44.asServiceRole.entities.AmazonAccount.filter({status:'connected'},'-updated_at',1).catch(()=>[]);
    const account=accounts[0];
    const aid=account?.id||null;

    const aiProvider=Deno.env.get('OPENAI_API_KEY')?'OpenAI':Deno.env.get('ANTHROPIC_API_KEY')?'Anthropic':null;
    const adsConfigured=Boolean(Deno.env.get('ADS_CLIENT_ID')&&Deno.env.get('ADS_CLIENT_SECRET')&&Deno.env.get('ADS_REFRESH_TOKEN'));
    const spConfigured=Boolean(
      (Deno.env.get('SP_CLIENT_ID')&&Deno.env.get('SP_CLIENT_SECRET')&&Deno.env.get('SP_REFRESH_TOKEN'))||
      (Deno.env.get('AMAZON_LWA_CLIENT_ID')&&Deno.env.get('AMAZON_LWA_CLIENT_SECRET')&&Deno.env.get('AMAZON_SP_REFRESH_TOKEN'))
    );
    const schedulerEnabled=(Deno.env.get('ENABLE_SCHEDULER')??'true')!=='false';

    const since=new Date(Date.now()-45*60_000).toISOString();
    const logs=aid
      ? await base44.asServiceRole.entities.SyncExecutionLog.filter({amazon_account_id:aid,created_at:{$gte:since}},'-created_at',500).catch(()=>[])
      : [];
    const text=logs.map((r:any)=>`${low(r.operation)} ${low(r.trigger_type)} ${low(r.result_summary)}`).join('\n');
    const recent={
      ads_sync:/intraday|campaign state|ads.*sync|amazon.*ads/.test(text),
      decision_cycle:/canonical.*decision|decision.*cycle|unified.*decision/.test(text),
      executor:/execute.*decision|decision.*executor|execution/.test(text),
      confirmation:/confirm.*decision|confirmation|amazon.*confirm/.test(text),
      gpt:/gpt|weekly.*review|ai.*review/.test(text),
    };

    const hardConfigured=Boolean(aid&&aiProvider&&adsConfigured&&schedulerEnabled);
    const operational=hardConfigured&&recent.decision_cycle&&recent.ads_sync;
    const status=operational?'success':'warning';
    const summary=`unattended=${operational}; scheduler=${schedulerEnabled}; ai=${aiProvider||'missing'}; ads_credentials=${adsConfigured}; sp_credentials=${spConfigured}; recent_ads_sync=${recent.ads_sync}; recent_cycle=${recent.decision_cycle}; recent_executor=${recent.executor}; recent_confirmation=${recent.confirmation}; recent_gpt=${recent.gpt}`;

    if(aid){
      await base44.asServiceRole.entities.SyncExecutionLog.create({
        amazon_account_id:aid,
        operation:'unattended_automation_watchdog',
        trigger_type:body.trigger_type||'scheduler_unattended_watchdog',
        status,
        records_processed:logs.length,
        result_summary:summary,
        started_at:new Date().toISOString(),
        completed_at:new Date().toISOString(),
      }).catch(()=>{});
    }

    return Response.json({
      ok:operational,
      unattended_operation:true,
      user_session_required:false,
      service_role:true,
      scheduler_enabled:schedulerEnabled,
      connected_account:Boolean(aid),
      ai:{configured:Boolean(aiProvider),provider:aiProvider},
      amazon_ads:{configured:adsConfigured},
      sp_api:{configured:spConfigured},
      recent,
      lookback_minutes:45,
      summary,
    },{status:operational?200:503});
  }catch(error:any){
    return Response.json({ok:false,error:error?.message||String(error)},{status:500});
  }
});
