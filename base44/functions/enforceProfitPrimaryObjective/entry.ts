import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

/**
 * Fonte canônica do objetivo empresarial.
 *
 * A única meta primária do motor é:
 *
 * MAXIMIZAR LUCRO ESPERADO
 * sujeito a prejuízo máximo controlado.
 *
 * ACoS, ROAS, TACoS, CPC, impressões, quantidade de campanhas,
 * delivery e cobertura continuam existindo exclusivamente como:
 *
 * - sinais;
 * - restrições;
 * - guardrails;
 * - diagnósticos.
 *
 * Nunca como objetivos concorrentes.
 */

const PRIMARY_GOAL = 'expected_profit';
const OBJECTIVE = 'profitability';
const OBJECTIVE_MODE = 'maximize_expected_profit_bounded_loss';
const VERSION = 'profit-v1';

Deno.serve(async(req)=>{
  try {

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

    const accounts=body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter(
          {id:body.amazon_account_id},
          undefined,
          1
        )
      : await base44.asServiceRole.entities.AmazonAccount.filter(
          {status:'connected'},
          '-updated_at',
          50
        );

    const results:any[]=[];

    for(const account of accounts){

      const rows=
        await base44.asServiceRole.entities.PerformanceSettings.filter(
          {amazon_account_id:account.id},
          '-updated_at',
          1
        ).catch(()=>[]);

      const patch={
        primary_goal:PRIMARY_GOAL,
        objective:OBJECTIVE,

        profit_objective_mode:
          OBJECTIVE_MODE,

        secondary_goals_hidden:true,
        profit_objective_version:VERSION,

        /*
         * Impressões deixam explicitamente de ser uma meta.
         * Elas continuam sendo usadas pelo motor como sinal
         * de entrega/competitividade.
         */
        impressions_goal_enabled:false,

        updated_at:new Date().toISOString(),
      };

      let id:string|null=null;

      if(rows[0]){
        await base44.asServiceRole.entities.PerformanceSettings.update(
          rows[0].id,
          patch
        );

        id=rows[0].id;

      }else{

        const created=
          await base44.asServiceRole.entities.PerformanceSettings.create({
            amazon_account_id:account.id,
            ...patch,
          });

        id=created.id;
      }

      results.push({
        amazon_account_id:account.id,
        performance_settings_id:id,

        primary_goal:PRIMARY_GOAL,
        objective:OBJECTIVE,
        objective_mode:OBJECTIVE_MODE,

        secondary_goals_hidden:true,

        /*
         * Guardrails preservados.
         */
        guardrails:[
          'safe_max_cpc',
          'break_even_acos',
          'inventory',
          'listing',
          'buyability',
          'account_daily_budget_limit',
          'learning_loss_budget',
          'amazon_confirmation'
        ],
      });
    }

    return Response.json({
      ok:true,

      primary_goal:PRIMARY_GOAL,

      objective_contract:{
        maximize:'expected_profit',

        subject_to:[
          'bounded_learning_loss',
          'safe_cpc',
          'break_even_economics',
          'inventory',
          'listing_and_buyability',
          'account_budget_envelope',
          'amazon_confirmation'
        ],

        secondary_metrics_are:
          'signals_and_guardrails_only',
      },

      results,
    });

  }catch(error:any){

    return Response.json(
      {
        ok:false,
        error:error?.message || String(error)
      },
      {status:500}
    );
  }
});
