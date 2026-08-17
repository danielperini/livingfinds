import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

const invoke = async (base44:any,name:string,payload:Record<string,unknown>) => {
  try { const r=await base44.asServiceRole.functions.invoke(name,payload); return r?.data||r||{ok:true}; }
  catch(error:any){ return {ok:false,error:error?.response?.data?.error||error?.message||String(error)}; }
};

Deno.serve(async(request)=>{
  try{
    const base44=createClientFromRequest(request);
    const body=await request.json().catch(()=>({}));
    const authenticated=await base44.auth.isAuthenticated().catch(()=>false);
    if(!authenticated&&!body._service_role)return Response.json({ok:false,error:'Não autorizado'},{status:401});
    const correlationId=body.correlation_id||crypto.randomUUID();
    const common={...body,_service_role:true,correlation_id:correlationId};

    // A mesma política econômica/evidência é a porta de entrada de toda avaliação.
    // Ela não executa Amazon: classifica zonas, confiança e alternativa contextual.
    const economicEvidence=await invoke(base44,'runEconomicEvidenceDecisionPolicy',{
      ...common,
      dry_run:body.dry_run===true,
      trigger_type:body.trigger_type||'canonical_decision_cycle',
      max_candidates:body.max_economic_evidence_candidates??100,
    });

    // O motor unificado continua sendo o único proprietário de decisões operacionais.
    const engine=await invoke(base44,'runUnifiedDecisionEngine',{
      ...common,
      economic_evidence_policy_run:economicEvidence,
      _canonical_orchestrator:'runCanonicalDecisionCycle',
    });

    return Response.json({
      ok:economicEvidence?.ok!==false&&engine?.ok!==false,
      engine:'canonical-decision-cycle',
      engine_version:'canonical-v21-economic-evidence',
      correlation_id:correlationId,
      economic_evidence:economicEvidence,
      unified_engine:engine,
      execution_owner:'executeApprovedDecisionQueue',
      confirmation_owner:'confirmExecutedDecisions',
      duplicate_executor:false,
    });
  }catch(error:any){return Response.json({ok:false,error:error?.message||String(error)},{status:500})}
});
