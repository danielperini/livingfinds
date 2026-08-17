import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

function r2(v) { return parseFloat((Number(v) || 0).toFixed(2)); }

function calcCapStatus(spendPct) {
  if (spendPct >= 100) return 'cap_reached';
  if (spendPct >= 95)  return 'cap_imminent';
  if (spendPct >= 85)  return 'critical';
  if (spendPct >= 70)  return 'attention';
  return 'safe';
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { amazon_account_id } = body;

    // Resolver conta
    let account;
    if (amazon_account_id) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: amazon_account_id }, null, 1);
      account = accs[0];
    } else {
      const me = await base44.auth.me();
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ user_id: me.id }, null, 1);
      account = accs[0];
    }
    if (!account) return Response.json({ ok: false, error: 'Conta não encontrada' }, { status: 404 });

    const accountId = account.id;
    const now = new Date().toISOString();

    // Data de hoje em BRT (UTC-3)
    const todayBRT = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);

    // Buscar controller do dia
    const controllers = await base44.asServiceRole.entities.AccountDailySpendController.filter(
      { amazon_account_id: accountId, spend_date: todayBRT }, null, 1
    ).catch(() => []);
    const controller = controllers[0];
    if (!controller) {
      return Response.json({ ok: false, skipped: true, reason: 'no_controller_today', spend_date: todayBRT });
    }

    // Buscar CampaignMetricsDaily de hoje — paginar até 500
    const metrics = await base44.asServiceRole.entities.CampaignMetricsDaily.filter(
      { amazon_account_id: accountId, date: todayBRT }, null, 500
    ).catch(() => []);

    if (!metrics || metrics.length === 0) {
      return Response.json({ ok: true, skipped: true, reason: 'no_metrics_today', spend_date: todayBRT });
    }

    // Somar spend exclusivamente dos registros de hoje
    const confirmedSpendRecalc = r2(metrics.reduce((sum, m) => sum + (Number(m.spend) || 0), 0));

    const oldConfirmedSpend = r2(controller.confirmed_spend || 0);
    const cap = r2(controller.effective_daily_spend_cap || controller.user_daily_spend_cap || 70);
    const estimatedPending = r2(controller.estimated_pending_spend || 0);
    const projected = r2(confirmedSpendRecalc + estimatedPending);
    const remaining = r2(Math.max(0, cap - projected));
    const spendPct = cap > 0 ? (projected / cap) * 100 : 0;
    const capStatus = calcCapStatus(spendPct);

    // Atualizar controller — NÃO tocar em global_kill_switch nem effective_daily_spend_cap
    await base44.asServiceRole.entities.AccountDailySpendController.update(controller.id, {
      confirmed_spend: confirmedSpendRecalc,
      projected_total_spend: projected,
      remaining_spend: remaining,
      cap_status: capStatus,
      updated_at: now,
    });

    // Log de auditoria
    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: accountId,
      operation: 'recalc_daily_spend_controller',
      status: 'success',
      trigger_type: 'manual',
      started_at: now,
      completed_at: now,
      records_processed: metrics.length,
      result_summary: `Recalc spend ${todayBRT}: antes=R$${oldConfirmedSpend} → depois=R$${confirmedSpendRecalc} | ${metrics.length} registros CampaignMetricsDaily | cap=${cap} | status=${capStatus}`,
    }).catch(() => {});

    return Response.json({
      ok: true,
      spend_date: todayBRT,
      old_confirmed_spend: oldConfirmedSpend,
      new_confirmed_spend: confirmedSpendRecalc,
      records_summed: metrics.length,
      effective_cap: cap,
      projected_total_spend: projected,
      remaining_spend: remaining,
      cap_status: capStatus,
    });

  } catch (err) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
});