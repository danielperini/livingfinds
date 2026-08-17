/**
 * analyzeDayparting — Analisa desempenho por horário e gera mapa de calor
 * Coleta dados de campaigns, keywords, search terms por hora/dia da semana
 * Classifica faixas horárias e identifica padrões de conversão
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { amazon_account_id, campaign_id, asin, days = 30 } = body;

    if (!amazon_account_id) {
      return Response.json({ error: 'amazon_account_id required' }, { status: 400 });
    }

    // Carregar conta
    const account = await base44.asServiceRole.entities.AmazonAccount.get(amazon_account_id);
    if (!account) {
      return Response.json({ error: 'AmazonAccount não encontrada' }, { status: 404 });
    }

    // Carregar campanhas
    const campaigns = campaign_id
      ? await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id, campaign_id })
      : await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id });

    if (campaigns.length === 0) {
      return Response.json({ ok: true, message: 'Nenhuma campanha encontrada', heatmap: [], classifications: [] });
    }

    // Carregar keywords com métricas
    const keywords = await base44.asServiceRole.entities.Keyword.filter({ amazon_account_id });
    
    // Carregar hourly metrics se existirem
    const hourlyMetrics = await base44.asServiceRole.entities.HourlyMetric.filter(
      { amazon_account_id },
      '-recorded_at',
      days * 24
    );

    // Construir matriz de calor (hora × dia da semana)
    const heatmap = {};
    for (let day = 0; day < 7; day++) {
      for (let hour = 0; hour < 24; hour++) {
        const key = `${day}-${hour}`;
        heatmap[key] = {
          day,
          hour,
          impressions: 0,
          clicks: 0,
          spend: 0,
          sales: 0,
          orders: 0,
          acos: 0,
          roas: 0,
          conversion_rate: 0,
          data_points: 0,
        };
      }
    }

    // Agregar dados de hourly metrics
    for (const metric of hourlyMetrics) {
      const date = new Date(metric.recorded_at);
      const dayOfWeek = date.getDay(); // 0 = Domingo, 6 = Sábado
      const hour = date.getHours();
      const key = `${dayOfWeek}-${hour}`;

      if (heatmap[key]) {
        heatmap[key].impressions += metric.impressions || 0;
        heatmap[key].clicks += metric.clicks || 0;
        heatmap[key].spend += metric.spend || 0;
        heatmap[key].sales += metric.sales || 0;
        heatmap[key].orders += metric.orders || 0;
        heatmap[key].data_points++;
      }
    }

    // Calcular métricas derivadas
    for (const key of Object.keys(heatmap)) {
      const cell = heatmap[key];
      if (cell.data_points > 0) {
        cell.acos = cell.sales > 0 ? (cell.spend / cell.sales) * 100 : 0;
        cell.roas = cell.spend > 0 ? cell.sales / cell.spend : 0;
        cell.conversion_rate = cell.clicks > 0 ? (cell.orders / cell.clicks) * 100 : 0;
      }
    }

    // Classificar horários
    const classifications = [];
    const targetAcos = account.max_daily_budget_limit ? 30 : 25; // Meta padrão
    const targetRoas = 4;

    for (const key of Object.keys(heatmap)) {
      const cell = heatmap[key];
      let classification = 'dados_insuficientes';
      let rationale = '';

      // Amostra mínima: pelo menos 10 cliques ou 3 dias de dados
      const minClicks = 10;
      const minDays = 3;

      if (cell.clicks >= minClicks || cell.data_points >= minDays * 2) {
        if (cell.roas >= targetRoas && cell.acos > 0 && cell.acos <= targetAcos) {
          classification = 'pico_alta_rentabilidade';
          rationale = `ROAS ${cell.roas.toFixed(2)} (meta: ${targetRoas}), ACoS ${cell.acos.toFixed(1)}% (meta: ${targetAcos}%)`;
        } else if (cell.clicks > 50 && cell.conversion_rate < 5) {
          classification = 'pico_trafego_sem_rentabilidade';
          rationale = `Alto tráfego (${cell.clicks} cliques), baixa conversão (${cell.conversion_rate.toFixed(1)}%)`;
        } else if (cell.spend > 5 && cell.sales === 0 && cell.data_points >= 5) {
          classification = 'horario_deficitario';
          rationale = `Gasto $${cell.spend.toFixed(2)} sem vendas em ${cell.data_points} amostras`;
        } else if (cell.roas >= targetRoas * 0.8 && cell.roas < targetRoas) {
          classification = 'horario_eficiente';
          rationale = `ROAS próximo da meta: ${cell.roas.toFixed(2)}`;
        } else if (cell.clicks > 0 && cell.sales === 0) {
          classification = 'horario_baixa_eficiencia';
          rationale = `${cell.clicks} cliques sem vendas`;
        } else {
          classification = 'horario_neutro';
          rationale = 'Desempenho dentro da média';
        }
      } else {
        rationale = `Amostra insuficiente: ${cell.clicks} cliques, ${cell.data_points} pontos de dados`;
      }

      classifications.push({
        day: cell.day,
        hour: cell.hour,
        classification,
        rationale,
        metrics: {
          impressions: cell.impressions,
          clicks: cell.clicks,
          spend: cell.spend,
          sales: cell.sales,
          orders: cell.orders,
          acos: cell.acos,
          roas: cell.roas,
          conversion_rate: cell.conversion_rate,
        },
      });
    }

    // Identificar melhores e piores horários
    const sortedByRoas = classifications
      .filter(c => c.metrics.roas > 0)
      .sort((a, b) => b.metrics.roas - a.metrics.roas);

    const sortedBySpend = classifications
      .filter(c => c.metrics.spend > 0)
      .sort((a, b) => b.metrics.spend - a.metrics.spend);

    const bestHours = sortedByRoas.slice(0, 5);
    const worstHours = sortedBySpend.filter(c => c.metrics.sales === 0).slice(0, 5);

    // Recomendações
    const recommendations = [];

    if (bestHours.length > 0) {
      recommendations.push({
        type: 'oportunidade',
        title: 'Horários de alta rentabilidade identificados',
        details: bestHours.map(h => `Dia ${h.day}, ${h.hour}:00 — ROAS ${h.metrics.roas.toFixed(2)}`),
        action: 'Considerar aumento de bid ou budget nestes períodos',
      });
    }

    if (worstHours.length > 0) {
      recommendations.push({
        type: 'atencao',
        title: 'Horários com gasto sem venda',
        details: worstHours.map(h => `Dia ${h.day}, ${h.hour}:00 — $${h.metrics.spend.toFixed(2)} gasto, 0 vendas`),
        action: 'Reduzir bids ou pausar nestes períodos',
      });
    }

    return Response.json({
      ok: true,
      account_id: amazon_account_id,
      campaign_id: campaign_id || 'all',
      asin: asin || 'all',
      analysis_period_days: days,
      total_data_points: hourlyMetrics.length,
      heatmap,
      classifications,
      best_hours: bestHours,
      worst_hours: worstHours,
      recommendations,
      generated_at: new Date().toISOString(),
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});