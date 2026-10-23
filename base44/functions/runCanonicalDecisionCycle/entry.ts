import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { collectUnconfirmedCycleStages, describeUnconfirmedCycleStage, resolveCanonicalCycleOutcome } from '../../shared/canonicalCyclePolicy.ts';

const invoke = async (base44:any,name:string,payload:Record<string,unknown>) => {
  try {
    const r=await base44.asServiceRole.functions.invoke(name,payload);
    const result=r?.data||r;
    return result && typeof result === 'object' ? result : {ok:false,error:'empty_or_invalid_stage_response'};
  }
  catch(error:any){ return {ok:false,error:error?.response?.data?.error||error?.message||String(error)}; }
};

function compactStage(stage: any) {
  if (!stage || typeof stage !== 'object') return stage;
  const keys = [
    'ok','reviewed','campaigns_reviewed','products_reviewed','decisions_created','created',
    'updated','blocked','warnings','errors','error','reason','skipped','proposed','executed',
    'candidates','count','records_processed','spend','sales','acos','roas','tacos','cpc','ctr',
    'conversion_rate','orders','clicks','impressions','failed_stages',
  ];
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const value = stage[key];
    if (typeof value === 'string') out[key] = value.slice(0, 400);
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) out[key] = value;
    else if (Array.isArray(value)) out[key] = value.slice(0, 8).map((item: any) =>
      typeof item === 'string' ? item.slice(0, 200) :
      (item && typeof item === 'object' ? Object.fromEntries(
        ['stage','account_id','action','status','reason','error','campaign_id','asin','count','spend','sales','acos','roas','tacos']
          .filter((name) => item[name] !== undefined)
          .map((name) => [name, typeof item[name] === 'string' ? item[name].slice(0, 200) : item[name]])
      ) : item));
  }
  return out;
}

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

    const connectedAccounts = body.amazon_account_id
      ? [{ id: body.amazon_account_id }]
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-updated_at', 100).catch(() => []);
    const aiReviewRuns = await Promise.all((connectedAccounts.length ? connectedAccounts : [{ id: null }]).map((account: any) =>
      invoke(base44, 'runCanonicalAIDecisionReview', {
        amazon_account_id: account?.id || null,
        effective_settings: body.effective_settings || null,
        economic_evidence: economicEvidence,
        data_freshness: body.data_freshness || null,
        ai_review_enabled: body.ai_review_enabled,
        dry_run: body.dry_run === true,
        _service_role: true,
        correlation_id: correlationId,
        trigger_type: body.trigger_type || 'canonical_decision_cycle',
      })));
    const aiReview = { ok: aiReviewRuns.every((run: any) => run?.ok !== false), proposal_only: true, runs: aiReviewRuns };

    const engine=await invoke(base44,'runUnifiedDecisionEngine',{
      ...common,
      economic_evidence_policy_run:economicEvidence,
      ai_review: aiReview,
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

    const stageResults: Record<string, any> = { economic_evidence: economicEvidence, unified_engine: engine, ai_review: aiReview, reconciliation, arbitration };
    const failedStageNames = collectUnconfirmedCycleStages(stageResults, ['economic_evidence', 'unified_engine', 'reconciliation', 'arbitration']);
    const failedStages = failedStageNames
      .map((stage) => describeUnconfirmedCycleStage(stage, stageResults[stage]));
    const shouldSupervise = body.daily_close === true || failedStages.length > 0;
    const supervision = shouldSupervise
      ? await invoke(base44, 'superviseV6SIA', {
          amazon_account_id: body.amazon_account_id || null,
          _service_role: true,
          supervision_type: failedStages.length > 0 ? 'execution_failure' : 'daily_portfolio',
          trigger_type: body.trigger_type || 'canonical_daily_review',
          correlation_id: correlationId,
          failures: failedStages,
          observations: {
            daily_close: body.daily_close === true,
            trigger_type: body.trigger_type || 'canonical_decision_cycle',
            economic_evidence: compactStage(economicEvidence),
            unified_engine: compactStage(engine),
            ai_review: compactStage(aiReview),
            reconciliation: compactStage(reconciliation),
            arbitration: compactStage(arbitration),
          },
        })
      : { ok: true, skipped: true, reason: 'no_daily_review_or_stage_failure' };

    const cycleOutcome = resolveCanonicalCycleOutcome(failedStageNames, shouldSupervise, supervision);
    const cycleOk = cycleOutcome.ok;
    const accountRows = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, undefined, 1).catch(() => [])
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-updated_at', 1).catch(() => []);
    const accountId = accountRows[0]?.id || body.amazon_account_id || null;
    if (accountId) {
      await base44.asServiceRole.entities.SyncExecutionLog.create({
        amazon_account_id: accountId,
        operation: 'v6sia_canonical_decision_cycle',
        trigger_type: String(body.trigger_type || 'canonical_decision_cycle').slice(0, 100),
      status: cycleOutcome.core_ok ? 'success' : 'warning',
        started_at: cycleStartedAt,
        completed_at: new Date().toISOString(),
        duration_ms: Date.now() - new Date(cycleStartedAt).getTime(),
        records_processed: 4,
      error_message: !cycleOutcome.core_ok ? JSON.stringify(failedStages).slice(0, 900) : null,
        result_summary: JSON.stringify({
          engine_version: 'V6SIA', correlation_id: correlationId,
          stages: Object.fromEntries(Object.entries(stageResults).map(([name, result]: [string, any]) => [name, result?.ok === false ? 'failed' : result?.skipped ? 'skipped' : 'ok'])),
          stage_failures: failedStages,
          supervision_status: supervision?.status || (supervision?.skipped ? 'skipped' : supervision?.ok === false ? 'failed' : 'ok'),
          supervision_ok: cycleOutcome.supervision_ok,
          cycle_partial: cycleOutcome.partial,
        }).slice(0, 1400),
      }).catch(() => {});
    }

    return Response.json({
      ok: cycleOutcome.ok,
      core_stages_ok: cycleOutcome.core_ok,
      supervision_ok: cycleOutcome.supervision_ok,
      partial: cycleOutcome.partial,
      engine:'canonical-decision-cycle',
      engine_version:'V6SIA',
      correlation_id:correlationId,
      economic_evidence:economicEvidence,
      unified_engine:engine,
      ai_review: aiReview,
      pre_execution_reconciliation:reconciliation,
      pre_execution_arbitration:arbitration,
      v6sia_supervision: supervision,
      execution_owner:'executeApprovedDecisionQueue',
      confirmation_owner:'confirmExecutedDecisions',
      duplicate_executor:false,
      decision_contract:'V6SIA diagnosis -> validated data/economics -> canonical arbiter -> one net mutation per entity -> canonical queue -> Amazon confirmation',
    });
  }catch(error:any){return Response.json({ok:false,error:error?.message||String(error)},{status:500})}
});
