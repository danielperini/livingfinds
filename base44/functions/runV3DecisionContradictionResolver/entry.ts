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

function ageMinutes(v:any){
  const t=
    new Date(v || 0)
      .getTime();

  if(!Number.isFinite(t))
    return Infinity;

  return (
    Date.now()-t
  )/60000;
}

function number(v:any){
  const n=Number(v);
  return Number.isFinite(n)
    ? n
    : 0;
}

function actionOf(d:any){
  return lower(
    d.action ||
    d.action_type ||
    d.canonical_action_type
  );
}

function reasonOf(d:any){
  return upper(
    d.cancelled_reason ||
    d.reason_code ||
    d.blocked_reason ||
    d.reason ||
    ''
  );
}

function isPause(d:any){
  return (
    actionOf(d).includes('pause')
  );
}

function isWinnerLike(d:any){
  const orders30=
    number(
      d.orders_30d ??
      d.orders30d ??
      d.orders
    );

  const sales30=
    number(
      d.sales_30d ??
      d.sales30d ??
      d.sales
    );

  const spend30=
    number(
      d.spend_30d ??
      d.spend30d ??
      d.spend
    );

  const acos30=
    sales30>0
      ? spend30/sales30*100
      : 999;

  const roas30=
    spend30>0
      ? sales30/spend30
      : 0;

  return (
    orders30>0 &&
    sales30>0 &&
    (
      roas30>=2 ||
      acos30<=50
    )
  );
}

function zeroDelivery(d:any){
  return (
    number(d.spend_7d ?? d.spend)<=0 &&
    number(d.clicks_7d ?? d.clicks)<=0 &&
    number(d.orders_7d ?? d.orders)<=0
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

    const authenticated=
      await base44.auth
        .isAuthenticated()
        .catch(()=>false);

    if(
      !authenticated &&
      body._service_role !== true
    ){
      return Response.json(
        {
          ok:false,
          error:'Não autorizado'
        },
        {status:401}
      );
    }

    const lookbackMinutes=
      Math.max(
        10,
        Math.min(
          1440,
          Number(
            body.lookback_minutes ||
            180
          )
        )
      );

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

      const decisions:any[]=
        await base44
          .asServiceRole
          .entities
          .OptimizationDecision
          .filter(
            {
              amazon_account_id:aid
            },
            '-created_at',
            3000
          )
          .catch(()=>[]);

      const recent=
        decisions.filter(
          d =>
            ageMinutes(
              d.updated_at ||
              d.created_at ||
              d.created_date
            ) <= lookbackMinutes
        );

      let contradictions=0;
      let winnerPause=0;
      let zeroDeliveryPause=0;
      let hidden=0;

      const affectedAsins=
        new Set<string>();

      for(const d of recent){

        const status=
          lower(
            d.status ||
            d.queue_status
          );

        /*
         * Estamos olhando principalmente decisões
         * canceladas/bloqueadas ou PAUSE ainda aberta.
         */
        const candidate=
          isPause(d) &&
          (
            [
              'cancelled',
              'canceled',
              'blocked',
              'rejected',
              'approved',
              'pending',
              'queued'
            ].includes(status)
            ||
            d.hard_block === true
          );

        if(!candidate)
          continue;

        const reason=
          reasonOf(d);

        const winner=
          isWinnerLike(d) ||
          reason.includes(
            'WINNER_PROTECTION'
          );

        const zero=
          zeroDelivery(d) ||
          reason.includes(
            'ZERO_DELIVERY'
          );

        if(!winner && !zero)
          continue;

        contradictions++;

        if(winner)
          winnerPause++;

        if(zero)
          zeroDeliveryPause++;

        const asin=
          upper(
            d.asin ||
            d.advertised_asin
          );

        if(asin)
          affectedAsins.add(
            asin
          );

        /*
         * Não apagar histórico.
         *
         * Reclassificar como superseded interno para que
         * não seja tratado como decisão operacional atual.
         */
        await base44
          .asServiceRole
          .entities
          .OptimizationDecision
          .update(
            d.id,
            {
              status:'superseded',

              queue_status:
                'completed',

              approval_status:
                'superseded',

              cancelled_reason:
                winner
                  ? 'V3_PREFLIGHT_WINNER_PROTECTION'
                  : 'V3_PREFLIGHT_ZERO_DELIVERY_DELEGATED',

              error_message:
                winner
                  ? 'Proposta PAUSE incompatível com winner protection. Substituída antes de execução.'
                  : 'Zero delivery não representa waste financeiro. Delegado ao lifecycle V3.',

              operational_visibility:
                'internal',

              updated_at:
                new Date().toISOString()
            }
          )
          .catch(()=>null);

        hidden++;
      }

      /*
       * Resolver imediatamente.
       *
       * Não tomamos uma nova decisão local aqui.
       * Pedimos ao próprio gateway V3 para reavaliar os
       * ASINs afetados com o estado atual.
       */
      let reevaluation:any=null;

      if(
        affectedAsins.size>0 &&
        body.reenter_v3 !== false
      ){

        reevaluation=
          await base44
            .asServiceRole
            .functions
            .invoke(
              'runCanonicalDecisionCycle',
              {
                _service_role:true,

                dry_run:false,

                force:true,

                force_full_scan:false,

                retroactive:false,

                target_asins:
                  [...affectedAsins],

                contradiction_recovery:true,

                winner_harvest:true,

                canonical_engine:
                  'CANONICAL_PROFIT_ENGINE_V3',

                policy_version:
                  'PROFIT_ENGINE_V3',

                trigger_type:
                  'v3_autonomous_contradiction_recovery',

                /*
                 * Prevenir recursão infinita.
                 */
                skip_contradiction_resolver:true
              }
            )
            .catch(
              (error:any)=>({
                ok:false,
                error:
                  error?.message ||
                  String(error)
              })
            );
      }

      reports.push({
        amazon_account_id:aid,
        recent_scanned:
          recent.length,
        contradictions,
        winner_pause:
          winnerPause,
        zero_delivery_pause:
          zeroDeliveryPause,
        reclassified_internal:
          hidden,
        affected_asins:
          [...affectedAsins],
        reevaluation:
          reevaluation?.data ||
          reevaluation ||
          null
      });
    }

    return Response.json({
      ok:true,

      engine:
        'CANONICAL_PROFIT_ENGINE_V3',

      operation:
        'AUTONOMOUS_CONTRADICTION_RESOLVER',

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
