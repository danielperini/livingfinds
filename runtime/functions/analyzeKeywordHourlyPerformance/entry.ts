/**
 * analyzeKeywordHourlyPerformance — Analisa desempenho horário por keyword
 * Identifica melhor e pior faixa horária baseado em ROAS, vendas e conversão
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { amazon_account_id, campaign_id } = body;

    if (!amazon_account_id || !campaign_id) {
      return Response.json({ error: 'amazon_account_id e campaign_id obrigatórios' }, { status: 400 });
    }

    // Buscar campanha para verificar idade
    const campaign = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id, campaign_id }).then(r => r[0]);
    if (!campaign) {
      return Response.json({ error: 'Campanha não encontrada' }, { status: 404 });
    }

    const campaignAge = campaign.days_running || 0;
    if (campaignAge < 30) {
      return Response.json({ 
        ok: true, 
        skipped: true, 
        reason: `Campanha com ${campaignAge} dias (< 30 dias necessários)` 
      });
    }

    // Buscar keywords da campanha
    const keywords = await base44.asServiceRole.entities.Keyword.filter({
      amazon_account_id,
      campaign_id,
      state: 'enabled',
    });

    if (keywords.length === 0) {
      return Response.json({ ok: true, keywords_analyzed: 0 });
    }

    // Buscar métricas horárias (HourlyMetric)
    const hourlyMetrics = await base44.asServiceRole.entities.HourlyMetric.filter({
      amazon_account_id,
      campaign_id,
      date: { $gte: new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10) },
    });

    if (hourlyMetrics.length === 0) {
      return Response.json({ 
        ok: true, 
        keywords_analyzed: 0, 
        reason: 'Sem métricas horárias disponíveis' 
      });
    }

    // Agrupar por keyword_id + hour + day_of_week
    const keywordHourlyData = {};
    for (const metric of hourlyMetrics) {
      const kwId = metric.keyword_id;
      if (!kwId) continue;

      if (!keywordHourlyData[kwId]) {
        keywordHourlyData[kwId] = {};
      }

      const hour = metric.hour;
      if (!keywordHourlyData[kwId][hour]) {
        keywordHourlyData[kwId][hour] = {
          hour,
          impressions: 0,
          clicks: 0,
          spend: 0,
          sales: 0,
          orders: 0,
          days_active: new Set(),
        };
      }

      keywordHourlyData[kwId][hour].impressions += metric.impressions || 0;
      keywordHourlyData[kwId][hour].clicks += metric.clicks || 0;
      keywordHourlyData[kwId][hour].spend += metric.spend || 0;
      keywordHourlyData[kwId][hour].sales += metric.sales || 0;
      keywordHourlyData[kwId][hour].orders += metric.orders || 0;
      keywordHourlyData[kwId][hour].days_active.add(metric.date);
    }

    // Analisar cada keyword
    const updates = [];
    let analyzedCount = 0;

    for (const keyword of keywords) {
      const kwId = keyword.keyword_id;
      const hourlyData = keywordHourlyData[kwId];

      if (!hourlyData || Object.keys(hourlyData).length === 0) {
        // Sem dados horários suficientes
        updates.push({
          id: keyword.id,
          hourly_data_mature: false,
          best_hour_start: null,
          best_hour_end: null,
          best_hour_roas: null,
          best_hour_sales: null,
          worst_hour_start: null,
          worst_hour_spend: null,
          hourly_action_suggestion: 'insufficient_data',
        });
        continue;
      }

      // Calcular ROAS por hora
      const hourStats = Object.values(hourlyData).map(h => ({
        hour: h.hour,
        clicks: h.clicks,
        spend: h.spend,
        sales: h.sales,
        orders: h.orders,
        roas: h.sales > 0 ? h.sales / h.spend : 0,
        acos: h.sales > 0 ? (h.spend / h.sales) * 100 : 999,
        conversion: h.clicks > 0 ? (h.orders / h.clicks) * 100 : 0,
        days_sample: h.days_active.size,
      }));

      // Filtrar horas com amostra mínima (3+ dias, 2+ cliques)
      const validHours = hourStats.filter(h => h.days_sample >= 3 && h.clicks >= 2);

      if (validHours.length < 3) {
        updates.push({
          id: keyword.id,
          hourly_data_mature: false,
          best_hour_start: null,
          best_hour_end: null,
          best_hour_roas: null,
          best_hour_sales: null,
          worst_hour_start: null,
          worst_hour_spend: null,
          hourly_action_suggestion: 'insufficient_data',
        });
        continue;
      }

      // Ordenar por ROAS (desc) e vendas
      validHours.sort((a, b) => {
        if (b.roas !== a.roas) return b.roas - a.roas;
        return b.sales - a.sales;
      });

      // Identificar melhor hora (top ROAS com vendas)
      const bestHour = validHours.find(h => h.sales > 0 && h.roas > 0) || validHours[0];

      // Identificar pior hora (maior spend sem vendas ou maior ACoS)
      const worstHour = validHours
        .filter(h => h.sales === 0 || h.acos > 50)
        .sort((a, b) => b.spend - a.spend)[0] || validHours[validHours.length - 1];

      // Calcular ROAS médio da keyword
      const totalSpend = validHours.reduce((s, h) => s + h.spend, 0);
      const totalSales = validHours.reduce((s, h) => s + h.sales, 0);
      const avgRoas = totalSpend > 0 ? totalSales / totalSpend : 0;

      // Determinar ação sugerida
      let actionSuggestion = 'maintain';
      if (bestHour.roas > avgRoas * 1.5 && bestHour.sales >= 3) {
        actionSuggestion = 'increase_peak';
      } else if (worstHour.sales === 0 && worstHour.spend > 5) {
        actionSuggestion = 'reduce_off_peak';
      }

      // Determinar faixa horária (agrupar horas similares)
      const bestHours = validHours.filter(h => h.roas >= bestHour.roas * 0.8 && h.sales > 0);
      bestHours.sort((a, b) => a.hour - b.hour);
      
      const bestHourStart = bestHours.length > 0 ? bestHours[0].hour : bestHour.hour;
      const bestHourEnd = bestHours.length > 0 
        ? bestHours[bestHours.length - 1].hour + 1 
        : bestHour.hour + 1;

      updates.push({
        id: keyword.id,
        hourly_data_mature: true,
        best_hour_start: bestHourStart,
        best_hour_end: bestHourEnd,
        best_hour_roas: parseFloat(bestHour.roas.toFixed(2)),
        best_hour_sales: bestHour.orders,
        best_hour_spend: parseFloat(bestHour.spend.toFixed(2)),
        best_hour_conversion: parseFloat(bestHour.conversion.toFixed(1)),
        worst_hour_start: worstHour.hour,
        worst_hour_end: worstHour.hour + 1,
        worst_hour_spend: parseFloat(worstHour.spend.toFixed(2)),
        worst_hour_sales: worstHour.orders,
        hourly_action_suggestion: actionSuggestion,
        hourly_confidence: Math.min(100, validHours.length * 10),
      });

      analyzedCount++;
    }

    // Aplicar atualizações em batch
    if (updates.length > 0) {
      await base44.asServiceRole.entities.Keyword.bulkUpdate(updates);
    }

    return Response.json({
      ok: true,
      keywords_analyzed: analyzedCount,
      keywords_updated: updates.length,
      campaign_age: campaignAge,
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});