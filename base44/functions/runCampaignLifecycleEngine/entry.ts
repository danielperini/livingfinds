import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

async function invoke(
  base44:any,
  name:string,
  payload:any,
){
  try{
    const response=
      await base44.asServiceRole.functions.invoke(
        name,
        payload
      );

    return {
      ok:true,
      name,
      data:
        response?.data ||
        response ||
        null
    };

  }catch(error:any){

    return {
      ok:false,
      name,
      error:
        error?.message ||
        String(error)
    };
  }
}

Deno.serve(async(req)=>{
  const started=Date.now();

  try{
    const base44=
      createClientFromRequest(req);

    const body=
      await req.json().catch(()=>({}));

    const authenticated=
      await base44.auth
        .isAuthenticated()
        .catch(()=>false);

    if(
      !authenticated
      &&
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

    const common={
      _service_role:true,

      _canonical_orchestrator:
        'runUnifiedDecisionEngine',

      dry_run:
        body.dry_run===true,

      amazon_account_id:
        body.amazon_account_id,

      primary_goal:
        'expected_profit',

      objective:
        'profitability',

      objective_mode:
        'maximize_expected_profit_bounded_loss',

      trigger_type:
        body.trigger_type ||
        'campaign_lifecycle'
    };

    const stages:any[]=[];

    /*
     * ==================================================
     * 1. ZERO DELIVERY / ESTRUTURA
     * ==================================================
     *
     * Todas as campanhas:
     * 72h zero delivery -> +R$0,10
     * máximo 3 vezes -> replace/rebuild
     */
    stages.push(
      await invoke(
        base44,
        'reconcileCampaignDeliveryHealth',
        {
          ...common,

          max_bid_recoveries_per_run:
            body.retroactive
              ? 80
              : 20,

          max_replacements_per_run:
            body.retroactive
              ? 40
              : 10,

          max_structure_repairs_per_run:
            10
        }
      )
    );

    /*
     * ==================================================
     * 2. AUTO DISCOVERY -> HARVEST
     * ==================================================
     *
     * Search terms compradores originados em AUTO.
     *
     * A própria função:
     * - valida same-SKU;
     * - valida ASIN;
     * - valida estoque;
     * - calcula safe CPC;
     * - cria MANUAL EXACT;
     * - negativa a origem quando aplicável.
     */
    stages.push(
      await invoke(
        base44,
        'runImmediateSameSkuSearchTermHarvest',
        {
          ...common,

          source_campaign_type:
            'AUTO',

          lookback_days:
            65,

          max_promotions:
            body.retroactive
              ? 50
              : 25
        }
      )
    );

    /*
     * ==================================================
     * 3. MANUAL -> MANUAL EXACT
     * ==================================================
     *
     * MANUAL broad/phrase também podem descobrir
     * queries vencedoras.
     */
    stages.push(
      await invoke(
        base44,
        'runImmediateSameSkuSearchTermHarvest',
        {
          ...common,

          source_campaign_type:
            'MANUAL',

          lookback_days:
            65,

          max_promotions:
            body.retroactive
              ? 50
              : 25
        }
      )
    );

    /*
     * ==================================================
     * 4. WASTE
     * ==================================================
     *
     * Gasto/cliques sem vendas:
     * redução -> redução -> pausa.
     */
    stages.push(
      await invoke(
        base44,
        'runSalesModeWasteRotation',
        common
      )
    );

    /*
     * ==================================================
     * 5. CRESCIMENTO POR PERFORMANCE
     * ==================================================
     *
     * Cada campanha cresce pela própria economia.
     * Share do ASIN não é teto de budget.
     */
    stages.push(
      await invoke(
        base44,
        'runAsinPortfolioDiversificationGuard',
        common
      )
    );

    /*
     * ==================================================
     * 6. RECOVERY COMPETITIVO
     * ==================================================
     */
    stages.push(
      await invoke(
        base44,
        'runIntradaySalesRecovery',
        common
      )
    );

    return Response.json({
      ok:
        stages.every(
          x=>x.ok!==false
        ),

      engine:
        'CAMPAIGN_LIFECYCLE_ENGINE_V2',

      primary_goal:
        'MAXIMIZE_EXPECTED_PROFIT_BOUNDED_LOSS',

      journeys:{

        auto:[
          'NEW_ASIN',
          'AUTO_CREATED',
          'AUTO_DISCOVERY',
          'AUTO_HARVEST_READY',
          'MANUAL_EXACT_CREATED',
          'MANUAL_EXACT_LEARNING',
          'HEALTHY_OR_WINNER',
          'SCALE_OR_WASTE_CONTROL'
        ],

        manual:[
          'NEW',
          'INITIAL_LEARNING',
          'DELIVERY_LEARNING',
          'HEALTHY_OR_WINNER',
          'SCALE_OR_WASTE_CONTROL'
        ],

        zero_delivery:[
          'WAIT_72H',
          'BID_PLUS_0_10',
          'BID_PLUS_0_10',
          'BID_PLUS_0_10',
          'REPLACE_REBUILD'
        ]
      },

      stages,

      duration_ms:
        Date.now()-started
    });

  }catch(error:any){

    return Response.json(
      {
        ok:false,

        engine:
          'CAMPAIGN_LIFECYCLE_ENGINE_V2',

        error:
          error?.message ||
          String(error)
      },
      {status:500}
    );
  }
});
