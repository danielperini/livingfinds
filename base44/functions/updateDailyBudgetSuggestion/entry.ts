/**
 * updateDailyBudgetSuggestion
 * Executado UMA VEZ POR SEMANA (domingo 08:00).
 * Calcula o budget diário sugerido com base nos últimos 30 dias de gasto real,
 * aplica reserva de 30% e inclui análise de tendência ACoS/ROAS.
 * Zero chamadas a IA externa — lógica puramente determinística.
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
    const today = now.slice(0, 10);
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const fifteenDaysAgo = new Date(Date.now() - 15 * 86400000).toISOString().slice(0, 10);

    // Buscar métricas dos últimos 30 dias (sem hoje, que está incompleto)
    const metrics = await base44.asServiceRole.entities.CampaignMetricsDaily.filter(
      { amazon_account_id: aid }, '-date', 1500
    );

    // Deduplificar por (campaign_id, date) e filtrar janela
    const seen = new Set();
    const filtered = metrics.filter(m => {
      if (!m.date || m.date < thirtyDaysAgo || m.date >= today) return false;
      const key = `${m.campaign_id || 'no'}-${m.date}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Agrupar métricas por dia
    const byDay: Record<string, { spend: number; sales: number; clicks: number; impressions: number; orders: number }> = {};
    for (const m of filtered) {
      if (!byDay[m.date]) byDay[m.date] = { spend: 0, sales: 0, clicks: 0, impressions: 0, orders: 0 };
      byDay[m.date].spend      += Number(m.spend      || 0);
      byDay[m.date].sales      += Number(m.sales      || 0);
      byDay[m.date].clicks     += Number(m.clicks     || 0);
      byDay[m.date].impressions += Number(m.impressions || 0);
      byDay[m.date].orders     += Number(m.orders     || 0);
    }

    const sortedDates = Object.keys(byDay).sort();
    const numDays = sortedDates.length;

    if (numDays === 0) {
      return Response.json({ ok: false, message: 'Sem dados de métricas nos últimos 30 dias' });
    }

    // ── Médias globais 30 dias ────────────────────────────────────────────────
    const total30 = sortedDates.reduce((acc, d) => ({
      spend: acc.spend + byDay[d].spend,
      sales: acc.sales + byDay[d].sales,
      orders: acc.orders + byDay[d].orders,
    }), { spend: 0, sales: 0, orders: 0 });

    const avgDailySpend = total30.spend / numDays;
    const acos30 = total30.sales > 0 ? (total30.spend / total30.sales) * 100 : 0;
    const roas30 = total30.spend > 0 ? total30.sales / total30.spend : 0;

    // ── Últimos 15 dias para tendência ────────────────────────────────────────
    const recentDates = sortedDates.filter(d => d >= fifteenDaysAgo);
    const recent15 = recentDates.reduce((acc, d) => ({
      spend: acc.spend + byDay[d].spend,
      sales: acc.sales + byDay[d].sales,
    }), { spend: 0, sales: 0 });

    const avgSpendRecent = recentDates.length > 0 ? recent15.spend / recentDates.length : avgDailySpend;
    const acosRecent = recent15.sales > 0 ? (recent15.spend / recent15.sales) * 100 : acos30;

    // Tendência de ACoS: comparar período recente com 30d
    let acosTrend: 'improving' | 'worsening' | 'stable' = 'stable';
    if (acos30 > 0 && Math.abs(acosRecent - acos30) > 2) {
      acosTrend = acosRecent < acos30 ? 'improving' : 'worsening';
    }

    // Tendência de spend: comparar últimos 15d com 30d
    let spendTrend: 'growth' | 'decline' | 'stable' = 'stable';
    if (avgDailySpend > 0 && Math.abs(avgSpendRecent - avgDailySpend) / avgDailySpend > 0.05) {
      spendTrend = avgSpendRecent > avgDailySpend ? 'growth' : 'decline';
    }

    // ── Cálculo do budget sugerido ────────────────────────────────────────────
    // Base: média 30d ponderada com tendência recente (60% 30d + 40% 15d)
    const weightedAvg = avgDailySpend * 0.60 + avgSpendRecent * 0.40;

    // Reserva operacional: 30% base + 5% extra se ACoS melhorando (escalar)
    //                                 - 5% se ACoS piorando (conservar)
    const reserveRate = acosTrend === 'improving' ? 0.35 : acosTrend === 'worsening' ? 0.25 : 0.30;
    const suggestedBudget = Math.max(1, Math.round(weightedAvg * (1 + reserveRate) * 100) / 100);

    // ── Confiança dinâmica ────────────────────────────────────────────────────
    // Quanto mais dias com dados e menor o ACoS, maior a confiança
    const dataCoverage = Math.min(100, Math.round((numDays / 30) * 100));
    const acosBonus = acos30 > 0 && acos30 < 35 ? 10 : acos30 >= 35 && acos30 < 50 ? 0 : -5;
    const confidence = Math.min(95, Math.max(40, dataCoverage + acosBonus));

    // ── Ontem para referência ─────────────────────────────────────────────────
    const yesterday = sortedDates[sortedDates.length - 1];
    const yesterdaySpend = byDay[yesterday]?.spend || 0;

    const trendLabel = spendTrend === 'growth' ? '↑ crescimento' : spendTrend === 'decline' ? '↓ queda' : '→ estável';
    const acosTrendLabel = acosTrend === 'improving' ? 'melhorando' : acosTrend === 'worsening' ? 'piorando' : 'estável';

    const reasoning = `Análise semanal: ${numDays} dias com dados na janela de 30 dias. ` +
      `Média ponderada (60% 30d + 40% 15d): ${sym}${weightedAvg.toFixed(2)}/dia. ` +
      `ACoS 30d: ${acos30.toFixed(1)}% (${acosTrendLabel}), ROAS: ${roas30.toFixed(2)}x. ` +
      `Tendência de gasto: ${trendLabel}. ` +
      `Reserva operacional: ${(reserveRate * 100).toFixed(0)}%. ` +
      `Ontem (${yesterday}): ${sym}${yesterdaySpend.toFixed(2)}. ` +
      `Budget sugerido: ${sym}${suggestedBudget.toFixed(2)}.`;

    // ── Persistir no AutopilotConfig ──────────────────────────────────────────
    const breakdown = JSON.stringify({
      avg_spend_30d: Math.round(avgDailySpend * 100) / 100,
      avg_spend_15d: Math.round(avgSpendRecent * 100) / 100,
      weighted_avg: Math.round(weightedAvg * 100) / 100,
      yesterday_spend: yesterdaySpend,
      num_days_sampled: numDays,
      reserve_rate: reserveRate,
      acos_30d: Math.round(acos30 * 10) / 10,
      roas_30d: Math.round(roas30 * 100) / 100,
      acos_trend: acosTrend,
      spend_trend: spendTrend,
      suggested: suggestedBudget,
      calculated_at: now,
    });

    const configs = await base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: aid });
    const configData = {
      ai_suggested_daily_budget: suggestedBudget,
      ai_budget_reasoning: reasoning,
      ai_budget_confidence: confidence,
      ai_budget_generated_at: now,
      ai_budget_breakdown: breakdown,
    };

    if (configs.length > 0) {
      await base44.asServiceRole.entities.AutopilotConfig.update(configs[0].id, configData);
    } else {
      await base44.asServiceRole.entities.AutopilotConfig.create({ amazon_account_id: aid, ...configData });
    }

    return Response.json({
      ok: true,
      suggested_budget: suggestedBudget,
      avg_daily_spend_30d: avgDailySpend,
      avg_daily_spend_15d: avgSpendRecent,
      weighted_avg: weightedAvg,
      yesterday_spend: yesterdaySpend,
      acos_30d: acos30,
      roas_30d: roas30,
      acos_trend: acosTrend,
      spend_trend: spendTrend,
      confidence,
      num_days: numDays,
      reasoning,
    });

  } catch (error: any) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});