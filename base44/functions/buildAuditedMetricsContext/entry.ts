/**
 * buildAuditedMetricsContext
 *
 * Camada de auditoria de métricas antes de qualquer decisão.
 * Garante: deduplicação, freshness, separação dia atual vs dias fechados,
 * validação de NaN/Infinity, data_quality_score, warnings.
 *
 * Retorna contexto estruturado que o motor de decisão consome.
 * NÃO chama Amazon. NÃO usa IA. Apenas lê banco e calcula.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function safe(v: unknown): number {
  const n = Number(v);
  return isNaN(n) || !isFinite(n) ? 0 : n;
}

function safeDiv(a: number, b: number): number {
  return b > 0 ? a / b : 0;
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysAgoStr(days: number): string {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}

function yesterdayStr(): string {
  return daysAgoStr(1);
}

// Deduplicar por chave composta
function dedupe<T extends Record<string, unknown>>(rows: T[], keyFn: (r: T) => string): T[] {
  const map = new Map<string, T>();
  for (const r of rows) {
    const k = keyFn(r);
    if (!map.has(k)) map.set(k, r);
  }
  return Array.from(map.values());
}

// Agregar métricas de um conjunto de linhas
function aggregate(rows: Record<string, unknown>[]): {
  spend: number; sales: number; orders: number; clicks: number; impressions: number;
  acos: number; roas: number; cpc: number; ctr: number; cvr: number;
} {
  const spend = rows.reduce((s, r) => s + safe(r.spend), 0);
  const sales = rows.reduce((s, r) => s + safe(r.sales), 0);
  const orders = rows.reduce((s, r) => s + safe(r.orders), 0);
  const clicks = rows.reduce((s, r) => s + safe(r.clicks), 0);
  const impressions = rows.reduce((s, r) => s + safe(r.impressions), 0);
  return {
    spend, sales, orders, clicks, impressions,
    acos: safeDiv(spend, sales) * 100,
    roas: safeDiv(sales, spend),
    cpc: safeDiv(spend, clicks),
    ctr: safeDiv(clicks, impressions) * 100,
    cvr: safeDiv(orders, clicks) * 100,
  };
}

// Calcular data_quality_score (0-100)
function calcDataQualityScore({
  hasMetrics, hasCampaigns, hasKeywords, hasProducts,
  freshness_hours, total_records, unique_dates, any_sales,
}: {
  hasMetrics: boolean; hasCampaigns: boolean; hasKeywords: boolean; hasProducts: boolean;
  freshness_hours: number; total_records: number; unique_dates: number; any_sales: boolean;
}): number {
  let score = 0;

  // Presença de dados (40 pts)
  if (hasMetrics) score += 15;
  if (hasCampaigns) score += 10;
  if (hasKeywords) score += 10;
  if (hasProducts) score += 5;

  // Freshness (30 pts)
  if (freshness_hours <= 24) score += 30;
  else if (freshness_hours <= 48) score += 20;
  else if (freshness_hours <= 72) score += 10;
  else score += 0;

  // Volume (20 pts)
  if (total_records >= 100) score += 10;
  else if (total_records >= 30) score += 5;
  if (unique_dates >= 14) score += 10;
  else if (unique_dates >= 7) score += 5;

  // Qualidade: tem vendas (10 pts)
  if (any_sales) score += 10;

  return Math.min(100, score);
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    // Autenticação: aceita _service_role para chamadas backend
    if (!body._service_role) {
      const auth = await base44.auth.isAuthenticated().catch(() => false);
      if (!auth) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    let amazonAccountId = body.amazon_account_id;
    if (!amazonAccountId) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      if (!accs.length) return Response.json({ ok: false, error: 'Nenhuma conta conectada' });
      amazonAccountId = accs[0].id;
    }

    const today = todayStr();
    const yesterday = yesterdayStr();

    // ── 1. Carregar dados do banco ────────────────────────────────────────
    const [accounts, metricsRaw, campaignsRaw, keywordsRaw, productsRaw, hourlyRaw] = await Promise.all([
      base44.asServiceRole.entities.AmazonAccount.filter({ id: amazonAccountId }),
      base44.asServiceRole.entities.CampaignMetricsDaily.filter({ amazon_account_id: amazonAccountId }, '-date', 1000),
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: amazonAccountId }, null, 500),
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: amazonAccountId }, '-spend', 500),
      base44.asServiceRole.entities.Product.filter({ amazon_account_id: amazonAccountId }, null, 300),
      base44.asServiceRole.entities.HourlyMetric.filter({ amazon_account_id: amazonAccountId }, '-date', 500),
    ]);

    const account = accounts[0] || null;
    if (!account) return Response.json({ ok: false, error: 'Conta não encontrada' });

    const freshness_hours = account.last_sync_at
      ? (Date.now() - new Date(account.last_sync_at).getTime()) / 3600000
      : 999;

    // ── 2. Deduplicar métricas ────────────────────────────────────────────
    const metrics = dedupe(metricsRaw, (r) => `${r.amazon_account_id}|${r.campaign_id}|${r.date}`);

    // Separar: dia atual (parcial) vs dias fechados
    const closedMetrics = metrics.filter(m => m.date && (m.date as string) < today);
    const todayMetrics = metrics.filter(m => m.date && (m.date as string) === today);

    // Dias fechados disponíveis
    const uniqueDates = [...new Set(closedMetrics.map(m => m.date as string))].sort();
    const closedPeriodEnd = uniqueDates.length > 0 ? uniqueDates[uniqueDates.length - 1] : yesterday;

    // Deduplicar campanhas e keywords
    const campaigns = dedupe(campaignsRaw, (c) => String(c.campaign_id || c.id));
    const keywords = dedupe(keywordsRaw, (k) => String(k.keyword_id || k.id));
    const hourly = dedupe(hourlyRaw, (h) => `${h.campaign_id}|${h.date}|${h.hour}`);

    // Separar campanhas por estado
    const activeCampaigns = campaigns.filter(c => {
      const st = String(c.state || c.status || '').toLowerCase();
      return st === 'enabled' && !c.archived;
    });
    const pausedCampaigns = campaigns.filter(c => {
      const st = String(c.state || c.status || '').toLowerCase();
      return st === 'paused';
    });
    const incompleteCampaigns = campaigns.filter(c => {
      const st = String(c.state || c.status || '').toLowerCase();
      return st === 'incomplete';
    });

    // ── 3. Calcular métricas por janela (7, 14, 30 dias fechados) ─────────
    function windowMetrics(days: number) {
      const start = daysAgoStr(days);
      const rows = closedMetrics.filter(m => (m.date as string) >= start && (m.date as string) <= yesterday);
      return { ...aggregate(rows), record_count: rows.length };
    }

    const metrics7d = windowMetrics(7);
    const metrics14d = windowMetrics(14);
    const metrics30d = windowMetrics(30);
    const todayAgg = aggregate(todayMetrics);

    // ── 4. Métricas por campanha (window 14d, deduplicado) ────────────────
    const campaignMetricsMap: Record<string, ReturnType<typeof aggregate> & { campaign_id: string }> = {};
    const start14 = daysAgoStr(14);
    for (const m of closedMetrics.filter(m => (m.date as string) >= start14)) {
      const cid = String(m.campaign_id || '');
      if (!cid) continue;
      if (!campaignMetricsMap[cid]) campaignMetricsMap[cid] = { campaign_id: cid, spend: 0, sales: 0, orders: 0, clicks: 0, impressions: 0, acos: 0, roas: 0, cpc: 0, ctr: 0, cvr: 0 };
      campaignMetricsMap[cid].spend += safe(m.spend);
      campaignMetricsMap[cid].sales += safe(m.sales);
      campaignMetricsMap[cid].orders += safe(m.orders);
      campaignMetricsMap[cid].clicks += safe(m.clicks);
      campaignMetricsMap[cid].impressions += safe(m.impressions);
    }
    for (const cid of Object.keys(campaignMetricsMap)) {
      const cm = campaignMetricsMap[cid];
      cm.acos = safeDiv(cm.spend, cm.sales) * 100;
      cm.roas = safeDiv(cm.sales, cm.spend);
      cm.cpc = safeDiv(cm.spend, cm.clicks);
      cm.ctr = safeDiv(cm.clicks, cm.impressions) * 100;
      cm.cvr = safeDiv(cm.orders, cm.clicks) * 100;
    }

    // ── 5. Classificar keywords ───────────────────────────────────────────
    const keywordMetrics = keywords.map(k => {
      const acos = safe(k.acos);
      const roas = safe(k.roas || (safe(k.spend) > 0 ? safe(k.sales) / safe(k.spend) : 0));
      const cpc = safe(k.cpc || safeDiv(safe(k.spend), safe(k.clicks)));
      const clicks = safe(k.clicks);
      const orders = safe(k.orders);
      const spend = safe(k.spend);
      const impressions = safe(k.impressions);
      const cvr = safeDiv(orders, clicks) * 100;
      const ctr = safeDiv(clicks, impressions) * 100;
      return { ...k, acos, roas, cpc, cvr, ctr, clicks, orders, spend, impressions };
    });

    // ── 6. Horários deduplicados (HourlyMetric) ───────────────────────────
    // Agregar por hora para os últimos 14d (excluindo hoje)
    const hourlyByHour: Record<number, { hour: number; impressions: number; clicks: number; spend: number; orders: number; sales: number; count: number }> = {};
    for (const h of hourly.filter(h => (h.date as string) < today)) {
      const hr = Number(h.hour || 0);
      if (!hourlyByHour[hr]) hourlyByHour[hr] = { hour: hr, impressions: 0, clicks: 0, spend: 0, orders: 0, sales: 0, count: 0 };
      hourlyByHour[hr].impressions += safe(h.impressions);
      hourlyByHour[hr].clicks += safe(h.clicks);
      hourlyByHour[hr].spend += safe(h.spend);
      hourlyByHour[hr].orders += safe(h.orders);
      hourlyByHour[hr].sales += safe(h.sales);
      hourlyByHour[hr].count++;
    }
    const hourlyMetrics = Object.values(hourlyByHour).map(h => ({
      ...h,
      acos: safeDiv(h.spend, h.sales) * 100,
      roas: safeDiv(h.sales, h.spend),
      cpc: safeDiv(h.spend, h.clicks),
      ctr: safeDiv(h.clicks, h.impressions) * 100,
      cvr: safeDiv(h.orders, h.clicks) * 100,
    })).sort((a, b) => a.hour - b.hour);

    // ── 7. Warnings e bloqueios ───────────────────────────────────────────
    const warnings: string[] = [];
    const blocked_reasons: string[] = [];

    if (freshness_hours > 48) warnings.push(`Dados desatualizados: ${Math.round(freshness_hours)}h desde o último sync`);
    if (uniqueDates.length < 3) warnings.push(`Poucos dias de dados fechados: ${uniqueDates.length} dias`);
    if (activeCampaigns.length === 0) warnings.push('Nenhuma campanha ativa encontrada');
    if (metrics30d.spend === 0) warnings.push('Nenhum gasto registrado nos últimos 30 dias');
    if (incompleteCampaigns.length > 0) warnings.push(`${incompleteCampaigns.length} campanha(s) incompleta(s)`);

    if (freshness_hours > 72) blocked_reasons.push('STALE_DATA: dados > 72h sem sync — decisões bloqueadas');
    if (account.status !== 'connected') blocked_reasons.push('ACCOUNT_DISCONNECTED');

    // ── 8. Data quality score ─────────────────────────────────────────────
    const data_quality_score = calcDataQualityScore({
      hasMetrics: metrics.length > 0,
      hasCampaigns: campaigns.length > 0,
      hasKeywords: keywords.length > 0,
      hasProducts: productsRaw.length > 0,
      freshness_hours,
      total_records: metrics.length,
      unique_dates: uniqueDates.length,
      any_sales: metrics30d.sales > 0,
    });

    // ── 9. Freshness status ───────────────────────────────────────────────
    const freshness_status =
      freshness_hours <= 24 ? 'fresh' :
      freshness_hours <= 48 ? 'acceptable' :
      freshness_hours <= 72 ? 'stale' : 'critical';

    return Response.json({
      ok: true,
      amazon_account_id: amazonAccountId,
      data_quality_score,
      freshness_status,
      freshness_hours: Math.round(freshness_hours * 10) / 10,
      last_sync_at: account.last_sync_at,
      metrics_period: {
        available_days: uniqueDates.length,
        first_date: uniqueDates[0] || null,
        last_closed_date: closedPeriodEnd,
        today,
        yesterday,
      },
      closed_period_end: closedPeriodEnd,
      summary: {
        metrics_7d: metrics7d,
        metrics_14d: metrics14d,
        metrics_30d: metrics30d,
        today_partial: todayAgg,
      },
      campaign_metrics: Object.values(campaignMetricsMap),
      keyword_metrics: keywordMetrics,
      hourly_metrics: hourlyMetrics,
      placement_metrics: [], // populado por relatório de placement quando disponível
      product_metrics: productsRaw.map(p => ({
        asin: p.asin, sku: p.sku,
        inventory_status: p.inventory_status,
        fba_inventory: p.fba_inventory,
        acos: p.acos, roas: p.roas,
        status: p.status,
        buy_box_status: p.buy_box_status,
      })),
      counts: {
        campaigns_total: campaigns.length,
        campaigns_active: activeCampaigns.length,
        campaigns_paused: pausedCampaigns.length,
        campaigns_incomplete: incompleteCampaigns.length,
        keywords_total: keywords.length,
        metrics_records: metrics.length,
        metrics_deduped_from: metricsRaw.length,
        hourly_records: hourly.length,
      },
      warnings,
      blocked_reasons,
      can_auto_decide: data_quality_score >= 80 && blocked_reasons.length === 0,
      generated_at: new Date().toISOString(),
    });
  } catch (error) {
    return Response.json({ ok: false, error: (error as Error).message }, { status: 500 });
  }
});