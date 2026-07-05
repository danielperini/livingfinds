/**
 * runHourlyAdsGuardrails — Proteções operacionais executadas a cada hora.
 *
 * O que verifica:
 *  - estoque zero → pausar campanha
 *  - gasto anormal (> 200% do ritmo esperado) → alerta
 *  - orçamento próximo do limite global → alerta
 *  - orçamento esgotado antes do horário forte → alerta
 *  - runs travados > 60 min → liberar
 *  - sync travado > 30 min → liberar
 *  - confirmar ações Amazon ainda não verificadas
 *
 * O que NÃO faz:
 *  - recalcular estratégia completa
 *  - aumentar bids
 *  - negativar termos
 *  - criar campanhas
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
// Guardrails são 100% locais — sem chamadas de API externa aqui.
// Token e profiles são validados apenas no pipeline diário.

Deno.serve(async (req) => {
  const startTime = Date.now();
  const base44 = createClientFromRequest(req);
  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  const currentHour = new Date().getUTCHours();

  try {
    const body = await req.json().catch(() => ({}));

    // Resolver conta
    let account = null;
    const amazonAccountId = body.amazon_account_id;
    if (amazonAccountId) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: amazonAccountId });
      account = accs[0] || null;
    } else {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      account = accs[0] || null;
    }
    if (!account) return Response.json({ ok: true, skipped: true, reason: 'Nenhuma conta conectada' });

    const aid = account.id;
    const currencySymbol = account.currency_symbol || 'R$';

    // Buscar configuração
    const configs = await base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: aid });
    const cfg = configs[0] || {};
    if (cfg.enabled === false) return Response.json({ ok: true, skipped: true, reason: 'Autopilot desabilitado' });

    // Limite diário global: prioridade AutopilotConfig > AmazonAccount.max_daily_budget_limit
    const globalBudgetLimit = cfg.total_daily_budget || cfg.daily_budget_limit || account.max_daily_budget_limit || 0;
    const actions = [];
    const alerts = [];

    // ── 1. Liberar locks travados ──────────────────────────────────────────
    const stuckRuns = await base44.asServiceRole.entities.AutopilotRun.filter(
      { amazon_account_id: aid, status: 'running' }, '-started_at', 5
    );
    for (const r of stuckRuns) {
      const ageMin = (Date.now() - new Date(r.started_at).getTime()) / 60000;
      if (ageMin > 60) {
        await base44.asServiceRole.entities.AutopilotRun.update(r.id, {
          status: 'failed',
          completed_at: now,
          error_message: `Hourly guardrail: lock liberado após ${Math.round(ageMin)} min`,
        });
        actions.push({ type: 'unlock_run', run_id: r.id, age_minutes: Math.round(ageMin) });
      }
    }

    const stuckSyncs = await base44.asServiceRole.entities.SyncExecutionLog.filter(
      { amazon_account_id: aid, status: 'started' }, '-started_at', 5
    );
    for (const s of stuckSyncs) {
      const ageMin = (Date.now() - new Date(s.started_at).getTime()) / 60000;
      if (ageMin > 30) {
        await base44.asServiceRole.entities.SyncExecutionLog.update(s.id, {
          status: 'error',
          completed_at: now,
          error_message: `Hourly guardrail: sync lock liberado após ${Math.round(ageMin)} min`,
        });
        actions.push({ type: 'unlock_sync', sync_id: s.id, age_minutes: Math.round(ageMin) });
      }
    }

    // ── 2. Estoque zero → pausar ───────────────────────────────────────────
    if (cfg.auto_pause_zero_stock !== false) {
      const activeCampaigns = await base44.asServiceRole.entities.Campaign.filter(
        { amazon_account_id: aid, state: 'enabled' }, null, 500
      );
      const products = await base44.asServiceRole.entities.Product.filter(
        { amazon_account_id: aid, inventory_status: 'out_of_stock' }, null, 200
      );
      const oosByAsin = new Set(products.map(p => p.asin).filter(Boolean));

      for (const c of activeCampaigns) {
        if (!c.asin || !oosByAsin.has(c.asin)) continue;

        // Verificar se já existe decisão de pausa pendente/executada hoje
        const existingPause = await base44.asServiceRole.entities.OptimizationDecision.filter({
          amazon_account_id: aid,
          campaign_id: c.campaign_id,
          action: 'pause_campaign',
          status: 'approved',
        }, '-created_at', 1);
        if (existingPause.length > 0) continue;

        // Criar decisão de pausa de alta prioridade
        await base44.asServiceRole.entities.OptimizationDecision.create({
          amazon_account_id: aid,
          decision_type: 'pause',
          entity_type: 'campaign',
          entity_id: c.campaign_id,
          campaign_id: c.campaign_id,
          asin: c.asin,
          action: 'pause_campaign',
          rationale: `GUARDRAIL HORÁRIO: Produto ${c.asin} com estoque zero. Pausar imediatamente para evitar gasto desnecessário.`,
          data_used: `inventory_status=out_of_stock, detected_at=${now}`,
          risk: 'low',
          requires_approval: false,
          status: 'approved',
          confidence: 95,
          country_code: account.country_code || 'BR',
          currency_code: account.currency_code || 'BRL',
          currency_symbol: currencySymbol,
          idempotency_key: `${aid}|guardrail_pause|${c.campaign_id}|${today}`,
          source_function: 'runHourlyAdsGuardrails',
          created_at: now,
          evaluation_due_at: null,
        });
        actions.push({ type: 'pause_oos_campaign', campaign_id: c.campaign_id, asin: c.asin });
      }
    }

    // ── 3. Gasto anormal ───────────────────────────────────────────────────
    // Ritmo esperado: (hora atual + 1) / 24 * budget diário
    // Se gasto > 200% do ritmo esperado → alerta crítico
    if (globalBudgetLimit > 0) {
      const totalSpentToday = await base44.asServiceRole.entities.Campaign.filter(
        { amazon_account_id: aid }, null, 500
      );
      const totalSpend = totalSpentToday.reduce((s, c) => s + (c.current_spend || c.spend || 0), 0);
      const expectedRatio = (currentHour + 1) / 24;
      const expectedSpend = globalBudgetLimit * expectedRatio;

      if (totalSpend > expectedSpend * 2.0 && totalSpend > 10) {
        // Verificar se já existe alerta de gasto anormal hoje
        const existingAlert = await base44.asServiceRole.entities.Alert.filter({
          amazon_account_id: aid,
          alert_type: 'rate_limit',
          status: 'active',
        }, '-created_at', 1);

        if (existingAlert.length === 0) {
          await base44.asServiceRole.entities.Alert.create({
            amazon_account_id: aid,
            alert_type: 'rate_limit',
            severity: 'critical',
            title: 'Gasto anormal detectado',
            message: `Gasto acumulado ${currencySymbol}${totalSpend.toFixed(2)} é ${((totalSpend / expectedSpend - 1) * 100).toFixed(0)}% acima do esperado para as ${currentHour}h. Limite global: ${currencySymbol}${globalBudgetLimit.toFixed(2)}/dia.`,
            entity_type: 'account',
            status: 'active',
            current_value: totalSpend,
            threshold_value: expectedSpend,
            created_at: now,
          });
          alerts.push({ type: 'abnormal_spend', spend: totalSpend, expected: expectedSpend });
        }
      }

      // Orçamento esgotado antes das 18h (horário local relevante)
      // Horas fortes típicas: 18-22 BRT = 21-01 UTC
      const isBrazilPeakAhead = currentHour < 21; // UTC — ainda não chegou no pico
      if (isBrazilPeakAhead && totalSpend > globalBudgetLimit * 0.90) {
        await base44.asServiceRole.entities.Alert.create({
          amazon_account_id: aid,
          alert_type: 'budget_exhausted',
          severity: 'high',
          title: 'Orçamento próximo do limite antes do horário forte',
          message: `${currencySymbol}${totalSpend.toFixed(2)} de ${currencySymbol}${globalBudgetLimit.toFixed(2)} gastos. Horário forte (18h–22h BRT) ainda não começou.`,
          entity_type: 'account',
          status: 'active',
          current_value: totalSpend,
          threshold_value: globalBudgetLimit,
          created_at: now,
        }).catch(() => {}); // silenciar se já existe
        alerts.push({ type: 'budget_exhausted_before_peak', spend: totalSpend });
      }
    }

    // ── 4. Ações Amazon não confirmadas ───────────────────────────────────
    // Decisões executadas mas sem amazon_response válido nas últimas 4h
    const unconfirmedCutoff = new Date(Date.now() - 4 * 3600000).toISOString();
    const unconfirmed = await base44.asServiceRole.entities.OptimizationDecision.filter(
      { amazon_account_id: aid, status: 'executing' }, '-executed_at', 20
    );
    for (const d of unconfirmed) {
      if (d.executed_at && d.executed_at < unconfirmedCutoff) {
        // Marcar como failed para reprocessamento
        await base44.asServiceRole.entities.OptimizationDecision.update(d.id, {
          status: 'failed',
          error_message: 'Timeout: sem confirmação Amazon após 4h',
        });
        actions.push({ type: 'timeout_executing_decision', decision_id: d.id });
      }
    }

    return Response.json({
      ok: true,
      hour: currentHour,
      actions_taken: actions.length,
      alerts_generated: alerts.length,
      actions,
      alerts,
      duration_ms: Date.now() - startTime,
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});