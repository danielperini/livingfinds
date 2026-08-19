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
    const cycleStartedAt=new Date().toISOString();
    const common={...body,_service_role:true,correlation_id:correlationId};

    const economicEvidence=await invoke(base44,'runEconomicEvidenceDecisionPolicy',{
      ...common,
      dry_run:body.dry_run===true,
      trigger_type:body.trigger_type||'canonical_decision_cycle',
      max_candidates:body.max_economic_evidence_candidates??100,
    });

    const engine=await invoke(base44,'runUnifiedDecisionEngine',{
      ...common,
      economic_evidence_policy_run:economicEvidence,
      _canonical_orchestrator:'runCanonicalDecisionCycle',
    });

    const reconciliation=body.dry_run===true
      ? {ok:true,skipped:true,reason:'dry_run'}
      : await invoke(base44,'reconcileEconomicEvidenceDecisions',{
          amazon_account_id:body.amazon_account_id||null,
          _service_role:true,
          since:cycleStartedAt,
          correlation_id:correlationId,
          trigger_type:'canonical_pre_execution_reconciliation',
        });

    // O árbitro é o último gate antes da fila executável. Todas as regras podem
    // propor; somente uma mutação líquida por entidade permanece aprovada.
    const arbitration=body.dry_run===true
      ? {ok:true,skipped:true,reason:'dry_run'}
      : await invoke(base44,'arbitrateCanonicalDecisionConflicts',{
          amazon_account_id:body.amazon_account_id||null,
          _service_role:true,
          since:cycleStartedAt,
          correlation_id:correlationId,
          trigger_type:'canonical_pre_execution_arbitration',
        });

    return Response.json({
      ok:economicEvidence?.ok!==false&&engine?.ok!==false&&reconciliation?.ok!==false&&arbitration?.ok!==false,
      engine:'canonical-decision-cycle',
      engine_version:'canonical-v22-pre-execution-arbiter',
      correlation_id:correlationId,
      economic_evidence:economicEvidence,
      unified_engine:engine,
      pre_execution_reconciliation:reconciliation,
      pre_execution_arbitration:arbitration,
      execution_owner:'executeApprovedDecisionQueue',
      confirmation_owner:'confirmExecutedDecisions',
      duplicate_executor:false,
      decision_contract:'all proposals -> economic evidence -> canonical arbiter -> one net mutation per entity -> canonical queue -> Amazon confirmation',
    });
  }catch(error:any){return Response.json({ok:false,error:error?.message||String(error)},{status:500})}
});
