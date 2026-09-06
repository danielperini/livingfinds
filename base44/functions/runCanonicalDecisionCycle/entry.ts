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

            // Contrato soberano V4. O executor já revalida estes campos contra
            // Amazon Truth; ausência ou inconsistência resulta em HOLD.
            _decision_authority:
              'CANONICAL_PROFIT_ENGINE_V4',

            objective_mode:
              'maximize_profitable_sales_bounded_loss',

            required_economic_context:[
              'price','product_cost','amazon_fees','margin','inventory',
              'buyability','conversion_rate','break_even_acos','safe_max_cpc'
            ],

            missing_or_unsafe_context_action:
              'HOLD',

            require_positive_expected_profit_or_sales_gain:
              true,

            correlation_id:
              body.correlation_id ||
              crypto.randomUUID(),

            trigger_type:
              body.trigger_type ||
              'canonical_decision_cycle_v4'
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
        'CANONICAL_PROFIT_ENGINE_V4',

      decision_contract:{
        objective:'maximize_profitable_sales_bounded_loss',
        missing_context:'HOLD',
        amazon_confirmation_required:true
      }
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
