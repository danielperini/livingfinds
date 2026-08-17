/**
 * controlBudgetPacing — Controla consumo de orçamento ao longo do dia
 * Calcula pacing ratio, prevê esgotamento, recomenda ações
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

// Curva de consumo esperada (aprendida, não fixa)
const DEFAULT_EXPECTED_CURVE = {
  0: 0.02, 1: 0.02, 2: 0.01, 3: 0.01, 4: 0.01, 5: 0.02,
  6: 0.03, 7: 0.04, 8: 0.05, 9: 0.06, 10: 0.07, 11: 0.08,
  12: 0.08, 13: 0.07, 14: 0.08, 15: 0.07, 16: 0.08, 17: 0.09,
  18: 0.10, 19: 0.11, 20: 0.10, 21: 0.08, 22: 0.05, 23: 0.03,
};

function getExpectedSpendPercent(hour) {
  let total = 0;
  for (let h = 0; h <= hour; h++) {
    total += DEFAULT_EXPECTED_CURVE[h] || 0.04;
  }
  return total;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { amazon_account_id, campaign_id } = body;

    if (!amazon_account_id) {
      return Response.json({ error: 'amazon_account_id required' }, { status: 400 });
    }

    const now = new Date();
    const currentHour = now.getHours();
    const today = now.toISOString().slice(0, 10);

    // Carregar campanhas
    const campaigns = campaign_id
      ? await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id, campaign_id })
      : await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id });

    const pacingResults = [];

    for (const campaign of campaigns) {
      const dailyBudget = campaign.daily_budget || 0;
      if (dailyBudget === 0) continue;

      // Carregar métricas de hoje (se existirem)
      const todayMetrics = await base44.asServiceRole.entities.CampaignMetricsDaily.filter({
        amazon_account_id,
        campaign_id: campaign.campaign_id,
        date: today,
      });

      const metric = todayMetrics[0];
      const spendToday = metric ? (metric.spend || 0) : (campaign.current_spend || campaign.spend || 0);
      
      // Calcular percentual consumido
      const percentConsumed = dailyBudget > 0 ? spendToday / dailyBudget : 0;
      const percentExpected = getExpectedSpendPercent(currentHour);

      // Pacing ratio
      const pacingRatio = percentExpected > 0 ? percentConsumed / percentExpected : 1;

      // Classificação
      let pacingStatus = 'normal';
      if (pacingRatio < 0.70) pacingStatus = 'subentrega';
      else if (pacingRatio > 1.35) pacingStatus = 'risco_esgotamento';
      else if (pacingRatio > 1.15) pacingStatus = 'acelerado';

      // Previsão de esgotamento
      const remainingBudget = dailyBudget - spendToday;
      const avgHourlySpend = currentHour > 0 ? spendToday / currentHour : 0;
      const hoursUntilExhaustion = avgHourlySpend > 0 ? remainingBudget / avgHourlySpend : 24;
      const estimatedExhaustionHour = currentHour + hoursUntilExhaustion;

      let exhaustionTime = null;
      if (estimatedExhaustionHour < 24) {
        exhaustionTime = `${Math.floor(estimatedExhaustionHour)}h${Math.round((estimatedExhaustionHour % 1) * 60)}`;
      } else {
        exhaustionTime = 'não_esgotar';
      }

      // Identificar próximo pico histórico
      const nextPeakHours = [];
      for (let h = currentHour + 1; h < 24; h++) {
        if (DEFAULT_EXPECTED_CURVE[h] >= 0.09) {
          nextPeakHours.push(`${h}:00-${h+1}:00`);
        }
      }

      // Recomendações
      const recommendations = [];

      if (pacingStatus === 'risco_esgotamento') {
        recommendations.push({
          priority: 'alta',
          action: 'reduzir_bids',
          reason: `Orçamento consumido ${ (percentConsumed * 100).toFixed(1) }% às ${currentHour}h`,
          details: 'Reduzir bids de keywords com baixo ROAS para preservar verba',
        });

        if (nextPeakHours.length > 0) {
          recommendations.push({
            priority: 'alta',
            action: 'preservar_verba',
            reason: `Próximo pico: ${nextPeakHours[0]}`,
            details: `Reservar $${(remainingBudget * 0.4).toFixed(2)} para período de pico`,
          });
        }
      } else if (pacingStatus === 'subentrega') {
        recommendations.push({
          priority: 'media',
          action: 'aumentar_exposicao',
          reason: `Apenas ${(percentConsumed * 100).toFixed(1)}% do budget consumido`,
          details: 'Verificar: bids baixas, relevância, estoque, Buy Box',
        });
      }

      // Salvar log de pacing
      await base44.asServiceRole.entities.PacingLog.create({
        amazon_account_id,
        campaign_id: campaign.campaign_id,
        daily_budget: dailyBudget,
        spend_today: spendToday,
        percent_consumed: percentConsumed,
        percent_expected: percentExpected,
        pacing_ratio: pacingRatio,
        pacing_status: pacingStatus,
        current_hour: currentHour,
        estimated_exhaustion: exhaustionTime,
        remaining_budget: remainingBudget,
        recommendations: JSON.stringify(recommendations),
        recorded_at: now.toISOString(),
      });

      pacingResults.push({
        campaign_id: campaign.campaign_id,
        campaign_name: campaign.campaign_name,
        daily_budget: dailyBudget,
        spend_today: spendToday,
        percent_consumed: parseFloat((percentConsumed * 100).toFixed(2)),
        percent_expected: parseFloat((percentExpected * 100).toFixed(2)),
        pacing_ratio: parseFloat(pacingRatio.toFixed(2)),
        pacing_status: pacingStatus,
        current_hour: currentHour,
        estimated_exhaustion: exhaustionTime,
        remaining_budget: parseFloat(remainingBudget.toFixed(2)),
        next_peak_hours: nextPeakHours,
        recommendations,
      });
    }

    // Resumo
    const summary = {
      total_campaigns: pacingResults.length,
      at_risk: pacingResults.filter(c => c.pacing_status === 'risco_esgotamento').length,
      accelerated: pacingResults.filter(c => c.pacing_status === 'acelerado').length,
      normal: pacingResults.filter(c => c.pacing_status === 'normal').length,
      underdelivering: pacingResults.filter(c => c.pacing_status === 'subentrega').length,
    };

    return Response.json({
      ok: true,
      account_id: amazon_account_id,
      checked_at: now.toISOString(),
      current_hour: currentHour,
      campaigns: pacingResults,
      summary,
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});