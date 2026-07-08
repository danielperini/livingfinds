/**
 * recalculateSuggestedBudgetWeekly
 * Roda semanalmente. Calcula o budget diário sugerido via fórmula oficial.
 * 
 * daily_budget_floor = R$ 50
 * daily_budget_ceiling = R$ 130
 * campaign_weight = 2
 * hours_weight = 1
 * campaign_factor = campanhas_elegiveis / capacidade_semanal_campanhas
 * hours_factor = horas_desejadas / 24
 * utilization_score = ((campaign_factor × 2) + hours_factor) / 3
 * daily_budget_limit = 50 + (80 × utilization_score)
 * Resultado: clamped entre 50 e 130
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const FLOOR = 50;
const CEILING = 130;
const WEEKLY_CAPACITY = 10; // campanhas por semana (referência)
const TARGET_HOURS = 24;

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    const accounts = await base44.asServiceRole.entities.AmazonAccount.list('-created_date', 1);
    const account = accounts[0];
    if (!account) return Response.json({ ok: false, error: 'Nenhuma conta Amazon encontrada' });

    const aid = account.id;

    // Campanhas elegíveis: ativas, não arquivadas
    const campaigns = await base44.asServiceRole.entities.Campaign.filter(
      { amazon_account_id: aid }, '-spend', 500
    );

    const eligible = campaigns.filter(c =>
      !c.archived &&
      ['enabled', 'paused'].includes((c.state || c.status || '').toLowerCase()) &&
      (c.spend || 0) > 0
    );

    const eligibleCount = eligible.length;

    // Métricas dos últimos 14 dias
    const cutoff = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
    const metrics = await base44.asServiceRole.entities.CampaignMetricsDaily.filter(
      { amazon_account_id: aid }, '-date', 1000
    );

    const recentMetrics = metrics.filter(m => m.date >= cutoff);

    // Spend médio diário
    const byDate = new Map();
    for (const m of recentMetrics) {
      if (!byDate.has(m.date)) byDate.set(m.date, 0);
      byDate.set(m.date, byDate.get(m.date) + (m.spend || 0));
    }
    const dailySpends = Array.from(byDate.values());
    const avgDailySpend = dailySpends.length > 0
      ? dailySpends.reduce((s, v) => s + v, 0) / dailySpends.length
      : 0;

    // Totais
    const totSpend = recentMetrics.reduce((s, m) => s + (m.spend || 0), 0);
    const totSales = recentMetrics.reduce((s, m) => s + (m.sales || 0), 0);
    const totOrders = recentMetrics.reduce((s, m) => s + (m.orders || 0), 0);
    const totClicks = recentMetrics.reduce((s, m) => s + (m.clicks || 0), 0);
    const totImpressions = recentMetrics.reduce((s, m) => s + (m.impressions || 0), 0);

    const acos = totSales > 0 ? totSpend / totSales * 100 : 0;
    const roas = totSpend > 0 ? totSales / totSpend : 0;
    const cpc = totClicks > 0 ? totSpend / totClicks : 0;
    const ctr = totImpressions > 0 ? totClicks / totImpressions * 100 : 0;

    // Fórmula oficial
    const campaignFactor = Math.min(eligibleCount / WEEKLY_CAPACITY, 1);
    const hoursFactor = TARGET_HOURS / 24; // sempre 1.0 se 24h
    const utilizationScore = ((campaignFactor * 2) + hoursFactor) / 3;
    const rawBudget = FLOOR + (80 * utilizationScore);
    const calculatedBudget = Math.max(FLOOR, Math.min(CEILING, rawBudget));

    const now = new Date().toISOString();
    const nextRecalc = new Date(Date.now() + 7 * 86400000).toISOString();

    // Buscar ou criar BudgetConfiguration
    const existing = await base44.asServiceRole.entities.BudgetConfiguration.filter(
      { amazon_account_id: aid }
    );

    const budgetData = {
      amazon_account_id: aid,
      daily_budget_floor: FLOOR,
      daily_budget_ceiling: CEILING,
      calculated_daily_budget: Math.round(calculatedBudget * 100) / 100,
      weekly_campaign_capacity: WEEKLY_CAPACITY,
      eligible_campaign_count: eligibleCount,
      target_coverage_hours: TARGET_HOURS,
      campaign_weight: 2,
      hours_weight: 1,
      campaign_factor: Math.round(campaignFactor * 1000) / 1000,
      hours_factor: hoursFactor,
      utilization_score: Math.round(utilizationScore * 1000) / 1000,
      last_weekly_recalculation: now,
      next_weekly_recalculation: nextRecalc,
      updated_at: now,
      calculation_log: JSON.stringify({
        eligible_campaigns: eligibleCount,
        avg_daily_spend: Math.round(avgDailySpend * 100) / 100,
        acos: Math.round(acos * 10) / 10,
        roas: Math.round(roas * 100) / 100,
        cpc: Math.round(cpc * 100) / 100,
        formula: `50 + (80 × ${utilizationScore.toFixed(3)}) = ${rawBudget.toFixed(2)} → clamped: ${calculatedBudget.toFixed(2)}`,
        calculated_at: now,
      }),
    };

    if (existing.length > 0) {
      await base44.asServiceRole.entities.BudgetConfiguration.update(existing[0].id, budgetData);
    } else {
      await base44.asServiceRole.entities.BudgetConfiguration.create(budgetData);
    }

    // Também atualizar AutopilotConfig com o budget sugerido
    const apConfigs = await base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: aid });
    if (apConfigs.length > 0) {
      await base44.asServiceRole.entities.AutopilotConfig.update(apConfigs[0].id, {
        ai_suggested_daily_budget: calculatedBudget,
        ai_budget_generated_at: now,
        ai_budget_reasoning: `Calculado via fórmula oficial: ${eligibleCount} campanhas elegíveis, utilization_score=${utilizationScore.toFixed(3)}`,
      });
    }

    console.log(`[recalculateBudgetWeekly] Budget calculado: R$${calculatedBudget.toFixed(2)}`);

    return Response.json({
      ok: true,
      calculated_daily_budget: calculatedBudget,
      eligible_campaigns: eligibleCount,
      utilization_score: utilizationScore,
      avg_daily_spend_14d: avgDailySpend,
      acos_14d: acos,
      roas_14d: roas,
      next_recalculation: nextRecalc,
    });

  } catch (error) {
    console.error('[recalculateBudgetWeekly] Erro:', error.message);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});