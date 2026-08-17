/**
 * analyzeDaypartingOpportunities — Analisa campanhas após 30 dias para identificar oportunidades de dayparting.
 * 
 * Critérios:
 * - Mínimo 30 dias desde criação da campanha
 * - Mínimo 21 dias com veiculação efetiva
 * - Dados em diferentes dias da semana
 * - Quantidade mínima de cliques e vendas
 * - Campanha ativa, produto com estoque
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const TZ = 'America/Sao_Paulo';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { amazon_account_id, campaign_id } = await req.json();

    if (!amazon_account_id) {
      return Response.json({ error: 'amazon_account_id required' }, { status: 400 });
    }

    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const twentyOneDaysAgo = new Date(now.getTime() - 21 * 24 * 60 * 60 * 1000);

    // Buscar campanhas elegíveis
    const campaignFilter: any = {
      amazon_account_id,
      created_by_app: true,
      status: 'enabled',
    };
    
    if (campaign_id) {
      campaignFilter.campaign_id = campaign_id;
    } else {
      // Filtrar campanhas com mais de 30 dias
      campaignFilter.start_date = { $lte: thirtyDaysAgo.toISOString().slice(0, 10) };
    }

    const campaigns = await base44.asServiceRole.entities.Campaign.filter(campaignFilter);

    const opportunities = [];
    const skipped = [];

    for (const campaign of campaigns) {
      try {
        // === 1. VERIFICAR ELEGIBILIDADE ===
        const startDate = campaign.start_date ? new Date(campaign.start_date) : null;
        if (!startDate) {
          skipped.push({
            campaign_id: campaign.campaign_id,
            reason: 'Sem data de início',
          });
          continue;
        }

        const daysRunning = Math.floor((now.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000));
        
        if (daysRunning < 30) {
          skipped.push({
            campaign_id: campaign.campaign_id,
            reason: `Apenas ${daysRunning} dias de execução (mínimo 30)`,
          });
          continue;
        }

        // === 2. BUSCAR DADOS HORÁRIOS ===
        const hourlyMetrics = await base44.asServiceRole.entities.HourlyMetric.filter({
          amazon_account_id,
          campaign_id: campaign.campaign_id,
          date: { $gte: thirtyDaysAgo.toISOString().slice(0, 10) },
        });

        if (hourlyMetrics.length === 0) {
          skipped.push({
            campaign_id: campaign.campaign_id,
            reason: 'Sem dados horários disponíveis',
          });
          continue;
        }

        // === 3. VERIFICAR AMOSTRA MÍNIMA ===
        const daysWithImpressions = new Set(hourlyMetrics.filter(h => h.impressions > 0).map(h => h.date)).size;
        
        if (daysWithImpressions < 21) {
          skipped.push({
            campaign_id: campaign.campaign_id,
            reason: `Apenas ${daysWithImpressions} dias com veiculação (mínimo 21)`,
          });
          continue;
        }

        const totalClicks = hourlyMetrics.reduce((sum, h) => sum + (h.clicks || 0), 0);
        const totalSales = hourlyMetrics.reduce((sum, h) => sum + (h.sales || 0), 0);
        const totalSpend = hourlyMetrics.reduce((sum, h) => sum + (h.spend || 0), 0);

        if (totalClicks < 50) {
          skipped.push({
            campaign_id: campaign.campaign_id,
            reason: `Apenas ${totalClicks} cliques (mínimo 50)`,
          });
          continue;
        }

        if (totalSales < 5) {
          skipped.push({
            campaign_id: campaign.campaign_id,
            reason: `Apenas ${totalSales} vendas (mínimo 5)`,
          });
          continue;
        }

        // === 4. VERIFICAR PRODUTO ===
        const products = await base44.asServiceRole.entities.Product.filter({
          amazon_account_id,
          asin: campaign.asin,
        });

        const product = products[0];
        if (!product || product.status === 'inactive' || product.status === 'archived') {
          skipped.push({
            campaign_id: campaign.campaign_id,
            reason: 'Produto inativo ou arquivado',
          });
          continue;
        }

        if ((product.fba_inventory || 0) === 0) {
          skipped.push({
            campaign_id: campaign.campaign_id,
            reason: 'Produto sem estoque',
          });
          continue;
        }

        // === 5. MONTAR MATRIZ HORÁRIA E POR DIA DA SEMANA ===
        const hourlyMatrix: any = {};
        const dailyMetrics: any = {};
        const weekdayMetrics = { impressions: 0, clicks: 0, spend: 0, sales: 0, orders: 0 }; // Seg-Sex (0-4)
        const weekendMetrics = { impressions: 0, clicks: 0, spend: 0, sales: 0, orders: 0 }; // Sáb-Dom (5-6)

        for (let d = 0; d < 7; d++) {
          for (let h = 0; h < 24; h++) {
            hourlyMatrix[`${d}-${h}`] = {
              day_of_week: d,
              hour: h,
              impressions: 0,
              clicks: 0,
              spend: 0,
              sales: 0,
              orders: 0,
              units: 0,
            };
          }
          
          dailyMetrics[d] = { day_of_week: d, impressions: 0, clicks: 0, spend: 0, sales: 0, orders: 0 };
        }

        for (const metric of hourlyMetrics) {
          const key = `${metric.day_of_week}-${metric.hour}`;
          if (hourlyMatrix[key]) {
            hourlyMatrix[key].impressions += metric.impressions || 0;
            hourlyMatrix[key].clicks += metric.clicks || 0;
            hourlyMatrix[key].spend += metric.spend || 0;
            hourlyMatrix[key].sales += metric.sales || 0;
            hourlyMatrix[key].orders += metric.orders || 0;
            hourlyMatrix[key].units += metric.units || 0;
          }
          
          // Agregar por dia da semana
          if (dailyMetrics[metric.day_of_week]) {
            dailyMetrics[metric.day_of_week].impressions += metric.impressions || 0;
            dailyMetrics[metric.day_of_week].clicks += metric.clicks || 0;
            dailyMetrics[metric.day_of_week].spend += metric.spend || 0;
            dailyMetrics[metric.day_of_week].sales += metric.sales || 0;
            dailyMetrics[metric.day_of_week].orders += metric.orders || 0;
          }
          
          // Separar dias úteis vs finais de semana
          const isWeekend = metric.day_of_week === 0 || metric.day_of_week === 6; // Domingo ou Sábado
          if (isWeekend) {
            weekendMetrics.impressions += metric.impressions || 0;
            weekendMetrics.clicks += metric.clicks || 0;
            weekendMetrics.spend += metric.spend || 0;
            weekendMetrics.sales += metric.sales || 0;
            weekendMetrics.orders += metric.orders || 0;
          } else {
            weekdayMetrics.impressions += metric.impressions || 0;
            weekdayMetrics.clicks += metric.clicks || 0;
            weekdayMetrics.spend += metric.spend || 0;
            weekdayMetrics.sales += metric.sales || 0;
            weekdayMetrics.orders += metric.orders || 0;
          }
        }

        // === 6. CALCULAR MÉTRICAS DERIVADAS ===
        const avgConversionRate = totalClicks > 0 ? (hourlyMetrics.reduce((sum, h) => sum + (h.orders || 0), 0) / totalClicks) : 0;
        const avgAcos = totalSales > 0 ? (totalSpend / totalSales) * 100 : 100;
        const avgRoas = totalSpend > 0 ? totalSales / totalSpend : 0;
        
        // Métricas por dia da semana
        const dayNames = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
        const dailyAnalysis = Object.values(dailyMetrics).map((d: any) => ({
          day_of_week: d.day_of_week,
          day_name: dayNames[d.day_of_week],
          is_weekend: d.day_of_week === 0 || d.day_of_week === 6,
          impressions: d.impressions,
          clicks: d.clicks,
          spend: d.spend,
          sales: d.sales,
          orders: d.orders,
          roas: d.spend > 0 ? d.sales / d.spend : 0,
          acos: d.sales > 0 ? (d.spend / d.sales) * 100 : 100,
          conversion_rate: d.clicks > 0 ? d.orders / d.clicks : 0,
        })).sort((a, b) => a.day_of_week - b.day_of_week);
        
        // Métricas agregadas: dias úteis vs finais de semana
        const weekdayRoas = weekdayMetrics.spend > 0 ? weekdayMetrics.sales / weekdayMetrics.spend : 0;
        const weekdayAcos = weekdayMetrics.sales > 0 ? (weekdayMetrics.spend / weekdayMetrics.sales) * 100 : 100;
        const weekdayCvr = weekdayMetrics.clicks > 0 ? weekdayMetrics.orders / weekdayMetrics.clicks : 0;
        
        const weekendRoas = weekendMetrics.spend > 0 ? weekendMetrics.sales / weekendMetrics.spend : 0;
        const weekendAcos = weekendMetrics.sales > 0 ? (weekendMetrics.spend / weekendMetrics.sales) * 100 : 100;
        const weekendCvr = weekendMetrics.clicks > 0 ? weekendMetrics.orders / weekendMetrics.clicks : 0;
        
        // Identificar melhor dia da semana
        const bestDay = dailyAnalysis
          .filter(d => d.clicks >= 10 && d.sales >= 2)
          .sort((a, b) => b.roas - a.roas)[0];
        
        const worstDay = dailyAnalysis
          .filter(d => d.clicks >= 10 && d.sales >= 2)
          .sort((a, b) => a.acos - b.acos)[0];

        const classifiedHours = [];

        for (const [key, data] of Object.entries(hourlyMatrix) as any[]) {
          const { day_of_week, hour, impressions, clicks, spend, sales, orders, units } = data;

          const conversionRate = clicks > 0 ? orders / clicks : 0;
          const acos = sales > 0 ? (spend / sales) * 100 : (clicks > 0 ? 100 : 0);
          const roas = spend > 0 ? sales / spend : 0;

          // Índices comparativos
          const conversionIndex = avgConversionRate > 0 ? conversionRate / avgConversionRate : 0;
          const roasIndex = avgRoas > 0 ? roas / avgRoas : 0;
          const acosIndex = avgAcos > 0 && avgAcos < 100 ? acos / avgAcos : 1;

          // Classificação
          let classification = 'insufficient_data';
          let confidence = 0;

          if (clicks >= 10 && sales >= 2) {
            if (roas >= 4 && acos <= 25 && conversionIndex >= 1.3) {
              classification = 'peak_high_profit';
              confidence = 90;
            } else if (roas >= 3 && acos <= 35 && conversionIndex >= 1.1) {
              classification = 'peak_conversion';
              confidence = 85;
            } else if (roas >= 2 && acos <= 45 && conversionIndex >= 0.9) {
              classification = 'efficient';
              confidence = 75;
            } else if (roas >= 1 && acos <= 60 && conversionIndex >= 0.7) {
              classification = 'neutral';
              confidence = 60;
            } else if (clicks >= 5 && sales === 0) {
              classification = 'deficit';
              confidence = 70;
            } else {
              classification = 'low_efficiency';
              confidence = 50;
            }
          } else if (clicks >= 3) {
            classification = 'discovery';
            confidence = 40;
          }

          classifiedHours.push({
            day_of_week,
            hour,
            impressions,
            clicks,
            spend,
            sales,
            orders,
            units,
            conversion_rate: conversionRate,
            acos,
            roas,
            conversion_index: conversionIndex,
            roas_index: roasIndex,
            acos_index: acosIndex,
            classification,
            confidence,
            sample_size: clicks >= 20 && sales >= 3 ? 'high' : clicks >= 10 ? 'adequate' : clicks >= 3 ? 'low' : 'insufficient',
          });
        }

        // === 7. IDENTIFICAR JANELAS DE DAYPARTING ===
        const dayPartingWindows: any = {};

        for (let d = 0; d < 7; d++) {
          const dayHours = classifiedHours.filter(h => h.day_of_week === d).sort((a, b) => a.hour - b.hour);
          
          let currentWindow = null;
          const windows = [];

          for (const hourData of dayHours) {
            const shouldReduce = ['deficit', 'low_efficiency'].includes(hourData.classification) && hourData.sample_size !== 'insufficient';
            const shouldMaintain = ['neutral', 'discovery', 'insufficient_data'].includes(hourData.classification);
            const shouldIncrease = ['efficient', 'peak_conversion', 'peak_high_profit'].includes(hourData.classification);

            const targetBidPct = shouldReduce ? 20 : shouldMaintain ? 50 : shouldIncrease ? Math.min(70 + (hourData.roas_index - 1) * 30, 100) : 50;

            if (currentWindow && currentWindow.targetBidPct === targetBidPct && hourData.hour === currentWindow.endHour + 1) {
              currentWindow.endHour = hourData.hour;
            } else {
              if (currentWindow) windows.push(currentWindow);
              currentWindow = {
                day_of_week: d,
                startHour: hourData.hour,
                endHour: hourData.hour,
                targetBidPct,
                classification: hourData.classification,
                avgRoas: hourData.roas,
                avgAcos: hourData.acos,
                totalClicks: hourData.clicks,
                totalSales: hourData.sales,
                confidence: hourData.confidence,
              };
            }
          }
          if (currentWindow) windows.push(currentWindow);

          // Consolidar janelas (máximo 3 por dia)
          if (windows.length > 3) {
            // Mesclar janelas adjacentes com bids similares
            const consolidated = [];
            let current = windows[0];
            
            for (let i = 1; i < windows.length; i++) {
              if (Math.abs(windows[i].targetBidPct - current.targetBidPct) <= 20 && windows[i].startHour === current.endHour + 1) {
                current.endHour = windows[i].endHour;
                current.avgRoas = (current.avgRoas + windows[i].avgRoas) / 2;
              } else {
                consolidated.push(current);
                current = windows[i];
              }
            }
            consolidated.push(current);
            dayPartingWindows[d] = consolidated.slice(0, 3);
          } else {
            dayPartingWindows[d] = windows;
          }
        }

        // === 8. CALCULAR IMPACTO ESPERADO ===
        const currentDailyBudget = campaign.daily_budget || 0;
        const currentAvgBid = 0.50; // Poderia buscar dos keywords

        const estimatedSavings = classifiedHours
          .filter(h => ['deficit', 'low_efficiency'].includes(h.classification))
          .reduce((sum, h) => sum + h.spend, 0) * 0.6; // Economia estimada de 60%

        const estimatedRoasImprovement = ((avgRoas * 1.15) - avgRoas) / avgRoas * 100;

        // === 9. CALCULAR CONFIDENCE_SCORE REAL ===
        // Componentes: amostra de dados (cliques/vendas), maturidade (dias), estabilidade horária, cobertura de dias da semana
        const highConfidenceHours = classifiedHours.filter(h => h.confidence >= 75 && h.sample_size !== 'insufficient').length;
        const totalActiveHours    = classifiedHours.filter(h => h.clicks > 0).length;
        const hoursWithAdequateSample = classifiedHours.filter(h => ['adequate', 'high'].includes(h.sample_size)).length;

        // Cobertura de dias da semana com dados adequados
        const daysWithAdequateData = new Set(
          classifiedHours.filter(h => h.clicks >= 5).map(h => h.day_of_week)
        ).size;

        // Sample score: logarítmica — 50+ cliques = 0.5, 200+ = 0.85, 500+ = 1.0
        const sampleScore = Math.min(1.0, Math.log10(Math.max(totalClicks, 1) + 1) / Math.log10(501));

        // Maturity score: 30 dias = 0.5, 60 dias = 0.8, 90+ = 1.0
        const maturityScore = Math.min(1.0, daysRunning / 90);

        // Hour coverage score: proporção de horas ativas com amostra adequada
        const hourCoverageScore = totalActiveHours > 0 ? Math.min(1.0, hoursWithAdequateSample / totalActiveHours) : 0;

        // Day coverage score: 7 dias com dados = 1.0
        const dayCoverageScore = daysWithAdequateData / 7;

        // High confidence hours ratio
        const highConfidenceRatio = totalActiveHours > 0 ? highConfidenceHours / totalActiveHours : 0;

        // Score composto ponderado
        const confidenceScore = Math.round(
          sampleScore        * 0.30 +
          maturityScore      * 0.25 +
          hourCoverageScore  * 0.20 +
          dayCoverageScore   * 0.15 +
          highConfidenceRatio * 0.10
        ) * 100;

        // Elegível para auto-aplicação se confidence ≥ 90%
        const autoApply = confidenceScore >= 90;

        opportunities.push({
          campaign_id: campaign.campaign_id,
          campaign_name: campaign.name,
          asin: campaign.asin,
          days_running: daysRunning,
          days_with_data: daysWithImpressions,
          total_clicks: totalClicks,
          total_sales: totalSales,
          total_spend: totalSpend,
          current_avg_acos: avgAcos,
          current_avg_roas: avgRoas,
          current_avg_conversion: avgConversionRate,
          hourly_classification: classifiedHours,
          dayparting_windows: dayPartingWindows,
          daily_analysis,
          weekday_metrics: {
            spend: weekdayMetrics.spend,
            sales: weekdayMetrics.sales,
            clicks: weekdayMetrics.clicks,
            orders: weekdayMetrics.orders,
            roas: weekdayRoas,
            acos: weekdayAcos,
            cvr: weekdayCvr,
          },
          weekend_metrics: {
            spend: weekendMetrics.spend,
            sales: weekendMetrics.sales,
            clicks: weekendMetrics.clicks,
            orders: weekendMetrics.orders,
            roas: weekendRoas,
            acos: weekendAcos,
            cvr: weekendCvr,
          },
          best_day_of_week: bestDay ? {
            day_name: bestDay.day_name,
            day_of_week: bestDay.day_of_week,
            roas: bestDay.roas,
            sales: bestDay.sales,
            clicks: bestDay.clicks,
          } : null,
          worst_day_of_week: worstDay ? {
            day_name: worstDay.day_name,
            day_of_week: worstDay.day_of_week,
            acos: worstDay.acos,
            sales: worstDay.sales,
            clicks: worstDay.clicks,
          } : null,
          estimated_daily_savings: estimatedSavings / 30,
          estimated_roas_improvement_pct: estimatedRoasImprovement,
          confidence_score: confidenceScore,
          auto_apply: autoApply,
          recommendation: autoApply ? 'auto_apply' : 'approve',
          original_bid: currentAvgBid,
          suggested_strategy: 'dynamic_down_only',
        });

      } catch (err) {
        skipped.push({
          campaign_id: campaign.campaign_id || 'unknown',
          reason: `Erro na análise: ${err.message}`,
        });
      }
    }

    return Response.json({
      ok: true,
      opportunities,
      skipped,
      analyzed_at: new Date().toISOString(),
      analyzed_by: user.id,
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});