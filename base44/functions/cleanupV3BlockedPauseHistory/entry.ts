import {
  createClientFromRequest
} from 'npm:@base44/sdk@0.8.40';

function lower(v:any){
  return String(v || '').trim().toLowerCase();
}

function action(v:any){
  return lower(
    v?.action ||
    v?.action_type ||
    v?.canonical_action_type
  );
}

function when(v:any){
  return (
    v?.updated_at ||
    v?.updated_date ||
    v?.created_at ||
    v?.created_date ||
    ''
  );
}

Deno.serve(async(req)=>{

  try{

    const base44:any=
      createClientFromRequest(req);

    const body:any=
      await req.json().catch(()=>({}));

    if(body._service_role !== true){
      return Response.json(
        {ok:false,error:'service role required'},
        {status:401}
      );
    }

    const accounts=
      body.amazon_account_id

      ? await base44.asServiceRole.entities.AmazonAccount.filter(
          {id:body.amazon_account_id},
          undefined,
          1
        )

      : await base44.asServiceRole.entities.AmazonAccount.filter(
          {status:'connected'},
          '-updated_at',
          20
        );

    const cutoffHours=
      Math.max(
        1,
        Math.min(
          72,
          Number(body.lookback_hours || 24)
        )
      );

    const cutoff=
      Date.now() -
      cutoffHours*3600000;

    let scanned=0;
    let superseded=0;
    let preservedExecuted=0;

    const rows:any[]=[];

    for(const account of accounts){

      const decisions:any[]=
        await base44.asServiceRole.entities.OptimizationDecision.filter(
          {amazon_account_id:account.id},
          '-created_at',
          5000
        ).catch(()=>[]);

      for(const d of decisions){

        const t=
          new Date(when(d) || 0).getTime();

        if(
          !Number.isFinite(t) ||
          t < cutoff
        ){
          continue;
        }

        if(!action(d).includes('pause')){
          continue;
        }

        scanned++;

        const status=
          lower(
            d.status ||
            d.queue_status
          );

        const confirmation=
          lower(
            d.confirmation_status
          );

        /*
         * Pausa realmente executada/confirmada:
         * preservar.
         */
        if(
          status==='executed' ||
          status==='confirming' ||
          status==='awaiting_confirmation' ||
          confirmation==='confirmed'
        ){
          preservedExecuted++;
          continue;
        }

        const blocked=
          d.hard_block===true ||
          [
            'blocked',
            'cancelled',
            'canceled',
            'rejected',
            'skipped'
          ].includes(status) ||
          Array.isArray(d?.governance?.blockers);

        if(!blocked){
          continue;
        }

        await base44.asServiceRole.entities.OptimizationDecision.update(
          d.id,
          {
            status:'superseded',

            queue_status:'completed',

            approval_status:'superseded',

            operational_visibility:'internal',

            cancelled_reason:
              'V3_PREFLIGHT_SUPERSEDED_BLOCKED_PAUSE',

            error_message:
              'Proposta de pausa barrada pelo V3. Mantida somente como auditoria interna; não é decisão operacional atual.',

            updated_at:
              new Date().toISOString()
          }
        ).catch(()=>null);

        superseded++;

        rows.push({
          id:d.id,
          asin:d.asin || null,
          campaign_id:
            d.campaign_id ||
            d.entity_id ||
            null
        });
      }
    }

    return Response.json({
      ok:true,
      scanned,
      superseded,
      preserved_executed:
        preservedExecuted,
      rows:rows.slice(0,200)
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
