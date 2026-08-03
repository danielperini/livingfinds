/**
 * Harvest canônico:
 * 1. importa termos convertidos das campanhas AUTO;
 * 2. reclassifica KeywordBank e gera planos;
 * 3. aplica os guardrails semanais de relevância, cauda e saturação;
 * 4. enfileira campanhas MANUAL EXACT no ProductKickoffQueue.
 *
 * A origem AUTO só é negativada depois de uma promoção confirmada por um fluxo
 * específico. Este entrypoint nunca negativa antes da campanha manual existir.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

function data(response: any) {
  return response?.data || response || {};
}

Deno.serve(async (request) => {
  const startedAt = Date.now();
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    if (!body._service_role) {
      const user = await base44.auth.me().catch(() => null);
      if (!user) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    const accounts = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter(
        { id: body.amazon_account_id }, null, 1,
      )
      : await base44.asServiceRole.entities.AmazonAccount.filter(
        { status: 'connected' }, '-updated_at', 1,
      );
    const account = accounts[0];
    if (!account) {
      return Response.json({ ok: false, error: 'Nenhuma conta Amazon conectada' }, { status: 404 });
    }

    const payload = {
      amazon_account_id: account.id,
      _service_role: true,
    };
    const termBankResponse = await base44.asServiceRole.functions.invoke(
      'runImmediateSameSkuSearchTermHarvest',
      {
        ...payload,
        dry_run: body.dry_run === true,
        max_promotions: Math.max(1, Math.min(50, Number(body.max_promotions || 25))),
        lookback_days: Math.max(1, Math.min(65, Number(body.lookback_days || 65))),
        trigger_type: body.trigger_type || 'daily_unified_harvest',
      },
    );
    const termBank = data(termBankResponse);
    if (termBank.ok === false) {
      return Response.json({
        ok: false,
        stage: 'term_bank',
        error: termBank.error || termBank.reason || 'Falha ao importar termos AUTO/MANUAL',
        term_bank: termBank,
      }, { status: 500 });
    }

    const factoryResponse = await base44.asServiceRole.functions.invoke(
      'runCampaignFactory',
      payload,
    );
    const factory = data(factoryResponse);
    if (factory.ok === false) {
      return Response.json({
        ok: false,
        stage: 'campaign_factory',
        error: factory.error || 'Falha ao classificar termos do Factory',
        term_bank: termBank,
        campaign_factory: factory,
      }, { status: 500 });
    }

    const launchResponse = await base44.asServiceRole.functions.invoke(
      'scheduleWeeklyCampaignFactoryLaunches',
      {
        ...payload,
        max_campaigns: Math.max(1, Math.min(10, Number(body.max_campaigns || 10))),
        dry_run: body.dry_run === true,
        trigger_type: body.trigger_type || 'harvest_converted_search_terms',
      },
    );
    const launches = data(launchResponse);
    const scheduled = (launches.reports || []).reduce(
      (sum: number, report: any) => sum + Number(report.scheduled || 0),
      0,
    );

    return Response.json({
      ok: launches.ok !== false,
      harvested: scheduled,
      scheduled,
      safe_cutoff: 'guardado pelo relatório fechado e pelo ciclo semanal',
      term_bank: termBank,
      campaign_factory: {
        terms_processed: factory.terms_processed || 0,
        bank_created: factory.bank_created || 0,
        bank_updated: factory.bank_updated || 0,
        winners: factory.summary?.winners || 0,
        harvest_ready: factory.summary?.harvest_ready || 0,
        plans_created: factory.plans_created || 0,
      },
      launches,
      premature_negative_targeting: false,
      duration_ms: Date.now() - startedAt,
    }, { status: launches.ok === false ? 500 : 200 });
  } catch (error: any) {
    return Response.json({
      ok: false,
      error: error?.message || String(error),
      duration_ms: Date.now() - startedAt,
    }, { status: 500 });
  }
});
