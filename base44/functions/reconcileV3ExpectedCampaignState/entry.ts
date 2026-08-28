import {
  createClientFromRequest
} from 'npm:@base44/sdk@0.8.40';

function lower(v:any){
  return String(v || '')
    .trim()
    .toLowerCase();
}

function upper(v:any){
  return String(v || '')
    .trim()
    .toUpperCase();
}

function campaignId(v:any){
  return String(
    v?.campaign_id ||
    v?.amazon_campaign_id ||
    v?.entity_id ||
    ''
  );
}

function when(v:any){
  const raw =
    v?.confirmed_at ||
    v?.executed_at ||
    v?.last_attempt_at ||
    v?.updated_at ||
    v?.updated_date ||
    v?.created_at ||
    v?.created_date ||
    null;

  const t =
    raw
      ? new Date(raw).getTime()
      : 0;

  return Number.isFinite(t)
    ? t
    : 0;
}

function isRecent(v:any,hours:number){
  const t=when(v);

  return (
    t>0 &&
    t >=
      Date.now() -
      hours*3600000
  );
}

function isPause(v:any){
  return (
    lower(
      v?.action ||
      v?.action_type ||
      v?.canonical_action_type
    ).includes('pause')
  );
}

function isV3(v:any){
  const text=[
    v?.policy_version,
    v?.decision_owner,
    v?.canonical_engine,
    v?.source_function
  ]
    .map(upper)
    .join('|');

  return (
    text.includes('PROFIT_ENGINE_V3') ||
    text.includes('CANONICAL_PROFIT_ENGINE_V3')
  );
}

Deno.serve(async(req)=>{

  const started=Date.now();

  try{

    const base44:any=
      createClientFromRequest(req);

    const body:any=
      await req.json()
        .catch(()=>({}));

    if(
      body._service_role !== true
    ){
      const authenticated=
        await base44.auth
          .isAuthenticated()
          .catch(()=>false);

      if(!authenticated){
        return Response.json(
          {
            ok:false,
            error:'Não autorizado'
          },
          {status:401}
        );
      }
    }

    const accounts=
      body.amazon_account_id

      ? await base44
          .asServiceRole
          .entities
          .AmazonAccount
          .filter(
            {id:body.amazon_account_id},
            undefined,
            1
          )

      : await base44
          .asServiceRole
          .entities
          .AmazonAccount
          .filter(
            {status:'connected'},
            '-updated_at',
            50
          );

    const reports:any[]=[];

    for(const account of accounts){

      const aid=account.id;

      const [
        campaigns,
        decisions
      ]=
        await Promise.all([

          base44
            .asServiceRole
            .entities
            .Campaign
            .filter(
              {
                amazon_account_id:aid
              },
              '-updated_at',
              5000
            )
            .catch(()=>[]),

          base44
            .asServiceRole
            .entities
            .OptimizationDecision
            .filter(
              {
                amazon_account_id:aid
              },
              '-created_at',
              5000
            )
            .catch(()=>[])
        ]);

      /*
       * syncAdsCampaignStatesV2 já trouxe a verdade Amazon
       * para Campaign.state/status/amazon_status.
       */
      const remoteEnabled=
        campaigns.filter(
          (c:any)=>{
            const state=
              lower(
                c.state ||
                c.amazon_status ||
                c.status
              );

            return (
              state==='enabled' &&
              c.archived !== true
            );
          }
        );

      const affectedAsins=
        new Set<string>();

      let stalePauseDecisions=0;
      let protectedRecentPause=0;
      let campaignExpectationsCleared=0;

      for(const campaign of remoteEnabled){

        const cid=
          campaignId(campaign);

        if(!cid)
          continue;

        const pauses=
          decisions.filter(
            (d:any)=>
              campaignId(d)===cid &&
              isPause(d)
          );

        /*
         * Uma pausa REAL recém enviada merece janela
         * de propagação antes de aceitarmos Amazon=enabled
         * como contraditória.
         */
        const recentRealPause=
          pauses.find(
            (d:any)=>
              isV3(d) &&
              isRecent(d,6) &&
              [
                'executed',
                'confirming',
                'awaiting_confirmation'
              ].includes(
                lower(d.status)
              )
          );

        if(recentRealPause){
          protectedRecentPause++;
          continue;
        }

        /*
         * Amazon está ENABLED e não há pausa V3 real
         * aguardando propagação.
         *
         * Qualquer expectativa local PAUSED é antiga.
         */
        for(const decision of pauses){

          const status=
            lower(
              decision.status ||
              decision.queue_status
            );

          if(
            [
              'superseded',
              'confirmed'
            ].includes(status)
          ){
            continue;
          }

          /*
           * Não transformar execução recente em histórico
           * silenciosamente.
           */
          if(
            isRecent(decision,6) &&
            [
              'executed',
              'confirming',
              'awaiting_confirmation'
            ].includes(status)
          ){
            continue;
          }

          await base44
            .asServiceRole
            .entities
            .OptimizationDecision
            .update(
              decision.id,
              {
                status:
                  'superseded',

                queue_status:
                  'completed',

                approval_status:
                  'superseded',

                confirmation_status:
                  'remote_truth_overrode_local_expectation',

                cancelled_reason:
                  'AMAZON_ENABLED_SUPERSEDES_STALE_PAUSE',

                operational_visibility:
                  'internal',

                error_message:
                  'Amazon confirmou campanha ENABLED. Expectativa local antiga de PAUSED foi invalidada pelo V3.',

                updated_at:
                  new Date().toISOString()
              }
            )
            .catch(()=>null);

          stalePauseDecisions++;
        }

        /*
         * Corrigir campos de expectativa SOMENTE se
         * eles já existem na entidade.
         *
         * Não inventamos schema.
         */
        const patch:any={};

        const keys=[
          'expected_state',
          'expected_amazon_state',
          'desired_state',
          'intended_state'
        ];

        for(const key of keys){

          if(
            Object.prototype.hasOwnProperty.call(
              campaign,
              key
            )
          ){
            patch[key]='enabled';
          }
        }

        if(
          Object.keys(patch).length>0
        ){

          patch.updated_at=
            new Date().toISOString();

          await base44
            .asServiceRole
            .entities
            .Campaign
            .update(
              campaign.id,
              patch
            )
            .catch(()=>null);

          campaignExpectationsCleared++;
        }

        const asin=
          upper(
            campaign.asin ||
            campaign.advertised_asin
          );

        if(asin)
          affectedAsins.add(asin);
      }

      reports.push({
        amazon_account_id:aid,

        remote_enabled:
          remoteEnabled.length,

        stale_pause_decisions_superseded:
          stalePauseDecisions,

        recent_real_pause_preserved:
          protectedRecentPause,

        campaign_expectations_corrected:
          campaignExpectationsCleared,

        affected_asins:
          [...affectedAsins]
      });
    }

    return Response.json({
      ok:true,

      engine:
        'CANONICAL_PROFIT_ENGINE_V3',

      operation:
        'AMAZON_REMOTE_TRUTH_RECONCILIATION',

      reports,

      duration_ms:
        Date.now()-started
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
