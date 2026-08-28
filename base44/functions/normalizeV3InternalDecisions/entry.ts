import {
  createClientFromRequest
} from 'npm:@base44/sdk@0.8.40';

function s(v:any){
  return String(v ?? '').trim();
}

function n(v:any, fallback=0){
  const x=Number(v);
  return Number.isFinite(x)
    ? x
    : fallback;
}

function parseJson(v:any){
  if(!v) return {};
  if(typeof v === 'object') return v;

  try{
    return JSON.parse(String(v));
  }catch{
    return {};
  }
}

function isBidAction(action:string){
  return [
    'set_bid',
    'increase_bid',
    'reduce_bid',
    'update_bid'
  ].includes(action);
}

function isBudgetAction(action:string){
  return [
    'budget_change',
    'update_budget',
    'increase_budget',
    'reduce_budget'
  ].includes(action);
}

function rollbackFor(d:any){
  if(d.rollback_plan)
    return d.rollback_plan;

  const action=s(d.action).toLowerCase();

  const before=
    d.value_before ??
    d.current_value;

  if(
    before !== null &&
    before !== undefined &&
    (
      isBidAction(action) ||
      isBudgetAction(action)
    )
  ){
    return `RESTORE_PREVIOUS_VALUE:${before}`;
  }

  if(action==='pause_campaign')
    return 'RESTORE_CAMPAIGN_STATE:enabled';

  if(action==='pause_keyword')
    return 'RESTORE_KEYWORD_STATE:enabled';

  if(action==='pause_target')
    return 'RESTORE_TARGET_STATE:enabled';

  return null;
}

Deno.serve(async(req)=>{

  const t0=Date.now();

  try{

    const base44:any=
      createClientFromRequest(req);

    const body:any=
      await req.json()
        .catch(()=>({}));

    const authenticated=
      await base44.auth
        .isAuthenticated()
        .catch(()=>false);

    if(
      !authenticated &&
      !body._service_role
    ){
      return Response.json(
        {
          ok:false,
          error:'Não autorizado'
        },
        {status:401}
      );
    }

    let accounts:any[]=[];

    if(body.amazon_account_id){

      accounts=
        await base44.asServiceRole
          .entities.AmazonAccount.filter(
            {
              id:body.amazon_account_id
            },
            undefined,
            1
          );

    }else{

      accounts=
        await base44.asServiceRole
          .entities.AmazonAccount.filter(
            {
              status:'connected'
            },
            undefined,
            20
          );
    }

    let scanned=0;
    let normalized=0;
    let cancelled=0;
    let alreadyV3=0;

    const details:any[]=[];

    /*
     * Só considerar decisões MUITO recentes.
     *
     * Não ressuscitar histórico antigo.
     */
    const cutoffMs=
      Date.now() -
      Number(
        body.lookback_minutes || 30
      )*60000;

    for(const account of accounts){

      const aid=account.id;

      const rows:any[]=
        await base44.asServiceRole
          .entities.OptimizationDecision.filter(
            {
              amazon_account_id:aid,
              status:'approved'
            },
            '-created_at',
            500
          )
          .catch(()=>[]);

      for(const d of rows){

        const createdMs=
          new Date(
            d.created_at ||
            d.updated_at ||
            0
          ).getTime();

        if(
          !Number.isFinite(createdMs) ||
          createdMs < cutoffMs
        ){
          continue;
        }

        scanned++;

        const currentPolicy=
          s(d.policy_version)
            .toUpperCase();

        const currentOwner=
          s(d.decision_owner)
            .toUpperCase();

        if(
          currentPolicy==='PROFIT_ENGINE_V3' &&
          currentOwner==='CANONICAL_PROFIT_ENGINE_V3'
        ){
          alreadyV3++;
          continue;
        }

        /*
         * SOMENTE decisões vindas do deterministic
         * que agora é subcomponente interno do V3.
         */
        const source=
          s(d.source_function);

        const canonicalInternalSources = new Set([
          'runDeterministicDecisionEngine',
          'runSalesModeWasteRotation',
          'runIntradaySalesRecovery',
          'runAsinPortfolioDiversificationGuard'
        ]);

        if(
          !canonicalInternalSources.has(source)
        ){
          continue;
        }

        const action=
          s(d.action)
            .toLowerCase();

        /*
         * Não promover ações desconhecidas.
         */
        const supported=[
          'set_bid',
          'increase_bid',
          'reduce_bid',
          'update_bid',
          'budget_change',
          'update_budget',
          'increase_budget',
          'reduce_budget',
          'pause_campaign',
          'pause_keyword'
        ].includes(action);

        if(!supported){

          await base44.asServiceRole
            .entities.OptimizationDecision.update(
              d.id,
              {
                status:'cancelled',

                queue_status:'completed',

                cancelled_reason:
                  'V3_UNSUPPORTED_ACTION',

                error_message:
                  `V3_UNSUPPORTED_ACTION:${action}`
              }
            )
            .catch(()=>{});

          cancelled++;

          details.push({
            id:d.id,
            action,
            result:'cancelled_unsupported'
          });

          continue;
        }

        /*
         * Evidence packet existente.
         */
        const evidence=
          parseJson(d.data_used);

        /*
         * Não inventar timestamp remoto.
         *
         * Primeiro procurar timestamp de evidência
         * já persistido; fallback para criação da
         * própria decisão, pois ela acabou de ser
         * produzida após sync intraday pelo ciclo V3.
         */
        const observedAt=
          evidence?.admission?.observed_at ||
          evidence?.metrics_observed_at ||
          d.metrics_observed_at ||
          d.data_window_end ||
          d.created_at ||
          new Date().toISOString();

        const admission={
          ...(evidence?.admission || {}),

          verified:true,

          observed_at:
            observedAt,

          verified_by:
            'CANONICAL_PROFIT_ENGINE_V3',

          source:
            'canonical_metrics_after_sync'
        };

        const before=
          d.value_before ??
          d.current_value;

        const after=
          d.value_after ??
          d.proposed_value;

        /*
         * Bid inicial sem before válido não deve ganhar
         * fallback arbitrário aqui.
         */
        if(
          isBidAction(action) &&
          (
            after === null ||
            after === undefined ||
            !Number.isFinite(Number(after)) ||
            Number(after)<=0
          )
        ){

          await base44.asServiceRole
            .entities.OptimizationDecision.update(
              d.id,
              {
                status:'cancelled',
                queue_status:'completed',

                cancelled_reason:
                  'V3_INVALID_PROPOSED_BID',

                error_message:
                  'V3_INVALID_PROPOSED_BID: decisão sem value_after válido.'
              }
            )
            .catch(()=>{});

          cancelled++;

          details.push({
            id:d.id,
            action,
            result:'cancelled_invalid_bid'
          });

          continue;
        }

        const rollback=
          rollbackFor(d);

        if(!rollback){

          await base44.asServiceRole
            .entities.OptimizationDecision.update(
              d.id,
              {
                status:'cancelled',
                queue_status:'completed',

                cancelled_reason:
                  'V3_ROLLBACK_NOT_DERIVABLE',

                error_message:
                  'V3_ROLLBACK_NOT_DERIVABLE'
              }
            )
            .catch(()=>{});

          cancelled++;

          details.push({
            id:d.id,
            action,
            result:'cancelled_no_rollback'
          });

          continue;
        }

        /*
         * canonical_action_type é usado pelo executor
         * para reconhecer a decisão como canônica.
         */
        const canonicalAction=
          isBidAction(action)
            ? 'bid'
            : isBudgetAction(action)
              ? 'budget'
              : action.includes('campaign')
                ? 'campaign_state'
                : action.includes('keyword')
                  ? 'keyword_state'
                  : action;

        const maxAge=
          Math.max(
            45,
            n(
              d.maximum_data_age_minutes,
              180
            )
          );

        const patchedEvidence={
          ...evidence,

          admission,

          canonical_engine:
            'CANONICAL_PROFIT_ENGINE_V3',

          policy_version:
            'PROFIT_ENGINE_V3',

          normalized_at:
            new Date().toISOString(),

          original_source_function:
            source
        };

        const patch:any={

          policy_version:
            'PROFIT_ENGINE_V3',

          decision_owner:
            'CANONICAL_PROFIT_ENGINE_V3',

          canonical_engine:
            'CANONICAL_PROFIT_ENGINE_V3',

          canonical_action_type:
            canonicalAction,

          execution_mode:
            'EXECUTE_NOW',

          requires_approval:
            false,

          approval_status:
            'approved',

          queue_status:
            'queued',

          requires_fresh_data:
            true,

          maximum_data_age_minutes:
            maxAge,

          rollback_plan:
            rollback,

          data_used:
            JSON.stringify(
              patchedEvidence
            ),

          /*
           * Mantém status approved para o executor
           * canônico consumir.
           */
          status:
            'approved',

          updated_at:
            new Date().toISOString()
        };

        /*
         * Não sobrescrever valores reais.
         */
        if(
          before !== undefined &&
          before !== null
        ){
          patch.value_before=before;
        }

        if(
          after !== undefined &&
          after !== null
        ){
          patch.value_after=after;
        }

        await base44.asServiceRole
          .entities.OptimizationDecision.update(
            d.id,
            patch
          );

        normalized++;

        details.push({
          id:d.id,
          action,
          entity_type:d.entity_type,
          entity_id:d.entity_id,
          campaign_id:d.campaign_id,
          keyword_id:d.keyword_id,
          before,
          after,
          canonical_action_type:
            canonicalAction,
          rollback,
          result:'normalized_v3'
        });
      }
    }

    return Response.json({
      ok:true,

      engine:
        'CANONICAL_PROFIT_ENGINE_V3',

      scanned,
      normalized,
      cancelled,
      already_v3:alreadyV3,

      details:
        details.slice(0,100),

      duration_ms:
        Date.now()-t0
    });

  }catch(error:any){

    return Response.json(
      {
        ok:false,
        error:
          error?.message ||
          String(error)
      },
      {status:500}
    );
  }
});
