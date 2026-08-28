import {
  createClientFromRequest
} from 'npm:@base44/sdk@0.8.40';

Deno.serve(async(request)=>{

  try{

    const base44 =
      createClientFromRequest(
        request
      );

    const body =
      await request
        .json()
        .catch(()=>({}));

    const authenticated =
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

    /*
     * Gateway único.
     *
     * Nada abaixo deste endpoint decide
     * diretamente por causa do scheduler.
     */
    const response =
      await base44
        .asServiceRole
        .functions
        .invoke(
          'runCanonicalProfitEngineV3',
          {
            ...body,

            _service_role:true,

            correlation_id:
              body.correlation_id ||
              crypto.randomUUID(),

            trigger_type:
              body.trigger_type ||
              'canonical_decision_cycle_v3'
          }
        );

    const data =
      response?.data ||
      response ||
      {};

    return Response.json({
      ...data,

      gateway:
        'runCanonicalDecisionCycle',

      unique_engine:
        'runCanonicalProfitEngineV3'
    });

  }catch(error:any){

    return Response.json(
      {
        ok:false,
        gateway:
          'runCanonicalDecisionCycle',

        error:
          error?.message ||
          String(error)
      },
      {status:500}
    );
  }
});
