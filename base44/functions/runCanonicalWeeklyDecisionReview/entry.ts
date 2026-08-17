import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

const invoke=async(base44:any,name:string,payload:Record<string,unknown>)=>{
  try{const r=await base44.asServiceRole.functions.invoke(name,payload);return r?.data||r||{ok:true};}
  catch(error:any){return {ok:false,error:error?.response?.data?.error||error?.message||String(error)}};
};

Deno.serve(async(request)=>{
  try{
    const base44=createClientFromRequest(request);
    const body=await request.json().catch(()=>({}));
    const authenticated=await base44.auth.isAuthenticated().catch(()=>false);
    if(!authenticated&&!body._service_role)return Response.json({ok:false,error:'Não autorizado'},{status:401});
    const correlationId=body.correlation_id||crypto.randomUUID();
    const economicEvidence=await invoke(base44,'runEconomicEvidenceDecisionPolicy',{
      amazon_account_id:body.amazon_account_id||null,
      _service_role:true,
      dry_run:false,
      weekly_review:true,
      max_candidates:500,
      correlation_id:correlationId,
      trigger_type:'weekly_gpt_economic_review',
    });
    const gptReview=await invoke(base44,'runWeeklyGptRuleReview',{
      ...body,
      _service_role:true,
      correlation_id:correlationId,
      economic_evidence_review:economicEvidence,
      trigger_type:body.trigger_type||'canonical_weekly_gpt_review',
    });
    return Response.json({
      ok:economicEvidence?.ok!==false&&gptReview?.ok!==false,
      review:'canonical-weekly-decision-review',
      correlation_id:correlationId,
      shared_economic_policy:'runEconomicEvidenceDecisionPolicy',
      same_policy_as_operational_cycle:true,
      economic_evidence:economicEvidence,
      gpt_review:gptReview,
      ai_provider:'OpenAI',
      manual_approval_required:false,
    });
  }catch(error:any){return Response.json({ok:false,error:error?.message||String(error)},{status:500})}
});
