/**
 * updateDailyBudgetSuggestion
 * Calcula o budget diário sugerido = média dos últimos 14 dias de gasto real × 1.25
 * e salva no AutopilotConfig (ai_suggested_daily_budget, ai_budget_reasoning, ai_budget_generated_at)
 * Executado automaticamente uma vez por dia.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    // Resolver conta
    let account = null;
    if (body.amazon_account_id) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id });
      account = accs[0] || null;
    }
    if (!account) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      account = accs[0] || null;
    }
    if (!account) return Response.json({ ok: false, message: 'Nenhuma conta conectada' });

    const aid = account.id;
    const sym = account.currency_symbol || 'R$';
    const now = new Date().toISOString();

    // Janela: últimos 14 dias (excluindo hoje para ter dados completos)
    const today = now.slice(0, 10);
    const fourteenDaysAgo = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);

    // Buscar métricas diárias de campanhas nos últimos 14 dias
    const metrics = await base44.asServiceRole.entities.CampaignMetricsDaily.filter(
      { amazon_account_id: aid }, '-date', 500
    );

    // Filtrar janela e deduplificar por (campaign_id, date)
    const seen = new Set();
    const filtered = metrics.filter(m => {
      if (!m.date || m.date < fourteenDaysAgo || m.date >= today) return false;
      const key = `${m.campaign_id || 'no'}-${m.date}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Agrupar spend por dia
    const spendByDay = {};
    for (const m of filtered) {
      spendByDay[m.date] = (spendByDay[m.date] || 0) + (m.spend || 0);
    }

    const spendDays = Object.values(spendByDay);
    const numDays = spendDays.length;

    if (numDays === 0) {
      return Response.json({ ok: false, message: 'Sem dados de métricas nos últimos 14 dias' });
    }

    const totalSpend = spendDays.reduce((s, v) => s + v, 0);
    const avgDailySpend = totalSpend / numDays;
    const suggestedBudget = Math.round(avgDailySpend * 1.25 * 100) / 100;

    // Ontem para referência
    const yesterday = Object.keys(spendByDay).sort().slice(-1)[0];
    const yesterdaySpend = spendByDay[yesterday] || 0;

    const reasoning = `Média de gasto dos últimos ${numDays} dias: ${sym}${avgDailySpend.toFixed(2)}/dia. Ontem (${yesterday}): ${sym}${yesterdaySpend.toFixed(2)}. Budget sugerido = média × 1.25 = ${sym}${suggestedBudget.toFixed(2)}.`;

    // Atualizar AutopilotConfig
    const configs = await base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: aid });
    if (configs.length > 0) {
      await base44.asServiceRole.entities.AutopilotConfig.update(configs[0].id, {
        ai_suggested_daily_budget: suggestedBudget,
        ai_budget_reasoning: reasoning,
        ai_budget_confidence: 85,
        ai_budget_generated_at: now,
        ai_budget_breakdown: JSON.stringify({
          avg_spend_14d: avgDailySpend,
          yesterday_spend: yesterdaySpend,
          num_days_sampled: numDays,
          multiplier: 1.25,
          suggested: suggestedBudget,
        }),
      });
    } else {
      // Criar config se não existir
      await base44.asServiceRole.entities.AutopilotConfig.create({
        amazon_account_id: aid,
        ai_suggested_daily_budget: suggestedBudget,
        ai_budget_reasoning: reasoning,
        ai_budget_confidence: 85,
        ai_budget_generated_at: now,
        ai_budget_breakdown: JSON.stringify({
          avg_spend_14d: avgDailySpend,
          yesterday_spend: yesterdaySpend,
          num_days_sampled: numDays,
          multiplier: 1.25,
          suggested: suggestedBudget,
        }),
      });
    }

    console.log(`[updateDailyBudgetSuggestion] Budget sugerido: ${sym}${suggestedBudget} (média ${numDays}d: ${sym}${avgDailySpend.toFixed(2)})`);

    return Response.json({
      ok: true,
      suggested_budget: suggestedBudget,
      avg_daily_spend: avgDailySpend,
      yesterday_spend: yesterdaySpend,
      num_days: numDays,
      reasoning,
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});