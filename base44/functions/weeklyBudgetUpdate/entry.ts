/**
 * weeklyBudgetUpdate — Toda sexta-feira, atualiza o max_daily_budget_limit
 * da conta Amazon com o budget sugerido arredondado para CIMA (Math.ceil).
 * Ex: R$34,5 → R$35 | R$34,1 → R$35 | R$34,0 → R$34
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const PAGE = 200;

async function loadAllCampaigns(base44, amazonAccountId) {
  const all = [];
  let offset = 0;
  while (true) {
    const page = await base44.asServiceRole.entities.Campaign.filter(
      { amazon_account_id: amazonAccountId },
      '-created_date',
      PAGE,
      offset
    );
    all.push(...page);
    if (page.length < PAGE) break;
    offset += PAGE;
  }
  return all;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);

    // Aceita chamada manual com amazon_account_id ou roda para todas as contas conectadas
    const body = await req.json().catch(() => ({}));
    let accounts = [];
    if (body.amazon_account_id) {
      accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id });
    } else {
      accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' });
    }

    if (!accounts.length) {
      return Response.json({ ok: false, message: 'Nenhuma conta Amazon conectada.' });
    }

    const results = [];

    for (const account of accounts) {
      const aid = account.id;

      // Buscar métricas dos últimos 20 dias para calcular spend médio real
      const twentyDaysAgo = new Date(Date.now() - 20 * 86400000).toISOString().slice(0, 10);
      const metricsRaw = await base44.asServiceRole.entities.CampaignMetricsDaily.filter(
        { amazon_account_id: aid, date: { $gte: twentyDaysAgo } },
        '-date',
        2000
      );

      // Deduplicar por (campaign_id + date)
      const dedupMap = new Map();
      for (const m of metricsRaw) {
        const key = `${m.campaign_id || 'x'}-${m.date}`;
        if (!dedupMap.has(key)) dedupMap.set(key, m);
      }
      const metrics = Array.from(dedupMap.values());

      // Agrupar spend por dia
      const spendByDay = {};
      for (const m of metrics) {
        spendByDay[m.date] = (spendByDay[m.date] || 0) + (m.spend || 0);
      }
      const spendDays = Object.values(spendByDay);
      const avgDailySpend = spendDays.length > 0
        ? spendDays.reduce((s, v) => s + v, 0) / spendDays.length
        : 0;

      if (avgDailySpend <= 0) {
        results.push({ account_id: aid, skipped: true, reason: 'Sem dados de spend nos últimos 20 dias.' });
        continue;
      }

      // Budget sugerido = spend médio × 1.2, limitado a 2× o budget ativo total
      const campaigns = await loadAllCampaigns(base44, aid);
      const activeBudgetTotal = campaigns
        .filter(c => (c.state === 'enabled' || c.status === 'enabled') && !c.archived && c.state !== 'archived')
        .reduce((s, c) => s + (c.daily_budget || 0), 0);

      const rawSuggested = Math.min(
        avgDailySpend * 1.2,
        Math.max(activeBudgetTotal, avgDailySpend * 1.5)
      );

      // Arredondar para CIMA (inteiro)
      const newBudget = Math.ceil(rawSuggested);

      const oldBudget = account.max_daily_budget_limit || 0;

      // Atualizar conta
      await base44.asServiceRole.entities.AmazonAccount.update(aid, {
        max_daily_budget_limit: newBudget,
      });

      // Registrar no histórico de mudanças
      await base44.asServiceRole.entities.CampaignChangeHistory.create({
        amazon_account_id: aid,
        campaign_id: 'account_level',
        change_type: 'BUDGET_RULE',
        entity_type: 'account',
        entity_id: aid,
        field_name: 'max_daily_budget_limit',
        old_value: String(oldBudget),
        new_value: String(newBudget),
        source: 'SCHEDULE_RULE',
        source_function: 'weeklyBudgetUpdate',
        reason: `Atualização semanal automática (sexta-feira). Spend médio ${avgDailySpend.toFixed(2)} × 1.2 = ${rawSuggested.toFixed(2)} → arredondado para cima: ${newBudget}.`,
        changed_at: new Date().toISOString(),
        changed_by: 'autopilot',
      });

      results.push({
        account_id: aid,
        old_budget: oldBudget,
        new_budget: newBudget,
        avg_daily_spend: Number(avgDailySpend.toFixed(2)),
        raw_suggested: Number(rawSuggested.toFixed(2)),
        days_analyzed: spendDays.length,
      });
    }

    return Response.json({ ok: true, updated: results.filter(r => !r.skipped).length, results });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});