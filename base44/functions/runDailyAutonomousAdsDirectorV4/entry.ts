
import {
  createClientFromRequest
} from 'npm:@base44/sdk@0.8.31';

async function invoke(
  base44:any,
  name:string,
  payload:any={}
){
  const started=Date.now();

  try{

    const response =
      await base44.asServiceRole
        .functions
        .invoke(
          name,
          {
            ...payload,
            _service_role:true
          }
        );

    const data =
      response?.data ||
      response ||
      {};

    return {
      name,
      ok:data?.ok !== false,
      duration_ms:
        Date.now()-started,
      data
    };

  }catch(error:any){

    return {
      name,
      ok:false,
      duration_ms:
        Date.now()-started,
      error:
        error?.message ||
        String(error)
    };
  }
}

Deno.serve(async(request)=>{

  try{

    const base44 =
      createClientFromRequest(
        request
      );

    const body =
      await request.json()
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

    const accounts =
      body.amazon_account_id
      ? await base44.asServiceRole
          .entities.AmazonAccount
          .filter({
            id:body.amazon_account_id
          })
      : await base44.asServiceRole
          .entities.AmazonAccount
          .filter({
            status:'connected'
          });

    const results:any[]=[];

    for(
      const account
      of accounts as any[]
    ){

      const id=account.id;
      const steps:any[]=[];

      /*
       * =========================================
       * 1. AMAZON TRUTH
       * =========================================
       */

      steps.push(
        await invoke(
          base44,
          'syncProductCatalogV2',
          {
            amazon_account_id:id,
            trigger_type:
              'director_preflight_catalog'
          }
        )
      );

      steps.push(
        await invoke(
          base44,
          'syncAmazonOfferAvailability',
          {
            amazon_account_id:id,
            max_products:500,
            trigger_type:
              'director_preflight_stock_buyability'
          }
        )
      );

      steps.push(
        await invoke(
          base44,
          'syncAdsCampaignStatesV2',
          {
            amazon_account_id:id,
            trigger_type:
              'director_preflight_campaign_truth'
          }
        )
      );

      steps.push(
        await invoke(
          base44,
          'syncAmazonIntradayCampaignMetrics',
          {
            amazon_account_id:id,
            action:'auto',
            trigger_type:
              'director_preflight_metrics'
          }
        )
      );

      /*
       * =========================================
       * 2. PERSONA OPENAI DECIDE ESTRATÉGIA
       * =========================================
       */

      const ai =
        await invoke(
          base44,
          'runAutonomousAmazonAdsDirectorAI',
          {
            amazon_account_id:id,
            trigger_type:
              'daily_autonomous_ads_director'
          }
        );

      steps.push(ai);

      const strategy =
        ai?.data?.results?.[0]
          ?.strategy ||
        null;

      /*
       * Se IA falhar:
       * V4 continua determinístico.
       */

      const focus =
        strategy?.focus || {};

      const bounded =
        strategy
          ?.bounded_strategy ||
        {};

      /*
       * =========================================
       * 3. ACIONAR MOTORES DE ACORDO COM
       *    DECISÃO ESTRATÉGICA
       *
       * Todos possuem sua própria validação.
       * =========================================
       */

      if(
        focus.harvest_same_sku
        !== false
      ){
        steps.push(
          await invoke(
            base44,
            'runImmediateSameSkuSearchTermHarvest',
            {
              amazon_account_id:id,
              queue_only:true,
              max_creations:20,
              trigger_type:
                'director_same_sku_harvest'
            }
          )
        );
      }

      if(
        focus.kickoff_missing_coverage
        !== false
      ){
        steps.push(
          await invoke(
            base44,
            'processProductKickoffQueueV2',
            {
              amazon_account_id:id,
              max_items:20,
              trigger_type:
                'director_kickoff'
            }
          )
        );
      }

      if(
        focus.recover_zero_delivery
        !== false
      ){
        steps.push(
          await invoke(
            base44,
            'runRetroactiveZeroDelivery72h',
            {
              amazon_account_id:id,
              dry_run:false,
              trigger_type:
                'director_zero_delivery'
            }
          )
        );
      }

      if(
        focus.rebalance_budget
        !== false
      ){
        steps.push(
          await invoke(
            base44,
            'runEconomicBudgetBalancer',
            {
              amazon_account_id:id,
              queue_only:true,
              trigger_type:
                'director_budget_rebalance'
            }
          )
        );
      }

      if(
        focus.control_waste
        === true
      ){
        steps.push(
          await invoke(
            base44,
            'runSalesModeWasteRotation',
            {
              amazon_account_id:id,
              dry_run:false,
              trigger_type:
                'director_waste_control'
            }
          )
        );
      }

      /*
       * =========================================
       * 4. V4 RECEBE O DIRECIONAMENTO DA PERSONA
       * =========================================
       *
       * O body é propagado pelo Profit Engine
       * para os submotores do ciclo.
       */

      const canonical =
        await invoke(
          base44,
          'runCanonicalDecisionCycle',
          {
            amazon_account_id:id,

            dry_run:false,

            force:true,
            force_full_scan:true,

            daily_ai_review:false,
            weekly_ai_review:false,

            ai_strategy_source:
              'LIVINGFINDS_AUTONOMOUS_ADS_DIRECTOR_V1',

            ai_portfolio_state:
              strategy
                ?.portfolio_state ||
              'AI_UNAVAILABLE',

            ai_priorities:
              strategy
                ?.priorities ||
              [],

            ai_focus:
              focus,

            max_bid_step_pct:
              Math.min(
                15,
                Number(
                  bounded
                    .max_bid_increase_pct
                  || 15
                )
              ),

            max_bid_reduction_pct:
              Math.min(
                15,
                Number(
                  bounded
                    .max_bid_decrease_pct
                  || 15
                )
              ),

            max_budget_increase_pct:
              Math.min(
                20,
                Number(
                  bounded
                    .max_budget_increase_pct
                  || 20
                )
              ),

            autonomous_adjustments:true,

            sku_by_sku_review:true,

            require_sku_context:true,

            product_level_objective:
              'generate_profitable_sales_for_every_eligible_sku',

            portfolio_objective:
              'maximize_expected_profit_with_sku_sales_coverage',

            winner_harvest:true,

            same_sku_harvest_required:true,

            zero_delivery_recovery:true,

            kickoff_review:true,

            restock_recovery:true,

            bid_optimization:true,

            budget_optimization:true,

            preserve_hard_guards:true,

            confirmation_required:true,

            no_decision_when_no_safe_alternative:true,

            resolve_blocked_with_alternative:true,

            trigger_type:
              'autonomous_director_v4_canonical_cycle'
          }
        );

      steps.push(canonical);

      /*
       * =========================================
       * 5. RECONCILIAÇÃO
       * =========================================
       */

      steps.push(
        await invoke(
          base44,
          'reconcileProfitBlockedDecisions',
          {
            amazon_account_id:id,
            trigger_type:
              'director_blocked_reconcile'
          }
        )
      );

      steps.push(
        await invoke(
          base44,
          'normalizeV4OperationalPriorities',
          {
            amazon_account_id:id,
            trigger_type:
              'director_normalize'
          }
        )
      );

      /*
       * =========================================
       * 6. EXECUTOR CANÔNICO
       * =========================================
       */

      steps.push(
        await invoke(
          base44,
          'executeApprovedDecisionQueue',
          {
            amazon_account_id:id,
            max_decisions:100,
            expedited:true,
            trigger_type:
              'director_canonical_execution'
          }
        )
      );

      /*
       * =========================================
       * 7. CONFIRMAÇÃO
       * =========================================
       */

      steps.push(
        await invoke(
          base44,
          'confirmExecutedDecisions',
          {
            amazon_account_id:id,
            trigger_type:
              'director_amazon_confirmation'
          }
        )
      );

      /*
       * =========================================
       * 8. AMAZON TRUTH FINAL
       * =========================================
       */

      steps.push(
        await invoke(
          base44,
          'syncAdsCampaignStatesV2',
          {
            amazon_account_id:id,
            trigger_type:
              'director_post_execution_truth'
          }
        )
      );

      results.push({
        amazon_account_id:id,

        ai_available:
          ai.ok,

        portfolio_state:
          strategy?.portfolio_state
          || null,

        priority_count:
          Array.isArray(
            strategy?.priorities
          )
          ? strategy.priorities.length
          : 0,

        ok:
          steps
            .filter(
              s =>
                s.name !==
                'runAutonomousAmazonAdsDirectorAI'
            )
            .every(s=>s.ok),

        steps:
          steps.map(s=>({
            name:s.name,
            ok:s.ok,
            duration_ms:
              s.duration_ms,
            error:
              s.error || null
          }))
      });
    }

    return Response.json({
      ok:
        results.every(
          r=>r.ok
        ),

      persona:
        'Diretor Autônomo de Amazon Ads da LivingFinds',

      persona_version:
        'LIVINGFINDS_AUTONOMOUS_ADS_DIRECTOR_V1',

      openai_frequency:
        '24h',

      direct_openai_amazon_execution:
        false,

      canonical_engine:
        'CANONICAL_PROFIT_ENGINE_V4',

      results
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
