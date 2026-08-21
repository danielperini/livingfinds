import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

const TITLE = 'Living Finds Sales Engine — Vendas com Risco Controlado v1';
const VERSION = 'sales-risk-v1';
const invoke = async (base44:any,name:string,payload:Record<string,unknown>) => {
  try { const r = await base44.asServiceRole.functions.invoke(name,payload); return r?.data || r || {ok:true}; }
  catch (error:any) { return {ok:false,error:error?.response?.data?.error || error?.message || String(error)}; }
};

Deno.serve(async (request) => {
  try {
    const base44:any = createClientFromRequest(request) as any;
    const body:any = await request.json().catch(() => ({}));
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    if (!authenticated && !body._service_role) return Response.json({ok:false,error:'Não autorizado'},{status:401});

    const correlationId = body.correlation_id || crypto.randomUUID();
    const common:any = {
      amazon_account_id: body.amazon_account_id || null,
      _service_role: true,
      correlation_id: correlationId,
      sales_engine_version: VERSION,
      engine_title: TITLE,
      growth_mode: true,
      sales_recovery_mode: true,
      trigger_type: body.trigger_type || 'sales_risk_immediate_full_review',
    };

    // 1) Fresh data before any portfolio-wide decision.
    const stateSync = await invoke(base44,'syncAdsCampaignStatesV2',{...common,trigger_type:'sales_risk_activation_state_sync'});
    const offerSync = await invoke(base44,'syncAmazonOfferAvailability',{...common,trigger_type:'sales_risk_activation_offer_sync'});
    const intradaySync = await invoke(base44,'syncAmazonIntradayCampaignMetrics',{...common,action:'auto',trigger_type:'sales_risk_activation_intraday_sync'});

    // 2) GPT supervision can recalibrate SOFT risk rules. It does not bypass
    // stock, buyability, break-even, safe CPC, daily cap or Amazon confirmation.
    const gptSupervisor = body.skip_gpt === true ? {ok:true,skipped:true} : await invoke(base44,'runCanonicalWeeklyDecisionReview',{
      ...common,
      trigger_type:'sales_risk_activation_gpt_supervisor',
      activation_review:true,
    });

    // 3) Force every portfolio layer to re-evaluate now instead of waiting for
    // the normal 3h/hourly windows. All campaigns are reviewed; only justified
    // mutations survive evidence + governor + arbiter.
    const cycle = await invoke(base44,'runCanonicalDecisionCycle',{
      ...common,
      dry_run:false,
      skip_sync:true,
      bootstrap:true,
      force_campaign_lifecycle:true,
      force_dayparting:true,
      migrate_daypart_rules:true,
      full_repricing_evaluation:false,
      serving_campaign_growth_target_pct: body.serving_campaign_growth_target_pct ?? 60,
      max_auto_budget_expansions: body.max_auto_budget_expansions ?? 8,
      max_new_exact_per_run: body.max_new_exact_per_run ?? 8,
      max_structure_repairs_per_run: body.max_structure_repairs_per_run ?? 12,
      max_bid_recoveries_per_run: body.max_bid_recoveries_per_run ?? 12,
      max_economic_evidence_candidates: body.max_economic_evidence_candidates ?? 1000,
      trigger_type:'sales_risk_activation_full_portfolio_review',
    });

    // 4) Execute and confirm immediately. No success claim without Amazon confirmation.
    const execution = await invoke(base44,'executeApprovedDecisionQueue',{
      ...common,
      max_decisions: body.max_decisions ?? 100,
      trigger_type:'sales_risk_activation_executor',
    });
    const confirmation = await invoke(base44,'confirmExecutedDecisions',{
      ...common,
      trigger_type:'sales_risk_activation_confirmation',
    });
    const resync = await invoke(base44,'syncAmazonIntradayCampaignMetrics',{
      ...common,
      action:'auto',
      trigger_type:'sales_risk_activation_post_execution_sync',
    });
    const audit = await invoke(base44,'auditAdsAutomationE2E',{
      ...common,
      trigger_type:'sales_risk_activation_e2e_audit',
    });

    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: body.amazon_account_id || null,
      operation:'sales_risk_engine_activation',
      trigger_type: common.trigger_type,
      status:[stateSync,offerSync,intradaySync,cycle,execution,confirmation,audit].every((x:any)=>x?.ok!==false)?'success':'partial',
      records_processed: Number(execution?.executed || execution?.processed || 0),
      result_summary:`${TITLE}; full_portfolio_review=true; Amazon confirmation required; correlation=${correlationId}`,
      started_at:new Date().toISOString(),
      completed_at:new Date().toISOString(),
    }).catch(()=>{});

    return Response.json({
      ok:[stateSync,offerSync,intradaySync,cycle,execution,confirmation,audit].every((x:any)=>x?.ok!==false),
      engine_title:TITLE,
      engine_version:VERSION,
      activation_mode:'IMMEDIATE_FULL_PORTFOLIO_REVIEW',
      all_campaigns_reviewed:true,
      forced_change:false,
      rule:'review every campaign/keyword/target/bid; mutate only when economically defensible',
      hard_guardrails:['OUT_OF_STOCK','NOT_BUYABLE','LISTING_INACTIVE','ACCOUNT_DAILY_CAP','SAFE_MAX_CPC','BREAK_EVEN_ACOS','NEGATIVE_MARGIN','AMAZON_CONFIRMATION','IDEMPOTENCY'],
      correlation_id:correlationId,
      state_sync:stateSync,
      offer_sync:offerSync,
      intraday_sync:intradaySync,
      gpt_supervisor:gptSupervisor,
      canonical_cycle:cycle,
      execution,
      confirmation,
      post_execution_sync:resync,
      audit,
    });
  } catch (error:any) {
    return Response.json({ok:false,error:error?.message||String(error)},{status:500});
  }
});
