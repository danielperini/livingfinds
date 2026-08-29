import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

async function invoke(
  base44: any,
  functionName: string,
  payload: Record<string, any>,
) {
  const started = Date.now();

  try {
    const response =
      await base44.asServiceRole.functions.invoke(
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
        });

    const results: any[] = [];

    for (const account of accounts as any[]) {
      const id = account.id;
      const steps: any[] = [];

      /*
       * SEM OPENAI.
       *
       * Atualiza estoque e buyability para que o V4
       * possa agir rapidamente quando estoque muda.
       */

      steps.push(await invoke(
        base44,
        'syncAmazonOfferAvailability',
        {
          amazon_account_id: id,
          max_products: 500,
          trigger_type: 'v4_watchdog_inventory',
        },
      ));

      /*
       * Filas que ficaram paradas.
       */

      steps.push(await invoke(
        base44,
        'reconcileOperationalQueues',
        {
          amazon_account_id: id,
          dry_run: false,
          trigger_type: 'v4_watchdog_queues',
        },
      ));

      /*
       * Decisões bloqueadas:
       * hard guard continua bloqueado;
       * soft block deve ser recalculado/cancelado.
       */

      steps.push(await invoke(
        base44,
        'reconcileProfitBlockedDecisions',
        {
          amazon_account_id: id,
          trigger_type: 'v4_watchdog_blocked',
        },
      ));

      /*
       * Kickoffs já aprovados não ficam esquecidos.
       */

      steps.push(await invoke(
        base44,
        'processProductKickoffQueueV2',
        {
          amazon_account_id: id,
          max_items: 5,
          trigger_type: 'v4_watchdog_kickoff',
        },
      ));

      /*
       * Confirmações Amazon que estejam aguardando.
       */

      steps.push(await invoke(
        base44,
        'confirmExecutedDecisions',
        {
          amazon_account_id: id,
          trigger_type: 'v4_watchdog_confirmation',
        },
      ));

      /*
       * Sincronizar estado remoto das campanhas.
       */

      steps.push(await invoke(
        base44,
        'syncAdsCampaignStatesV2',
        {
          amazon_account_id: id,
          trigger_type: 'v4_watchdog_remote_truth',
        },
      ));

      /*
       * Auditoria operacional.
       */

      steps.push(await invoke(
        base44,
        'auditAdsAutomationE2E',
        {
          amazon_account_id: id,
          trigger_type: 'v4_watchdog_e2e',
        },
      ));

      results.push({
        amazon_account_id: id,
        ok: steps.every((step: any) => step.ok),
        steps,
      });
    }

    return Response.json({
      ok: results.every((result) => result.ok),
      ai_used: false,
      watchdog: 'V4_4H',
      results,
    });
  } catch (error: any) {
    return Response.json(
      {
        ok: false,
        error: error?.message || String(error),
      },
      { status: 500 },
    );
  }
});
