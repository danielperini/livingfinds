import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const ACCOUNT_LIMIT = 50;

async function invoke(
  base44: any,
  functionName: string,
  payload: Record<string, any>,
) {
  const started = Date.now();

  try {
    const response = await base44.asServiceRole.functions.invoke(
      functionName,
      {
        ...payload,
        _service_role: true,
      },
    );

    const data = response?.data || response || {};

    return {
      function: functionName,
      ok: data?.ok !== false,
      duration_ms: Date.now() - started,
      data,
    };
  } catch (error: any) {
    return {
      function: functionName,
      ok: false,
      duration_ms: Date.now() - started,
      error: error?.message || String(error),
    };
  }
}

Deno.serve(async (request) => {
  const startedAt = new Date().toISOString();

  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));

    const authenticated =
      await base44.auth.isAuthenticated().catch(() => false);

    if (!authenticated && !body._service_role) {
      return Response.json(
        { ok: false, error: 'Não autorizado' },
        { status: 401 },
      );
    }

    const accounts = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({
          id: body.amazon_account_id,
        })
      : await base44.asServiceRole.entities.AmazonAccount.filter({
          status: 'connected',
        }, '-updated_date', ACCOUNT_LIMIT);

    const results: any[] = [];

    for (const account of accounts as any[]) {
      const accountId = account.id;
      const steps: any[] = [];

      /*
       * ETAPA 1
       * AMAZON TRUTH antes de qualquer raciocínio da IA.
       */

      steps.push(await invoke(
        base44,
        'syncProductCatalogV2',
        {
          amazon_account_id: accountId,
          trigger_type: 'daily_ai_preflight_catalog',
        },
      ));

      steps.push(await invoke(
        base44,
        'syncAmazonOfferAvailability',
        {
          amazon_account_id: accountId,
          max_products: 500,
          trigger_type: 'daily_ai_preflight_inventory_buyability',
        },
      ));

      steps.push(await invoke(
        base44,
        'syncAdsCampaignStatesV2',
        {
          amazon_account_id: accountId,
          trigger_type: 'daily_ai_preflight_campaign_truth',
        },
      ));

      steps.push(await invoke(
        base44,
        'syncAmazonIntradayCampaignMetrics',
        {
          amazon_account_id: accountId,
          action: 'auto',
          trigger_type: 'daily_ai_preflight_metrics',
        },
      ));

      /*
       * ETAPA 2
       * UMA ÚNICA ANÁLISE OPENAI PROFUNDA A CADA 24 HORAS.
       *
       * O V4 recebe:
       * - produtos ativos
       * - estoque
       * - buyability
       * - campanhas
       * - métricas
       * - winners
       * - bids
       * - budgets
       * - search terms
       * - harvesting
       * - blocked decisions
       * - filas
       * - histórico
       *
       * A IA NÃO executa Amazon diretamente.
       * Tudo continua sujeito ao V4 e hard guards.
       */

      steps.push(await invoke(
        base44,
        'runCanonicalDecisionCycle',
        {
          amazon_account_id: accountId,

          dry_run: false,

          daily_ai_review: true,
          weekly_ai_review: true,
          autonomous_adjustments: true,

          force: true,
          force_full_scan: true,

          review_window_days: 7,
          comparison_window_days: 30,

          objective: 'maximize_expected_profit',
          secondary_objective:
            'sales_growth_with_positive_incremental_expected_profit',

          product_level_objective:
            'generate_profitable_sales_for_every_eligible_sku',

          portfolio_objective:
            'maximize_expected_profit_with_sku_sales_coverage',

          sku_by_sku_review: true,
          require_sku_context: true,

          review_existing_campaigns: true,
          include_paused_campaign_history: true,
          retroactive: true,

          /*
           * PRODUTOS SEM COBERTURA
           */
          kickoff_review: true,
          create_missing_campaign_coverage: true,

          /*
           * SEARCH TERMS / HARVEST
           */
          winner_harvest: true,
          same_sku_harvest_required: true,
          max_terms_per_asin: 20,

          /*
           * OTIMIZAÇÃO
           */
          bid_optimization: true,
          budget_optimization: true,
          zero_delivery_recovery: true,
          auto_spend_control: true,

          /*
           * CAMPANHAS
           */
          campaign_rebuild: true,
          campaign_replacement: true,
          restock_recovery: true,

          /*
           * ESTOQUE / BUYABILITY
           */
          amazon_inventory_truth_required: true,
          amazon_buyability_truth_required: true,
          pause_out_of_stock_campaigns: true,
          pause_not_buyable_campaigns: true,
          reactivate_after_restock_review: true,

          /*
           * GOVERNANÇA
           */
          contradiction_recovery: true,
          resolve_blocked_with_alternative: true,

          blocked_decision_visibility: 'internal',

          no_decision_when_no_safe_alternative: true,

          preserve_hard_guards: true,
          confirmation_required: true,

          trigger_type:
            'openai_daily_autonomous_portfolio_director_v4',
        },
      ));

      /*
       * ETAPA 3
       * DRENAR KICKOFF GERADO POR PRODUTOS ELEGÍVEIS.
       */

      steps.push(await invoke(
        base44,
        'processProductKickoffQueueV2',
        {
          amazon_account_id: accountId,
          max_items: 20,
          trigger_type: 'daily_ai_kickoff_drain',
        },
      ));

      /*
       * ETAPA 4
       * REMOVER BLOQUEIOS SOFT E NORMALIZAR PRIORIDADES.
       */

      steps.push(await invoke(
        base44,
        'reconcileProfitBlockedDecisions',
        {
          amazon_account_id: accountId,
          trigger_type: 'daily_ai_blocked_reconciliation',
        },
      ));

      steps.push(await invoke(
        base44,
        'normalizeV4OperationalPriorities',
        {
          amazon_account_id: accountId,
          trigger_type: 'daily_ai_priority_normalization',
        },
      ));

      /*
       * ETAPA 5
       * EXECUÇÃO CANÔNICA.
       */

      steps.push(await invoke(
        base44,
        'executeApprovedDecisionQueue',
        {
          amazon_account_id: accountId,
          max_decisions: 100,
          expedited: true,
          trigger_type: 'daily_ai_canonical_execution',
        },
      ));

      /*
       * ETAPA 6
       * CONFIRMAÇÃO AMAZON.
       */

      steps.push(await invoke(
        base44,
        'confirmExecutedDecisions',
        {
          amazon_account_id: accountId,
          trigger_type: 'daily_ai_remote_confirmation',
        },
      ));

      /*
       * ETAPA 7
       * AMAZON TRUTH NOVAMENTE.
       */

      steps.push(await invoke(
        base44,
        'syncAdsCampaignStatesV2',
        {
          amazon_account_id: accountId,
          trigger_type: 'daily_ai_post_execution_remote_truth',
        },
      ));

      const failures =
        steps.filter((step: any) => !step.ok);

      results.push({
        amazon_account_id: accountId,
        ok: failures.length === 0,
        steps,
      });

      await base44.asServiceRole.entities.SyncExecutionLog.create({
        amazon_account_id: accountId,
        operation: 'openai_daily_portfolio_director_v4',
        status: failures.length ? 'error' : 'success',
        trigger_type:
          'openai_daily_autonomous_portfolio_director_v4',
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        records_processed:
          steps.filter((step: any) => step.ok).length,
        result_summary: JSON.stringify({
          steps: steps.map((step: any) => ({
            function: step.function,
            ok: step.ok,
            duration_ms: step.duration_ms,
          })),
        }).slice(0, 4000),
        error_message: failures.length
          ? failures
              .map((step: any) =>
                `${step.function}: ${step.error || 'falha'}`
              )
              .join(' | ')
              .slice(0, 1000)
          : null,
      }).catch(() => {});
    }

    return Response.json({
      ok: results.every((result) => result.ok),
      engine: 'CANONICAL_PROFIT_ENGINE_V4',
      ai_frequency: '24h',
      amazon_truth_before_ai: true,
      direct_ai_amazon_mutation: false,
      completed_at: new Date().toISOString(),
      results,
    });
  } catch (error: any) {
    return Response.json(
      {
        ok: false,
        error: error?.message || String(error),
        started_at: startedAt,
      },
      { status: 500 },
    );
  }
});
