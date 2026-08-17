/**
 * auditDashboardAgainstSellerBenchmark
 *
 * Compara dados calculados pelo Dashboard com benchmarks reais informados pelo seller.
 * Detecta confusões comuns: vendas Ads vs faturamento total, ACoS vs TACOS, etc.
 * Salva resultado em DashboardDataAudit.
 * NÃO altera dados de campanha. NÃO chama Amazon API.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function safe(v: unknown): number {
  const n = Number(v);
  return isNaN(n) || !isFinite(n) ? 0 : n;
}
function safeDiv(a: number, b: number): number { return b !== 0 ? a / b : 0; }
function pctDiff(app: number, real: number): number {
  if (real === 0) return app === 0 ? 0 : 100;
  return Math.abs((app - real) / real) * 100;
}
function statusFor(diffPct: number): 'ok' | 'attention' | 'critical_divergence' {
  if (diffPct <= 2) return 'ok';
  if (diffPct <= 5) return 'attention';
  return 'critical_divergence';
}

Deno.serve(async (req) => {
  const start = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    const auth = await base44.auth.isAuthenticated().catch(() => false);
    if (!auth && !body._service_role) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

    let amazonAccountId = body.amazon_account_id;
    if (!amazonAccountId) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      if (!accs.length) return Response.json({ ok: false, error: 'Nenhuma conta conectada' });
      amazonAccountId = accs[0].id;
    }

    // Buscar benchmark mais recente
    const benchmarks = await base44.asServiceRole.entities.SellerPerformanceBenchmark.filter(
      { amazon_account_id: amazonAccountId }, '-created_at', 5
    );
    if (!benchmarks.length) return Response.json({ ok: false, error: 'Nenhum benchmark cadastrado. Importe dados reais primeiro.' });

    const bm = benchmarks[0] as Record<string, unknown>;
    const periodStart = String(bm.period_start || '');
    const periodEnd = String(bm.period_end || '');

    // ── Carregar métricas do período do benchmark ─────────────────────────
    const metricsRaw = await base44.asServiceRole.entities.CampaignMetricsDaily.filter(
      { amazon_account_id: amazonAccountId }, '-date', 3000
    );

    // Deduplicar: priorizar spAdvertisedProduct sobre spProductAds
    const seen = new Map<string, Record<string, unknown>>();
    for (const m of metricsRaw as Record<string, unknown>[]) {
      const key = `${m.campaign_id}|${m.date}`;
      const existing = seen.get(key);
      if (!existing) { seen.set(key, m); continue; }
      const existSrc = String(existing.source || '');
      const src = String(m.source || '');
      if (existSrc === 'spProductAds' && src === 'spAdvertisedProduct') seen.set(key, m);
    }
    const metrics = Array.from(seen.values());

    // Filtrar pelo período do benchmark (fechado — excluindo dia parcial)
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const effectiveEnd = periodEnd < yesterday ? periodEnd : yesterday;
    const periodMetrics = metrics.filter(m => {
      const d = String(m.date || '');
      return d >= periodStart && d <= effectiveEnd;
    });

    // Agregar
    const adsSpend = periodMetrics.reduce((s, m) => s + safe(m.spend), 0);
    const adsSales = periodMetrics.reduce((s, m) => s + safe(m.sales), 0); // vendas atribuídas a Ads
    const adsOrders = periodMetrics.reduce((s, m) => s + safe(m.orders), 0);
    const adsClicks = periodMetrics.reduce((s, m) => s + safe(m.clicks), 0);
    const adsImpressions = periodMetrics.reduce((s, m) => s + safe(m.impressions), 0);

    const appAcos = safeDiv(adsSpend, adsSales) * 100;
    const appRoas = safeDiv(adsSales, adsSpend);
    const appCpc = safeDiv(adsSpend, adsClicks);
    const appCtr = safeDiv(adsClicks, adsImpressions) * 100;
    const appCvr = safeDiv(adsOrders, adsClicks) * 100;

    // Dados do benchmark
    const bmRevenue = safe(bm.gross_revenue);
    const bmAdsSpend = safe(bm.ads_spend);
    const bmTacos = safe(bm.tacos_pct);
    const bmGrossProfit = safe(bm.gross_profit);
    const bmGrossMargin = safe(bm.gross_margin_pct);
    const bmSalesCount = safe(bm.sales_count);
    const bmUnits = safe(bm.units_sold);
    const bmTicket = safe(bm.average_ticket);
    const bmRoi = safe(bm.roi_pct);
    const bmMpa = safe(bm.mpa_pct);
    const bmNetRevenue = safe(bm.marketplace_net_revenue);
    const bmProfitAfterAds = safe(bm.gross_profit_after_ads);

    // Calcular TACOS do app: adsSpend / bmRevenue (faturamento real como denominador)
    const appTacos = bmRevenue > 0 ? safeDiv(adsSpend, bmRevenue) * 100 : 0;
    const appMpa = bmRevenue > 0 ? safeDiv(bmProfitAfterAds - adsSpend + bmAdsSpend, bmRevenue) * 100 : 0;

    // ── Comparações ───────────────────────────────────────────────────────
    type Comparison = {
      metric: string;
      app_value: number;
      benchmark_value: number;
      difference_value: number;
      difference_pct: number;
      status: string;
      note: string;
    };

    const comparisons: Comparison[] = [];

    function compare(metric: string, appVal: number, bmVal: number, note: string) {
      const diff = pctDiff(appVal, bmVal);
      comparisons.push({
        metric,
        app_value: Math.round(appVal * 100) / 100,
        benchmark_value: Math.round(bmVal * 100) / 100,
        difference_value: Math.round((appVal - bmVal) * 100) / 100,
        difference_pct: Math.round(diff * 10) / 10,
        status: statusFor(diff),
        note,
      });
    }

    compare('ads_spend', adsSpend, bmAdsSpend, 'Gasto em Ads: app vs benchmark real');
    compare('ads_sales', adsSales, bmRevenue, 'Vendas Ads vs Faturamento total — ATENÇÃO: app pode estar usando vendas Ads onde deveria usar faturamento total');
    compare('tacos_pct', appTacos, bmTacos, 'TACOS calculado pelo app vs TACOS real do seller');
    compare('ads_orders', adsOrders, bmSalesCount, 'Pedidos Ads vs Total de vendas — divergência indica vendas orgânicas não contabilizadas');
    compare('avg_ticket', bmRevenue > 0 && adsOrders > 0 ? safeDiv(bmRevenue, adsOrders) : 0, bmTicket, 'Ticket médio calculado vs real');

    // ── Detectar confusões comuns ─────────────────────────────────────────
    const confusions: string[] = [];
    const recommendations: string[] = [];

    // Confusão 1: Vendas Ads sendo usada como faturamento total
    if (adsSales > 0 && bmRevenue > 0) {
      const ratio = adsSales / bmRevenue;
      if (ratio > 0.90 && ratio <= 1.10) {
        confusions.push('POSSÍVEL_CONFUSÃO: Dashboard pode estar exibindo vendas Ads (atribuídas) como faturamento total. São métricas distintas.');
        recommendations.push('Diferenciar: "Vendas Ads" = vendas atribuídas a cliques em anúncios. "Faturamento total" = toda receita incluindo vendas orgânicas.');
      }
    }

    // Confusão 2: ACoS vs TACOS
    if (appTacos > 0 && bmTacos > 0) {
      const ratio = appAcos / bmTacos;
      if (ratio > 0.85 && ratio < 1.15) {
        confusions.push('POSSÍVEL_CONFUSÃO: ACoS e TACOS podem estar sendo usados de forma intercambiável. ACoS = Ads/VendasAds. TACOS = Ads/FaturamentoTotal.');
        recommendations.push('ACoS usa apenas vendas atribuídas a Ads no denominador. TACOS usa faturamento total. Sempre manter separados.');
      }
    }

    // Confusão 3: Período com dia atual parcial
    const todayInMetrics = metrics.some(m => String(m.date || '') === new Date().toISOString().slice(0, 10));
    if (todayInMetrics) {
      confusions.push('ATENÇÃO: Métricas do dia atual (parciais) detectadas. Dashboard deve usar apenas dados do período fechado até ontem.');
      recommendations.push('Filtrar sempre por: date <= yesterday para evitar distorção de médias diárias.');
    }

    // Confusão 4: Lucro bruto vs lucro pós Ads
    if (bmGrossProfit > 0 && bmProfitAfterAds >= 0) {
      if (Math.abs(bmGrossProfit - bmProfitAfterAds) > bmGrossProfit * 0.10) {
        confusions.push('DIFERENÇA SIGNIFICATIVA entre Lucro Bruto e Lucro Pós Ads. Ads consome parte relevante da margem. Exibir ambos separados no Dashboard.');
        recommendations.push(`Lucro Bruto: R$${bmGrossProfit.toFixed(2)} | Lucro pós Ads: R$${bmProfitAfterAds.toFixed(2)} | Diferença: R$${(bmGrossProfit - bmProfitAfterAds).toFixed(2)}`);
      }
    }

    // ── Status geral ──────────────────────────────────────────────────────
    const criticalCount = comparisons.filter(c => c.status === 'critical_divergence').length;
    const attentionCount = comparisons.filter(c => c.status === 'attention').length;
    const okCount = comparisons.filter(c => c.status === 'ok').length;
    const overallStatus = criticalCount > 0 ? 'critical_divergence' : attentionCount > 0 ? 'attention' : 'ok';

    // ── Salvar auditoria ──────────────────────────────────────────────────
    const audit = await base44.asServiceRole.entities.DashboardDataAudit.create({
      amazon_account_id: amazonAccountId,
      period_start: periodStart,
      period_end: effectiveEnd,
      benchmark_id: String(bm.id || ''),
      overall_status: overallStatus,
      critical_count: criticalCount,
      attention_count: attentionCount,
      ok_count: okCount,
      comparisons_json: JSON.stringify(comparisons),
      identified_confusions: confusions,
      recommendations,
      ran_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    });

    return Response.json({
      ok: true,
      overall_status: overallStatus,
      critical_count: criticalCount,
      attention_count: attentionCount,
      ok_count: okCount,
      comparisons,
      identified_confusions: confusions,
      recommendations,
      period: { start: periodStart, end: effectiveEnd },
      app_metrics: {
        ads_spend: Math.round(adsSpend * 100) / 100,
        ads_sales: Math.round(adsSales * 100) / 100,
        ads_orders: adsOrders,
        tacos_calculated: Math.round(appTacos * 10) / 10,
        acos: Math.round(appAcos * 10) / 10,
        roas: Math.round(appRoas * 100) / 100,
        cpc: Math.round(appCpc * 100) / 100,
        ctr: Math.round(appCtr * 100) / 100,
        cvr: Math.round(appCvr * 100) / 100,
      },
      benchmark_real: {
        gross_revenue: bmRevenue,
        marketplace_net: bmNetRevenue,
        gross_profit: bmGrossProfit,
        gross_margin: bmGrossMargin,
        sales_count: bmSalesCount,
        units_sold: bmUnits,
        avg_ticket: bmTicket,
        roi: bmRoi,
        ads_spend: bmAdsSpend,
        tacos: bmTacos,
        profit_after_ads: bmProfitAfterAds,
        mpa: bmMpa,
      },
      audit_id: audit?.id,
      duration_ms: Date.now() - start,
    });

  } catch (error) {
    return Response.json({ ok: false, error: (error as Error).message }, { status: 500 });
  }
});