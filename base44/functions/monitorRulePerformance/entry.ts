/**
 * monitorRulePerformance — Monitora performance de regras e executa rollback automático.
 * Executado diariamente. Não chama IA.
 *
 * Janelas de monitoramento: 24h, 3d, 7d, 14d
 * Rollback quando: lucro cai, gasto sobe sem vendas, ACoS ultrapassa limite,
 *   budget excede R$65, vendas caem além da tolerância.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const MAX_TOTAL_DAILY_BUDGET = 65;
const ROLLBACK_ACOS_THRESHOLD = 50;     // ACoS > 50% → rollback
const ROLLBACK_SPEND_NO_SALES_PCT = 0.3; // gasto sobe > 30% sem vendas → rollback
const ROLLBACK_SALES_DROP_PCT = 0.4;     // vendas caem > 40% → rollback

function daysAgo(n) { return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10); }

Deno.serve(async (req) => {
  const now = new Date().toISOString();
  const base44 = createClientFromRequest(req);

  try {
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    let account = null;
    if (body.amazon_account_id) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id });
      account = accs[0];
    }
    if (!account) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      account = accs[0];
    }
    if (!account) return Response.json({ ok: false, error: 'Conta não encontrada.' });
    const aid = account.id;

    // Carregar regras ativas com execuções recentes
    const activeRules = await base44.asServiceRole.entities.DecisionRule.filter({ amazon_account_id: aid, status: 'active' });
    const recentExecs = await base44.asServiceRole.entities.RuleExecution.filter(
      { amazon_account_id: aid }, '-created_date', 500
    );
    const metrics14d = await base44.asServiceRole.entities.CampaignMetricsDaily.filter(
      { amazon_account_id: aid }, '-date', 300
    );

    const campaigns = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid }, null, 200);
    const totalActiveBudget = campaigns
      .filter(c => c.state === 'enabled' || c.status === 'enabled')
      .reduce((s, c) => s + (c.daily_budget || 0), 0);

    const rolledBack = [];
    const monitored = [];

    // ── Guardrail global: budget total excede R$65 ──────────────────────
    if (totalActiveBudget > MAX_TOTAL_DAILY_BUDGET) {
      // Suspender regras de aumento de budget
      for (const rule of activeRules) {
        if (['redistribute_budget', 'increase_bid_percent'].includes(rule.action?.type)) {
          await base44.asServiceRole.entities.DecisionRule.update(rule.id, {
            status: 'suspended',
            effective_until: now,
          });
          await base44.asServiceRole.entities.RuleRollback.create({
            amazon_account_id: aid,
            rule_key: rule.rule_key,
            rule_version: rule.version,
            trigger: 'budget_exceeded',
            reason: `Budget total R$${totalActiveBudget.toFixed(2)} excede máximo R$${MAX_TOTAL_DAILY_BUDGET}`,
            rolled_back_at: now,
            reactivation_blocked_until: new Date(Date.now() + 7 * 86400000).toISOString(),
          });
          rolledBack.push({ rule_key: rule.rule_key, reason: 'budget_exceeded' });
        }
      }
    }

    // ── Monitorar cada regra com execuções nos últimos 14 dias ──────────
    for (const rule of activeRules) {
      const ruleExecs = recentExecs.filter(e =>
        e.rule_key === rule.rule_key &&
        e.status === 'completed' &&
        e.executed_at && new Date(e.executed_at) > new Date(Date.now() - 14 * 86400000)
      );

      if (ruleExecs.length === 0) continue;

      const firstExecDate = ruleExecs[ruleExecs.length - 1]?.executed_at;
      const daysSinceActivation = (Date.now() - new Date(firstExecDate || now).getTime()) / 86400000;

      // Verificar bloqueio de reativação
      const rollbacks = await base44.asServiceRole.entities.RuleRollback.filter(
        { amazon_account_id: aid, rule_key: rule.rule_key }, '-rolled_back_at', 1
      );
      if (rollbacks[0]?.reactivation_blocked_until && new Date(rollbacks[0].reactivation_blocked_until) > new Date()) {
        continue; // ainda bloqueada para reativação
      }

      // Métricas agregadas: período pós-ativação vs antes
      const activationDate = firstExecDate ? new Date(firstExecDate).toISOString().slice(0, 10) : daysAgo(7);
      const metricsAfter = metrics14d.filter(m => m.date >= activationDate);
      const metricsBefore = metrics14d.filter(m => m.date < activationDate && m.date >= daysAgo(14));

      const sumMetrics = (rows) => rows.reduce(
        (acc, m) => ({ spend: acc.spend + (m.spend || 0), sales: acc.sales + (m.sales || 0), orders: acc.orders + (m.orders || 0) }),
        { spend: 0, sales: 0, orders: 0 }
      );

      const after = sumMetrics(metricsAfter);
      const before = sumMetrics(metricsBefore);
      const afterAcos = after.sales > 0 ? (after.spend / after.sales * 100) : 0;

      const triggers = [];

      // ACoS acima do threshold
      if (afterAcos > ROLLBACK_ACOS_THRESHOLD && after.orders > 0) {
        triggers.push(`ACoS pós-ativação: ${afterAcos.toFixed(1)}% > ${ROLLBACK_ACOS_THRESHOLD}%`);
      }

      // Gasto subiu sem vendas correspondentes
      if (before.spend > 0 && after.spend > before.spend * (1 + ROLLBACK_SPEND_NO_SALES_PCT)) {
        if (after.sales <= before.sales) {
          triggers.push(`Gasto subiu ${((after.spend / before.spend - 1) * 100).toFixed(1)}% sem aumento de vendas`);
        }
      }

      // Vendas caíram
      if (before.sales > 0 && after.sales < before.sales * (1 - ROLLBACK_SALES_DROP_PCT)) {
        triggers.push(`Vendas caíram ${((1 - after.sales / before.sales) * 100).toFixed(1)}% após ativação da regra`);
      }

      if (triggers.length > 0) {
        // Executar rollback
        await base44.asServiceRole.entities.DecisionRule.update(rule.id, { status: 'rolled_back', effective_until: now });

        // Cancelar ações pendentes desta regra
        const pendingExecs = await base44.asServiceRole.entities.RuleExecution.filter(
          { amazon_account_id: aid, rule_key: rule.rule_key, status: 'pending' }
        );
        for (const ex of pendingExecs) {
          await base44.asServiceRole.entities.RuleExecution.update(ex.id, { status: 'cancelled' });
        }

        await base44.asServiceRole.entities.RuleRollback.create({
          amazon_account_id: aid,
          rule_key: rule.rule_key,
          rule_version: rule.version || 1,
          trigger: 'performance_monitor',
          reason: triggers.join(' | '),
          rolled_back_at: now,
          actions_cancelled: pendingExecs.length,
          reactivation_blocked_until: new Date(Date.now() + 7 * 86400000).toISOString(),
          metrics_at_rollback: JSON.stringify({ after, before, afterAcos, daysSinceActivation }),
        });
        rolledBack.push({ rule_key: rule.rule_key, triggers });
      } else {
        monitored.push({ rule_key: rule.rule_key, days_since_activation: Math.round(daysSinceActivation), status: 'ok' });
      }
    }

    return Response.json({
      ok: true,
      rules_monitored: monitored.length,
      rules_rolled_back: rolledBack.length,
      total_active_budget: Math.round(totalActiveBudget * 100) / 100,
      budget_within_limits: totalActiveBudget <= MAX_TOTAL_DAILY_BUDGET,
      rolled_back: rolledBack,
    });

  } catch (error) {
    console.error('[monitorRulePerformance]', error.message);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});