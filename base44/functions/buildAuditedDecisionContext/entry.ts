/**
 * buildAuditedDecisionContext v2
 *
 * Consolida TODOS os dados empíricos disponíveis antes de qualquer decisão automática.
 * Retorna contexto auditado com qualidade de dados, frescor, deduplicação e confidence base.
 *
 * REGRA: Nenhuma decisão automática pode ser tomada sem este contexto.
 * NÃO altera dados. NÃO chama Amazon. Apenas lê, consolida e pontua.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function safe(v: unknown): number {
  const n = Number(v);
  return isNaN(n) || !isFinite(n) ? 0 : n;
}
function safeDiv(a: number, b: number): number { return b > 0 ? a / b : 0; }
function daysAgo(d: number): string { return new Date(Date.now() - d * 86400000).toISOString().slice(0, 10); }
function hoursAgo(h: number): Date { return new Date(Date.now() - h * 3600000); }

// Freshness TTLs em horas
const TTL: Record<string, number> = {
  campaign_metrics: 24,
  search_terms: 24,
  term_bank: 168,
  inventory: 6,
  catalog: 24,
  hourly_metrics: 168,
  placement: 24,
  bid_recommendation: 24,
  budget_usage: 24,
  sales_daily: 24,
};

function checkFreshness(lastSyncAt: string | null, ttlHours: number): 'fresh' | 'stale' | 'missing' {
  if (!lastSyncAt) return 'missing';
  const ageH = (Date.now() - new Date(lastSyncAt).getTime()) / 3600000;
  return ageH <= ttlHours ? 'fresh' : 'stale';
}

function dedupeMetrics(metrics: Record<string, unknown>[]): {
  deduped: Record<string, unknown>[];
  removed: number;
  sources: Record<string, number>;
} {
  const seen = new Map<string, Record<string, unknown>>();
  const sources: Record<string, number> = {};
  for (const m of metrics) {
    const src = String(m.source || m.report_type || 'unknown');
    sources[src] = (sources[src] || 0) + 1;
    // Chave de deduplicação: por campanha + data (ignorar fonte duplicada)
    const key = `${m.campaign_id}|${m.date}`;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, m);
    } else {
      // Priorizar spAdvertisedProduct sobre spProductAds para mesmos dados
      const existSrc = String(existing.source || '');
      if (existSrc === 'spProductAds' && src === 'spAdvertisedProduct') {
        seen.set(key, m); // trocar para fonte primária
      }
    }
  }
  return { deduped: Array.from(seen.values()), removed: metrics.length - seen.size, sources };
}

function calcDataQualityScore(ctx: {
  campaigns: number;
  keywords: number;
  metrics_days: number;
  search_terms: number;
  products_with_cost: number;
  total_products: number;
  freshness: Record<string, string>;
  deduped_removed: number;
  total_metrics: number;
}): number {
  let score = 0;

  // Cobertura de dados (40 pts)
  if (ctx.campaigns > 0) score += 10;
  if (ctx.keywords > 0) score += 10;
  if (ctx.metrics_days >= 7) score += 10;
  else if (ctx.metrics_days >= 3) score += 5;
  if (ctx.search_terms > 0) score += 10;

  // Frescor (40 pts)
  const freshnessFields = Object.values(ctx.freshness);
  const freshCount = freshnessFields.filter(f => f === 'fresh').length;
  const total = freshnessFields.length || 1;
  score += Math.round((freshCount / total) * 40);

  // Qualidade (20 pts)
  const dedupRatio = ctx.total_metrics > 0 ? ctx.deduped_removed / ctx.total_metrics : 0;
  if (dedupRatio < 0.05) score += 10; // baixa duplicidade
  else if (dedupRatio < 0.20) score += 5;
  if (ctx.products_with_cost > 0 && ctx.total_products > 0) {
    score += Math.min(10, Math.round((ctx.products_with_cost / ctx.total_products) * 10));
  }

  return Math.min(100, Math.max(0, score));
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

    const account = (await base44.asServiceRole.entities.AmazonAccount.filter({ id: amazonAccountId }))[0];
    if (!account) return Response.json({ ok: false, error: 'Conta não encontrada' });

    const today = new Date().toISOString().slice(0, 10);
    const yesterday = daysAgo(1);
    // Período fechado: excluir hoje (dados parciais) e os últimos 3 dias de atribuição
    const closedPeriodEnd = daysAgo(3);
    const closedPeriodStart = daysAgo(33);

    const warnings: string[] = [];
    const blockedReasons: string[] = [];

    // ── 1. Carregar todos os dados em paralelo ────────────────────────────
    const [
      campaigns, keywords, products, searchTerms,
      metricsRaw, hourlyRaw, decisionOutcomes,
      termBank, autopilotCfg, perfSettings,
    ] = await Promise.all([
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: amazonAccountId }, null, 500),
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: amazonAccountId }, '-spend', 1000),
      base44.asServiceRole.entities.Product.filter({ amazon_account_id: amazonAccountId }, null, 300),
      base44.asServiceRole.entities.SearchTerm.filter({ amazon_account_id: amazonAccountId }, '-orders_14d', 1000),
      base44.asServiceRole.entities.CampaignMetricsDaily.filter({ amazon_account_id: amazonAccountId }, '-date', 3000),
      base44.asServiceRole.entities.HourlyMetric.filter({ amazon_account_id: amazonAccountId }, '-date', 500).catch(() => []),
      base44.asServiceRole.entities.DecisionOutcome.filter({ amazon_account_id: amazonAccountId, result_status: 'pending' }, '-created_at', 200).catch(() => []),
      base44.asServiceRole.entities.TermBank.filter({ amazon_account_id: amazonAccountId }, '-score', 500).catch(() => []),
      base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: amazonAccountId }).catch(() => []),
      base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id: amazonAccountId }).catch(() => []),
    ]);

    const cfg = autopilotCfg[0] || {};
    const perf = perfSettings[0] || {};
    const TARGET_ACOS = safe(perf.target_acos || cfg.target_acos || 25);
    const MAX_ACOS = safe(perf.max_acos || cfg.maximum_acos || 40);
    const MIN_BID = safe(perf.min_bid || cfg.min_bid || 0.10);
    const MAX_BID = safe(perf.max_bid || cfg.max_bid || 5.0);

    // ── 2. Deduplicar métricas ────────────────────────────────────────────
    const { deduped: metricsDeduped, removed: dedupRemoved, sources: metricSources } = dedupeMetrics(metricsRaw);

    // ── 3. Verificar frescor ──────────────────────────────────────────────
    const lastSyncAt = account.last_sync_at || null;
    const lastInventorySync = products.reduce((acc: string, p: Record<string, unknown>) => {
      const s = String(p.last_sync_at || p.synced_at || '');
      return s > acc ? s : acc;
    }, '');
    const lastSearchTermSync = searchTerms.reduce((acc: string, s: Record<string, unknown>) => {
      const d = String(s.updated_at || s.created_date || '');
      return d > acc ? d : acc;
    }, '');
    const lastHourlySync = hourlyRaw.reduce((acc: string, h: Record<string, unknown>) => {
      const d = String(h.date || '');
      return d > acc ? d : acc;
    }, '');

    const freshness: Record<string, string> = {
      campaign_metrics: checkFreshness(lastSyncAt, TTL.campaign_metrics),
      search_terms: checkFreshness(lastSearchTermSync, TTL.search_terms),
      inventory: checkFreshness(lastInventorySync || lastSyncAt, TTL.inventory),
      catalog: checkFreshness(lastSyncAt, TTL.catalog),
      hourly_metrics: checkFreshness(lastHourlySync, TTL.hourly_metrics),
    };

    // Avisos de frescor
    for (const [k, v] of Object.entries(freshness)) {
      if (v === 'stale') warnings.push(`Dados de ${k} estão desatualizados (>${TTL[k]}h). Não aumentar gasto automaticamente.`);
      if (v === 'missing') warnings.push(`Dados de ${k} ausentes.`);
    }

    // ── 4. Calcular métricas agregadas por período fechado ────────────────
    const closedMetrics = metricsDeduped.filter((m: Record<string, unknown>) =>
      String(m.date || '') >= closedPeriodStart && String(m.date || '') <= closedPeriodEnd
    );

    const totalSpend = closedMetrics.reduce((s: number, m: Record<string, unknown>) => s + safe(m.spend), 0);
    const totalSales = closedMetrics.reduce((s: number, m: Record<string, unknown>) => s + safe(m.sales), 0);
    const totalOrders = closedMetrics.reduce((s: number, m: Record<string, unknown>) => s + safe(m.orders), 0);
    const totalClicks = closedMetrics.reduce((s: number, m: Record<string, unknown>) => s + safe(m.clicks), 0);
    const totalImpressions = closedMetrics.reduce((s: number, m: Record<string, unknown>) => s + safe(m.impressions), 0);
    const accountAcos = safeDiv(totalSpend, totalSales) * 100;
    const accountRoas = safeDiv(totalSales, totalSpend);
    const accountCpc = safeDiv(totalSpend, totalClicks);

    // Dias únicos no período fechado
    const uniqueDates = new Set(closedMetrics.map((m: Record<string, unknown>) => String(m.date || '')));

    // Gasto dos últimos 7 dias fechados
    const spend7d = metricsDeduped
      .filter((m: Record<string, unknown>) => String(m.date || '') >= daysAgo(10) && String(m.date || '') <= closedPeriodEnd)
      .reduce((s: number, m: Record<string, unknown>) => s + safe(m.spend), 0);

    // Média diária 7d
    const avgDailySpend7d = spend7d > 0 ? spend7d / 7 : 0;

    // Spend yesterday (D-1)
    const spendYesterday = metricsDeduped
      .filter((m: Record<string, unknown>) => String(m.date || '') === yesterday)
      .reduce((s: number, m: Record<string, unknown>) => s + safe(m.spend), 0);

    // ── 5. Spend spike guard ──────────────────────────────────────────────
    const spendSpikeDetected = avgDailySpend7d > 0 && spendYesterday > avgDailySpend7d * 1.30;
    const salesYesterday = metricsDeduped
      .filter((m: Record<string, unknown>) => String(m.date || '') === yesterday)
      .reduce((s: number, m: Record<string, unknown>) => s + safe(m.sales), 0);
    const spendSpikeWithoutSales = spendSpikeDetected && salesYesterday < spendYesterday * 0.5;

    if (spendSpikeWithoutSales) {
      warnings.push(`SPEND_SPIKE: Gasto D-1 R$${spendYesterday.toFixed(2)} subiu >30% vs média 7d R$${avgDailySpend7d.toFixed(2)} sem venda proporcional.`);
      blockedReasons.push('SPEND_SPIKE_WITHOUT_SALES — bloquear aumento de bid/budget/placement');
    }

    // ── 6. Calcular métricas por campanha ─────────────────────────────────
    const metricsByCampaign: Record<string, { spend: number; sales: number; orders: number; clicks: number; impressions: number }> = {};
    for (const m of closedMetrics) {
      const cid = String((m as Record<string, unknown>).campaign_id || '');
      if (!cid) continue;
      if (!metricsByCampaign[cid]) metricsByCampaign[cid] = { spend: 0, sales: 0, orders: 0, clicks: 0, impressions: 0 };
      metricsByCampaign[cid].spend += safe((m as Record<string, unknown>).spend);
      metricsByCampaign[cid].sales += safe((m as Record<string, unknown>).sales);
      metricsByCampaign[cid].orders += safe((m as Record<string, unknown>).orders);
      metricsByCampaign[cid].clicks += safe((m as Record<string, unknown>).clicks);
      metricsByCampaign[cid].impressions += safe((m as Record<string, unknown>).impressions);
    }

    // ── 7. Métricas de estoque ────────────────────────────────────────────
    const productsWithStock = products.filter((p: Record<string, unknown>) => p.inventory_status !== 'out_of_stock' && p.status !== 'archived').length;
    const productsOutOfStock = products.filter((p: Record<string, unknown>) => p.inventory_status === 'out_of_stock').length;
    const productsWithCost = products.filter((p: Record<string, unknown>) => (safe(p.product_cost) > 0 || safe(p.price) > 0) && p.cost_confirmed === true).length;

    // ── 8. Métricas de campanhas ──────────────────────────────────────────
    const activeCampaigns = campaigns.filter((c: Record<string, unknown>) => {
      const st = String(c.state || c.status || '').toLowerCase();
      return st === 'enabled' || st === 'active';
    });
    const incompleteCampaigns = campaigns.filter((c: Record<string, unknown>) =>
      String(c.state || c.status || '').toLowerCase() === 'incomplete'
    );
    const campaignsNoMetrics = activeCampaigns.filter((c: Record<string, unknown>) => {
      const m = metricsByCampaign[String(c.campaign_id || '')];
      return !m || m.spend === 0;
    });

    // ── 9. Score de qualidade de dados ────────────────────────────────────
    const dataQualityScore = calcDataQualityScore({
      campaigns: campaigns.length,
      keywords: keywords.length,
      metrics_days: uniqueDates.size,
      search_terms: searchTerms.length,
      products_with_cost: productsWithCost,
      total_products: products.length,
      freshness,
      deduped_removed: dedupRemoved,
      total_metrics: metricsRaw.length,
    });

    // ── 10. Decision readiness ────────────────────────────────────────────
    const isFresh = freshness.campaign_metrics === 'fresh';
    const hasEnoughData = uniqueDates.size >= 3 && totalClicks >= 10;
    const decision_ready = isFresh && hasEnoughData && blockedReasons.length === 0;

    if (!isFresh) blockedReasons.push('STALE_METRICS — dados de campanha fora do TTL de 24h');
    if (!hasEnoughData) blockedReasons.push('INSUFFICIENT_DATA — menos de 3 dias de métricas ou menos de 10 cliques');

    // ── 11. Confidence base ───────────────────────────────────────────────
    const confidenceBase = Math.round(
      (dataQualityScore * 0.4 +
      (isFresh ? 30 : 0) +
      (hasEnoughData ? 20 : 0) +
      (blockedReasons.length === 0 ? 10 : 0))
    );

    // ── 12. Hourly patterns ───────────────────────────────────────────────
    const hourlyByBlock: Record<string, { spend: number; orders: number; clicks: number }> = {};
    for (const h of hourlyRaw as Record<string, unknown>[]) {
      const block = `hour_${String(h.hour || 0).padStart(2, '0')}`;
      if (!hourlyByBlock[block]) hourlyByBlock[block] = { spend: 0, orders: 0, clicks: 0 };
      hourlyByBlock[block].spend += safe(h.spend);
      hourlyByBlock[block].orders += safe(h.orders);
      hourlyByBlock[block].clicks += safe(h.clicks);
    }
    const topConversionHours = Object.entries(hourlyByBlock)
      .filter(([, v]) => v.orders > 0)
      .sort((a, b) => safeDiv(b[1].orders, b[1].clicks) - safeDiv(a[1].orders, a[1].clicks))
      .slice(0, 5)
      .map(([k]) => k);

    // ── 13. Search term winners ───────────────────────────────────────────
    const searchTermWinners = searchTerms.filter((st: Record<string, unknown>) => {
      const orders = safe(st.orders_14d || st.orders || 0);
      const acos = safe(st.acos_14d || st.acos || 0);
      return orders >= 2 && (acos === 0 || acos <= TARGET_ACOS);
    });

    // ── 14. Montar contexto final ─────────────────────────────────────────
    const context = {
      amazon_account_id: amazonAccountId,
      generated_at: new Date().toISOString(),
      closed_period_start: closedPeriodStart,
      closed_period_end: closedPeriodEnd,
      metrics_period_days: uniqueDates.size,

      // Qualidade e decisão
      data_quality_score: dataQualityScore,
      confidence_base: confidenceBase,
      freshness_status: freshness,
      decision_ready,
      blocked_reasons: blockedReasons,
      warnings,

      // Deduplicação
      duplicated_records_removed: dedupRemoved,
      source_reports_used: Object.keys(metricSources),
      metric_sources: metricSources,

      // Métricas agregadas (período fechado)
      account_metrics: {
        spend: Math.round(totalSpend * 100) / 100,
        sales: Math.round(totalSales * 100) / 100,
        orders: totalOrders,
        clicks: totalClicks,
        impressions: totalImpressions,
        acos: Math.round(accountAcos * 10) / 10,
        roas: Math.round(accountRoas * 100) / 100,
        cpc: Math.round(accountCpc * 100) / 100,
        avg_daily_spend_7d: Math.round(avgDailySpend7d * 100) / 100,
        spend_yesterday: Math.round(spendYesterday * 100) / 100,
        sales_yesterday: Math.round(salesYesterday * 100) / 100,
      },

      // Guards econômicos
      spend_spike_detected: spendSpikeDetected,
      spend_spike_without_sales: spendSpikeWithoutSales,
      allow_bid_increase: !spendSpikeWithoutSales && isFresh && blockedReasons.length === 0,
      allow_budget_increase: !spendSpikeDetected && totalOrders > 0 && accountAcos <= MAX_ACOS,

      // Campanhas
      campaigns_total: campaigns.length,
      campaigns_active: activeCampaigns.length,
      campaigns_incomplete: incompleteCampaigns.length,
      campaigns_no_metrics: campaignsNoMetrics.length,
      metrics_by_campaign: metricsByCampaign,

      // Produtos
      products_total: products.length,
      products_with_stock: productsWithStock,
      products_out_of_stock: productsOutOfStock,
      products_with_confirmed_cost: productsWithCost,

      // Keywords e termos
      keywords_total: keywords.length,
      search_terms_total: searchTerms.length,
      search_term_winners: searchTermWinners.length,
      term_bank_entries: termBank.length,

      // Dayparting
      top_conversion_hours: topConversionHours,

      // Config refs
      target_acos: TARGET_ACOS,
      max_acos: MAX_ACOS,
      min_bid: MIN_BID,
      max_bid: MAX_BID,

      duration_ms: Date.now() - start,
    };

    return Response.json({ ok: true, context });

  } catch (error) {
    return Response.json({ ok: false, error: (error as Error).message }, { status: 500 });
  }
});