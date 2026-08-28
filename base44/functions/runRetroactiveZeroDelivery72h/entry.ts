import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

Deno.serve(async(req)=>{
  try{
    const base44=createClientFromRequest(req);
    const body=await req.json().catch(()=>({}));

    const authenticated=
      await base44.auth.isAuthenticated().catch(()=>false);

    if(!authenticated && !body._service_role){
      return Response.json(
        {ok:false,error:'Não autorizado'},
        {status:401}
      );
    }

    const payload={
      _service_role:true,

      _canonical_orchestrator:
        'runUnifiedDecisionEngine',

      dry_run:
        body.dry_run === true,

      delivery_lookback_days:7,

      max_bid_recoveries_per_run:80,

      max_replacements_per_run:40,

      max_structure_repairs_per_run:5,

      trigger_type:
        body.trigger_type ||
        'retroactive_zero_delivery_72h_10cent'
    };

    const response=
      await base44.asServiceRole.functions.invoke(
        'reconcileCampaignDeliveryHealth',
        payload
      );

    const data=
      response?.data ||
      response ||
      {};

    return Response.json({
      ok:data?.ok !== false,

      engine:
        'ZERO_DELIVERY_72H_10CENT_V1',

      rule:{
        zero_delivery_hours:72,
        bid_increment_brl:0.10,
        max_escalations:3,
        final_action:
          'PAUSE_AND_REPLACE',
        safe_max_cpc_required:true,
        retroactive:true
      },

      result:data
    });

  }catch(error:any){

    return Response.json(
      {
        ok:false,
        engine:
          'ZERO_DELIVERY_72H_10CENT_V1',
        error:
          error?.message || String(error)
      },
      {status:500}
    );
  }
});
