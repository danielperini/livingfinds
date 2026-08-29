import {
  createClientFromRequest
} from 'npm:@base44/sdk@0.8.40';

const POLICY_VERSION =
  'PROFIT_ENGINE_V4';

const DECISION_OWNER =
  'CANONICAL_PROFIT_ENGINE_V4';

async function invoke(
  base44:any,
  name:string,
  payload:Record<string,unknown>,
){
  try{
    const response =
      await base44
        .asServiceRole
        .functions
        .invoke(
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
        error?.response?.data?.error ||
        error?.message ||
        String(error)
    };
  }
}

Deno.serve(async(request)=>{

  const startedAt =
    Date.now();

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
     * Uma avaliação completa recebe um único
     * correlationId. Todos os produtores de
     * evidência pertencem ao mesmo ciclo.
     */
    const correlationId =
      String(
        body.correlation_id ||
        crypto.randomUUID()
      );

    const cycleStartedAt =
      new Date().toISOString();

    const common:any = {
      ...body,

      _service_role:true,

      correlation_id:
        correlationId,

      policy_version:
        POLICY_VERSION,

      decision_owner:
        DECISION_OWNER,

      primary_goal:
        'expected_profit',

      objective:
        'profitability',

      objective_mode:
        'maximize_expected_profit_bounded_loss',

      canonical_engine:
        true,

      canonical_cycle_started_at:
        cycleStartedAt,

      /*
       * Nenhum submotor é owner da execução.
       */
      execution_owner:
        'executeApprovedDecisionQueue',

      confirmation_owner:
        'confirmExecutedDecisions',
    };

    const stages:any[]=[];

    /*
     * =================================================
     * 1. EVIDÊNCIA ECONÔMICA
     * =================================================
     */
    stages.push(
      await invoke(
        base44,
        'runEconomicEvidenceDecisionPolicy',
        {
          ...common,

          dry_run:
            body.dry_run===true,

          max_candidates:
            body.max_economic_evidence_candidates
            ?? 500,

          trigger_type:
            body.trigger_type ||
            'profit_engine_v3'
        }
      )
    );

    /*
     * =================================================
     * 2. LIFECYCLE
     * =================================================
     *
     * Preferimos a jornada nova.
     *
     * Se ainda não estiver carregada no registry,
     * usamos temporariamente o Unified Engine,
     * mas SEM dar a ele execução própria.
     */
    let lifecycle =
      await invoke(
        base44,
        'runCampaignLifecycleEngine',
        {
          ...common,

          dry_run:
            body.dry_run===true,

          retroactive:
            body.retroactive===true,

          force_full_scan:
            body.force_full_scan===true,

          trigger_type:
            body.trigger_type ||
            'profit_engine_v3_lifecycle'
        }
      );

    if(
      lifecycle.ok===false &&
      String(
        lifecycle.error || ''
      ).toLowerCase()
       .includes('não encontrada')
    ){
      lifecycle =
        await invoke(
          base44,
          'runUnifiedDecisionEngine',
          {
            ...common,

            dry_run:
              body.dry_run===true,

            _canonical_orchestrator:
              'runCanonicalProfitEngineV3',

            trigger_type:
              body.trigger_type ||
              'profit_engine_v3_fallback'
          }
        );
    }

    stages.push(lifecycle);


    /*
     * =================================================
     * 2.5 GERADOR CANÔNICO DE DECISÕES EXECUTÁVEIS
     * =================================================
     *
     * O deterministic engine deixa de ser um motor
     * independente.
     *
     * Ele existe somente como proposal generator
     * INVOCADO PELO PROFIT ENGINE V3.
     *
     * Seu scheduler próprio permanece desativado.
     *
     * Essa etapa fecha:
     *
     * metrics
     * -> V3
     * -> OptimizationDecision
     * -> canonical queue
     * -> Amazon
     */
    const deterministic =
      await invoke(
        base44,
        'runDeterministicDecisionEngine',
        {
          ...common,

          _canonical_orchestrator:
            'runCanonicalProfitEngineV3',

          canonical_engine:
            true,

          policy_version:
            POLICY_VERSION,

          decision_owner:
            DECISION_OWNER,

          trigger_type:
            'canonical_deterministic_proposals',

          force:
            body.force === true ||
            body.force_full_scan === true,

          force_full_scan:
            body.force_full_scan === true,

          retroactive:
            body.retroactive === true,

          review_existing_campaigns:
            body.review_existing_campaigns === true,

          dry_run:
            body.dry_run === true
        }
      );

    stages.push(
      deterministic
    );


    /*
     * =================================================
     * WEEKLY AI REVIEW — INTERNAL V3 STAGE
     * =================================================
     *
     * NÃO é um segundo motor.
     *
     * runCanonicalWeeklyDecisionReview permanece sem
     * scheduler próprio e só pode ser disparado pelo
     * CANONICAL_PROFIT_ENGINE_V3.
     *
     * Objetivo:
     * 1. maximizar lucro esperado;
     * 2. aumentar vendas somente quando houver
     *    lucro incremental esperado positivo;
     * 3. revisar thresholds/parâmetros semanalmente;
     * 4. preservar hard guards absolutos.
     */
    const weeklyAiReviewRequested =
      body.weekly_ai_review === true ||
      String(body.trigger_type || '')
        .toLowerCase()
        .includes('weekly_ai_review');

    if (weeklyAiReviewRequested) {

      const weeklyReview =
        await invoke(
          base44,
          'runCanonicalWeeklyDecisionReview',
          {
            ...common,

            _service_role: true,

            _canonical_orchestrator:
              'runCanonicalProfitEngineV3',

            canonical_engine:
              DECISION_OWNER,

            decision_owner:
              DECISION_OWNER,

            policy_version:
              POLICY_VERSION,

            weekly_ai_review: true,

            weekly_ai_review_internal: true,

            autonomous_adjustments: true,

            objective:
              'maximize_expected_profit',

            secondary_objective:
              'sales_growth_with_positive_incremental_expected_profit',

            review_window_days: 7,

            comparison_window_days: 30,

            apply_safe_parameter_updates: true,

            review_existing_campaigns: true,

            retroactive: true,

            force_full_scan: true,

            /*
             * A rotina semanal pode ajustar parâmetros,
             * mas NÃO ganha um caminho direto para Amazon.
             * Qualquer decisão Ads volta ao V3/fila.
             */
            direct_amazon_execution: false,

            preserve_hard_guards: true,

            immutable_guards: [
              'ACCOUNT_KILL_SWITCH',
              'ACCOUNT_DAILY_CAP',
              'SAFE_CPC_CEILING',
              'OUT_OF_STOCK',
              'NOT_BUYABLE',
              'LISTING_INACTIVE',
              'OFFER_INACTIVE',
              'WINNER_PROTECTION',
              'AMAZON_CONFIRMATION'
            ],

            trigger_type:
              'weekly_ai_review_internal'
          }
        );

      stages.push(
        weeklyReview
      );
    }


    /*
     * =================================================
     * SKU-BY-SKU PORTFOLIO REVIEW — INTERNAL V3
     * =================================================
     *
     * Cada SKU elegível recebe avaliação própria.
     *
     * O lucro global não pode esconder um SKU sem:
     * - vendas;
     * - cobertura;
     * - impressões;
     * - campanha;
     * - investimento adequado;
     * - winner harvesting.
     */
    if(
      body.skip_sku_portfolio_review !== true
    ){

      const skuPortfolio =
        await invoke(
          base44,
          'runV3SkuPortfolioReview',
          {
            ...common,

            _service_role:true,

            execute_actions:true,

            reenter_v3:false,

            canonical_engine:
              DECISION_OWNER,

            policy_version:
              POLICY_VERSION,

            trigger_type:
              'v3_sku_portfolio_internal'
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

      stages.push(
        skuPortfolio
      );
    }

    /*
     * =================================================
     * 3. RECONCILIAR PROPOSTAS
     * =================================================
     */
    const reconciliation =
      body.dry_run===true

      ? {
          ok:true,
          skipped:true,
          reason:'dry_run'
        }

      : await invoke(
          base44,
          'reconcileEconomicEvidenceDecisions',
          {
            ...common,

            since:
              cycleStartedAt,

            trigger_type:
              'profit_v3_pre_execution_reconciliation'
          }
        );

    stages.push(reconciliation);

    /*
     * =================================================
     * 4. ARBITRAR CONFLITOS
     * =================================================
     *
     * Regra estrutural:
     *
     * N sinais
     * ->
     * UMA mutação líquida por entidade.
     */
    const arbitration =
      body.dry_run===true

      ? {
          ok:true,
          skipped:true,
          reason:'dry_run'
        }

      : await invoke(
          base44,
          'arbitrateCanonicalDecisionConflicts',
          {
            ...common,

            since:
              cycleStartedAt,

            trigger_type:
              'profit_v3_pre_execution_arbitration'
          }
        );

    stages.push(arbitration);

    const ok =
      stages.every(
        (stage:any)=>
          stage?.ok!==false
      );


    /*
     * =================================================
     * AUTONOMOUS CONTRADICTION RESOLVER — INTERNAL V3
     * =================================================
     *
     * Não é outro motor.
     *
     * Detecta propostas PAUSE incoerentes com:
     * - winner protection;
     * - zero delivery;
     *
     * reclassifica-as como internas/SUPERSEDED e pede
     * nova avaliação ao gateway canônico.
     */
    if(
      body.skip_contradiction_resolver !== true
    ){
      const contradictionResolution =
        await invoke(
          base44,
          'runV3DecisionContradictionResolver',
          {
            ...common,

            _service_role:true,

            lookback_minutes:180,

            reenter_v3:true,

            canonical_engine:
              DECISION_OWNER,

            policy_version:
              POLICY_VERSION,

            trigger_type:
              'v3_contradiction_resolver_internal'
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

      stages.push(
        contradictionResolution
      );
    }

    
      /*
       * ===================================================
       * V3_YOUNG_LEARNING_SAFE_INTEGRATION
       * ===================================================
       *
       * Subrotina do CANONICAL_PROFIT_ENGINE_V3.
       *
       * Não possui scheduler próprio.
       *
       * É executada depois da análise econômica principal
       * e antes da resposta final do Profit Engine.
       *
       * NEW/YOUNG:
       * - foco temporário também em aquisição de impressões;
       * - CPC permitido até 115% do target CPC;
       * - safe CPC continua teto absoluto.
       *
       * MATURING:
       * - tolerância cai para 107,5%.
       *
       * MATURE:
       * - política econômica normal.
       */
      const youngCampaignLearning =
        await base44
          .asServiceRole
          .functions
          .invoke(
            'runV3YoungCampaignLearningReview',
            {
              _service_role: true,

              amazon_account_id:
                body?.amazon_account_id ||
                undefined,

              trigger_type:
                body?.trigger_type ||
                'canonical_profit_engine_v3',

              correlation_id:
                body?.correlation_id ||
                undefined,
            }
          )
          .catch((error: any) => ({
            data: {
              ok: false,
              error:
                error?.message ||
                String(error),
            },
          }));

return Response.json({
      ok,

      engine:
        DECISION_OWNER,

      policy_version:
        POLICY_VERSION,

      decision_owner:
        DECISION_OWNER,

      correlation_id:
        correlationId,

      trigger_type:
        body.trigger_type ||
        null,

      retroactive:
        body.retroactive===true,

      force_full_scan:
        body.force_full_scan===true,

      decision_contract:
        [
          'metrics',
          'lifecycle',
          'signals',
          'economic evidence',
          'preflight',
          'canonical arbiter',
          'ONE net mutation per entity/cycle',
          'executeApprovedDecisionQueue',
          'Amazon',
          'confirmExecutedDecisions'
        ].join(' -> '),

      unique_decision_engine:true,

      duplicate_executor:false,

      execution_owner:
        'executeApprovedDecisionQueue',

      confirmation_owner:
        'confirmExecutedDecisions',

      stages,

      duration_ms:
        Date.now()-startedAt
    });

  }catch(error:any){

    return Response.json(
      {
        ok:false,

        engine:
          DECISION_OWNER,

        policy_version:
          POLICY_VERSION,

        error:
          error?.message ||
          String(error),

        duration_ms:
          Date.now()-startedAt
      },
      {
        status:500
      }
    );
  }
});
