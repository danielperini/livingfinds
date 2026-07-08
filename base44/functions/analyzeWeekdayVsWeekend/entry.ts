/**
 * analyzeWeekdayVsWeekend
 *
 * Analisa o desempenho histórico de dias úteis vs fins de semana
 * para uma conta Amazon. Retorna se o fim de semana performa melhor
 * ou pior que dias úteis — usado pelo SeasonalityContext.
 */

import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function safe(v) { return (v && isFinite(v) && !isNaN(v)) ? v : 0; }

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { amazon_account_id, days_back = 30 } = body;

    if (!amazon_account_id) return Response.json({ error: 'amazon_account_id obrigatório' }, { status: 400 });

    // Buscar métricas dos últimos N dias
    const endDate = new Date();
    endDate.setDate(endDate.getDate() - 1); // ontem
    const startDate = new Date(endDate.getTime() - days_back * 86400000);

    const startStr = startDate.toISOString().slice(0, 10);
    const endStr = endDate.toISOString().slice(0, 10);

    const metrics = await base44.asServiceRole.entities.CampaignMetricsDaily.filter(
      { amazon_account_id },
      '-date',
      500
    );

    // Filtrar pelo período e agrupar por data
    const byDate = {};
    for (const m of metrics) {
      if (!m.date || m.date < startStr || m.date > endStr) continue;
      if (!byDate[m.date]) byDate[m.date] = { spend: 0, sales: 0, orders: 0, clicks: 0, impressions: 0 };
      byDate[m.date].spend += m.spend || 0;
      byDate[m.date].sales += m.sales || 0;
      byDate[m.date].orders += m.orders || 0;
      byDate[m.date].clicks += m.clicks || 0;
      byDate[m.date].impressions += m.impressions || 0;
    }

    // Separar dias úteis vs fins de semana
    const weekday = { spend: 0, sales: 0, orders: 0, clicks: 0, impressions: 0, days: 0 };
    const saturday = { spend: 0, sales: 0, orders: 0, clicks: 0, impressions: 0, days: 0 };
    const sunday = { spend: 0, sales: 0, orders: 0, clicks: 0, impressions: 0, days: 0 };

    for (const [dateStr, d] of Object.entries(byDate)) {
      const dow = new Date(dateStr + 'T12:00:00').getDay();
      const bucket = dow === 0 ? sunday : dow === 6 ? saturday : weekday;
      bucket.spend += d.spend;
      bucket.sales += d.sales;
      bucket.orders += d.orders;
      bucket.clicks += d.clicks;
      bucket.impressions += d.impressions;
      bucket.days++;
    }

    function avg(bucket) {
      if (bucket.days === 0) return null;
      const spendPerDay = bucket.spend / bucket.days;
      const salesPerDay = bucket.sales / bucket.days;
      const ordersPerDay = bucket.orders / bucket.days;
      const clicksPerDay = bucket.clicks / bucket.days;
      const impressionsPerDay = bucket.impressions / bucket.days;
      return {
        days: bucket.days,
        spend_per_day: safe(spendPerDay),
        sales_per_day: safe(salesPerDay),
        orders_per_day: safe(ordersPerDay),
        clicks_per_day: safe(clicksPerDay),
        impressions_per_day: safe(impressionsPerDay),
        acos: salesPerDay > 0 ? safe(spendPerDay / salesPerDay * 100) : null,
        roas: spendPerDay > 0 ? safe(salesPerDay / spendPerDay) : null,
        ctr: impressionsPerDay > 0 ? safe(clicksPerDay / impressionsPerDay * 100) : null,
        cvr: clicksPerDay > 0 ? safe(ordersPerDay / clicksPerDay * 100) : null,
        cpc: clicksPerDay > 0 ? safe(spendPerDay / clicksPerDay) : null,
        cpa: ordersPerDay > 0 ? safe(spendPerDay / ordersPerDay) : null,
      };
    }

    const weekdayAvg = avg(weekday);
    const saturdayAvg = avg(saturday);
    const sundayAvg = avg(sunday);
    const weekendAvg = (saturday.days + sunday.days > 0) ? avg({
      spend: saturday.spend + sunday.spend,
      sales: saturday.sales + sunday.sales,
      orders: saturday.orders + sunday.orders,
      clicks: saturday.clicks + sunday.clicks,
      impressions: saturday.impressions + sunday.impressions,
      days: saturday.days + sunday.days,
    }) : null;

    // Comparação: fim de semana performa melhor que dias úteis?
    let weekendPerformsBetter = null;
    let weekendAcosOk = null;
    let analysis = 'Dados insuficientes para análise.';

    if (weekdayAvg && weekendAvg && weekdayAvg.days >= 5 && weekendAvg.days >= 2) {
      const betterCvr = weekendAvg.cvr != null && weekdayAvg.cvr != null && weekendAvg.cvr > weekdayAvg.cvr * 1.05;
      const betterRoas = weekendAvg.roas != null && weekdayAvg.roas != null && weekendAvg.roas > weekdayAvg.roas * 1.05;
      const betterOrders = weekendAvg.orders_per_day > weekdayAvg.orders_per_day * 1.1;
      const worseAcos = weekendAvg.acos != null && weekdayAvg.acos != null && weekendAvg.acos > weekdayAvg.acos * 1.2;

      weekendPerformsBetter = (betterCvr || betterRoas || betterOrders) && !worseAcos;
      weekendAcosOk = weekendAvg.acos != null && weekendAvg.acos < (weekdayAvg.acos || 999) * 1.25;

      if (weekendPerformsBetter) {
        analysis = 'Fim de semana performa MELHOR que dias úteis. Preservar budget e permitir bid +controlado.';
      } else if (worseAcos) {
        weekendPerformsBetter = false;
        analysis = 'Fim de semana tem ACoS pior. Reduzir bid temporário e proteger budget para dias úteis.';
      } else {
        weekendPerformsBetter = null; // indefinido
        analysis = 'Diferença entre fim de semana e dias úteis não é estatisticamente significativa.';
      }
    }

    return Response.json({
      ok: true,
      data: {
        period: { start: startStr, end: endStr, days_back },
        weekday: weekdayAvg,
        saturday: saturdayAvg,
        sunday: sundayAvg,
        weekend: weekendAvg,
        comparison: {
          weekend_performs_better: weekendPerformsBetter,
          weekend_acos_ok: weekendAcosOk,
          analysis,
        },
      },
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});