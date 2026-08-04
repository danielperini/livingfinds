import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

/**
 * Orquestrador intradiário canônico:
 * 1. controla o teto global e pausa/retoma campanhas específicas;
 * 2. chama o dayparting somente para o escopo autorizado pelo pacing;
 * 3. sincroniza regras nativas apenas no ciclo diário ou por solicitação explícita.
 */
function brtClock() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((part) => part.type === type)?.value || '';
  return { hour: Number(get('hour') || 0) % 24, minute: Number(get('minute') || 0) };
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

    const internal = { ...body, _service_role: true };
    const pacingResponse = await base44.asServiceRole.functions.invoke('runIntraDayBudgetPacingCycle', internal)
      .catch((error: any) => ({ data: { ok: false, error: error?.message || String(error), actions_executed: 0 } }));
    const pacing = pacingResponse?.data || pacingResponse || {};

    let nativeRules: any = { skipped: true, reason: 'sincronização nativa fora deste ciclo' };
    const clock = brtClock();
    if ((body.sync_native_rules === true || (clock.hour === 0 && clock.minute < 45)) &&
        pacing?.ok !== false && body.dry_run !== true) {
      const response = await base44.asServiceRole.functions.invoke('syncAmazonScheduleBidRules', {
        amazon_account_id: body.amazon_account_id || null,
        _service_role: true,
      }).catch((error: any) => ({ data: { ok: false, error: error?.message || String(error) } }));
      nativeRules = response?.data || response || {};
    }

    let queueReconciliation: any = { skipped: true, reason: 'fila legada não é reconciliada em cada ciclo' };
    if (body.reconcile_legacy_queue === true && body.dry_run !== true) {
      const response = await base44.asServiceRole.functions.invoke('reconcileLegacyDaypartingQueue', internal)
        .catch((error: any) => ({ data: { ok: false, error: error?.message || String(error) } }));
      queueReconciliation = response?.data || response || {};
    }

    let dayparting: any = { skipped: true, reason: 'Pacing não autorizou ações de bid', executed: 0 };
    const eligibleAsins = Array.isArray(pacing?.eligible_asins_for_bid_adjustment)
      ? pacing.eligible_asins_for_bid_adjustment.filter(Boolean)
      : [];
    const pacingState = String(pacing?.spend_pacing || 'unknown');
    // OVERPACING reduz bids primeiro no dayparting canônico; somente o estado
    // crítico pode pausar MANUAL não protegida, nunca AUTO.
    const bidWriteBlockedByOverspend = pacingState === 'critical_overpacing';
    if (pacing?.ok !== false && pacing?.allow_bid_actions === true &&
        !bidWriteBlockedByOverspend && eligibleAsins.length > 0) {
      const response = await base44.asServiceRole.functions.invoke('runCanonicalDaypartingEngine', {
        amazon_account_id: body.amazon_account_id || pacing.amazon_account_id || null,
        eligible_asins: eligibleAsins,
        bid_multiplier_override: pacing.bid_multiplier_override || undefined,
        skip_native_preflight: true,
        skip_queue_preflight: true,
        source_function: 'runIntraDayPacingCycle_portfolio_scope',
        dry_run: body.dry_run === true,
        _service_role: true,
      }).catch((error: any) => ({ data: { ok: false, error: error?.message || String(error), executed: 0 } }));
      dayparting = response?.data || response || {};
    } else if (bidWriteBlockedByOverspend) {
      dayparting = {
        skipped: true,
        reason: 'Critical overpacing: pausas temporárias elegíveis; aumento/restauração de bid bloqueados',
        executed: 0,
      };
    }

    const pacingActions = Number(pacing?.actions_executed || 0);
    const bidActions = Number(dayparting?.executed || 0);
    return Response.json({
      ok: pacing?.ok !== false && dayparting?.ok !== false,
      engine: 'portfolio-intraday-orchestrator-v1',
      actions_executed: pacingActions + bidActions,
      campaign_state_actions_executed: pacingActions,
      bid_actions_executed: bidActions,
      spend_pacing: pacingState,
      pacing_ratio: pacing?.pacing_ratio ?? null,
      daily_cap: pacing?.daily_cap ?? null,
      estimated_current_spend: pacing?.estimated_current_spend ?? null,
      projected_eod: pacing?.projected_eod ?? null,
      pacing,
      dayparting,
      native_rule_sync: nativeRules,
      legacy_queue_reconciliation: queueReconciliation,
      duration_ms: Date.now() - startedAt,
    }, { status: pacing?.ok === false || dayparting?.ok === false ? 500 : 200 });
  } catch (error: any) {
    return Response.json({
      ok: false,
      engine: 'portfolio-intraday-orchestrator-v1',
      actions_executed: 0,
      error: error?.message || 'Falha no ciclo intradiário',
      duration_ms: Date.now() - startedAt,
    }, { status: 500 });
  }
});
