import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';

/**
 * auditBudgetDivergence
 *
 * Compara o gasto acumulado do dia em CampaignMetricsDaily com o confirmed_spend
 * do AccountDailySpendController. Se a divergência superar 5% do teto diário,
 * ativa o runBudgetKillSwitch imediatamente e cria um Alert crítico.
 */

function todayBRT() { return new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10); }
function nowIso() { return new Date().toISOString(); }

Deno.serve(async (req) => {
  const startedAt = nowIso();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    if (!body._service_role) {
      const user = await base44.auth.me().catch(() => null);
      if (!user) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    const amazon_account_id = body.amazon_account_id;
    if (!amazon_account_id) return Response.json({ ok: false, error: 'amazon_account_id obrigatório' }, { status: 400 });

    const today = todayBRT();

    // Idempotência: já rodou hoje?
    const prevLogs = await base44.asServiceRole.entities.SyncExecutionLog.filter(
      { amazon_account_id, operation: 'audit_budget_divergence', execution_date: today, status: 'success' },
      '-started_at', 1
    ).catch(() => []);
    if (prevLogs.length > 0 && !body.force) {
      return Response.json({ ok: true, skipped: true, reason: 'already_ran_today' });
    }

    // ── 1. Ler AccountDailySpendController do dia ─────────────────────────
    const controllers = await base44.asServiceRole.entities.AccountDailySpendController.filter(
      { amazon_account_id, spend_date: today }, null, 1
    ).catch(() => []);
    const controller = controllers[0];

    const confirmed_spend = Number(controller?.confirmed_spend ?? 0);
    const daily_budget_limit = Number(controller?.daily_budget_limit ?? controller?.user_daily_spend_cap ?? 80);

    if (daily_budget_limit <= 0) {
      await base44.asServiceRole.entities.SyncExecutionLog.create({
        amazon_account_id, operation: 'audit_budget_divergence',
        trigger_type: 'automatic', status: 'skipped',
        execution_date: today, started_at: startedAt, completed_at: nowIso(),
        result_summary: 'daily_budget_limit=0, auditoria ignorada',
      }).catch(() => {});
      return Response.json({ ok: true, skipped: true, reason: 'no_budget_limit' });
    }

    // ── 2. Somar CampaignMetricsDaily.spend do dia ────────────────────────
    const metrics = await base44.asServiceRole.entities.CampaignMetricsDaily.filter(
      { amazon_account_id, date: today }, null, 1000
    ).catch(() => []);
    const metrics_spend = metrics.reduce((s: number, m: any) => s + Number(m.spend ?? 0), 0);

    // ── 3. Calcular divergência ───────────────────────────────────────────
    const delta_abs = Math.abs(metrics_spend - confirmed_spend);
    const delta_pct = (delta_abs / daily_budget_limit) * 100;
    const killswitch_triggered = delta_pct > 5;

    const summary = {
      today,
      metrics_spend: parseFloat(metrics_spend.toFixed(2)),
      confirmed_spend: parseFloat(confirmed_spend.toFixed(2)),
      daily_budget_limit,
      delta_abs: parseFloat(delta_abs.toFixed(2)),
      delta_pct: parseFloat(delta_pct.toFixed(2)),
      killswitch_triggered,
    };

    if (killswitch_triggered) {
      // ── 4a. Ativar KillSwitch ─────────────────────────────────────────
      await base44.asServiceRole.functions.invoke('runBudgetKillSwitch', {
        _service_role: true,
        amazon_account_id,
        reason: 'divergencia_orcamento_confirmada',
        triggered_by: 'auditBudgetDivergence',
        delta_pct,
        metrics_spend,
        confirmed_spend,
        daily_budget_limit,
      }).catch((e: any) => console.error('[auditBudgetDivergence] KillSwitch invoke error:', e?.message));

      // ── 4b. Criar Alert crítico ───────────────────────────────────────
      const dedupKey = `budget_divergence:${amazon_account_id}:${today}`;
      const existingAlerts = await base44.asServiceRole.entities.Alert.filter(
        { amazon_account_id, deduplication_key: dedupKey, status: 'active' }, null, 1
      ).catch(() => []);

      if (existingAlerts.length === 0) {
        await base44.asServiceRole.entities.Alert.create({
          amazon_account_id,
          alert_type: 'spend_overpacing',
          alert_family: 'budget',
          severity: 'critical',
          status: 'active',
          title: 'Divergência de orçamento crítica — KillSwitch ativado',
          message: `Divergência de ${delta_pct.toFixed(1)}% entre métricas locais (R$${metrics_spend.toFixed(2)}) e gasto confirmado (R$${confirmed_spend.toFixed(2)}). KillSwitch ativado automaticamente.`,
          deduplication_key: dedupKey,
          metric_name: 'budget_divergence_pct',
          metric_value: delta_pct,
          threshold_value: 5,
          data_window: '1D',
          first_detected_at: nowIso(),
          last_detected_at: nowIso(),
          source_function: 'auditBudgetDivergence',
          created_at: nowIso(),
          updated_at: nowIso(),
        }).catch(() => {});
      }

      await base44.asServiceRole.entities.SyncExecutionLog.create({
        amazon_account_id, operation: 'audit_budget_divergence',
        trigger_type: 'automatic', status: 'success',
        execution_date: today, started_at: startedAt, completed_at: nowIso(),
        result_summary: JSON.stringify({ ...summary, action: 'killswitch_activated' }).slice(0, 2000),
      }).catch(() => {});

      return Response.json({ ok: true, ...summary, action: 'killswitch_activated' });
    }

    // ── 4c. Sem divergência crítica — apenas log de sucesso ───────────────
    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id, operation: 'audit_budget_divergence',
      trigger_type: 'automatic', status: 'success',
      execution_date: today, started_at: startedAt, completed_at: nowIso(),
      result_summary: JSON.stringify({ ...summary, action: 'no_action' }).slice(0, 2000),
    }).catch(() => {});

    return Response.json({ ok: true, ...summary, action: 'no_action' });

  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message }, { status: 500 });
  }
});