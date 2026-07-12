/**
 * syncSalesDailyFromReports
 *
 * Popula SalesDaily a partir dos relatórios spAdvertisedProduct já baixados
 * em AdsReportRaw — sem precisar chamar a SP-API novamente.
 *
 * Lógica:
 *   - Lê todos os AdsReportRaw tipo 'products' dos últimos 62 dias
 *   - Agrega por (date, advertised_asin): soma sales_14d, orders_14d, units
 *   - Faz upsert em SalesDaily
 *   - Também usa CampaignMetricsDaily como fonte complementar
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function num(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    const isAuth = await base44.auth.isAuthenticated().catch(() => false);
    if (!isAuth && !body._service_role) {
      return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    // Resolver conta
    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter(
      { status: 'connected' }, '-updated_date', 1
    ).catch(() => []);
    const account = accounts[0];
    if (!account) return Response.json({ ok: false, error: 'Nenhuma conta conectada' });
    const aid = account.id;

    const since62 = new Date(Date.now() - 62 * 86400000).toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

    // 1. Ler todos os AdsReportRaw (products) dos últimos 62 dias
    const allRaw = await base44.asServiceRole.entities.AdsReportRaw.filter(
      { amazon_account_id: aid }, '-period_end', 2000
    ).catch(() => []);

    // 2. Agregar por (date, asin)
    // Usa sales_14d como melhor proxy de faturamento real para o dia
    const byDateAsin: Record<string, { revenue: number; units: number; orders: number }> = {};

    for (const r of allRaw) {
      const rd = typeof r.raw_data === 'string' ? JSON.parse(r.raw_data) : r.raw_data;
      if (!rd) continue;

      const date: string = rd.date || r.period_start || '';
      const asin: string = rd.advertised_asin || rd.asin || '';
      if (!date || !asin || date < since62 || date > yesterday) continue;

      const key = `${date}__${asin}`;
      if (!byDateAsin[key]) byDateAsin[key] = { revenue: 0, units: 0, orders: 0 };

      // Usar sales_14d como atribuição principal (janela padrão da Amazon)
      // Se não houver, tentar sales_30d
      const sales = num(rd.sales_14d || rd.sales_30d || 0);
      const orders = num(rd.orders_14d || rd.orders_30d || 0);

      byDateAsin[key].revenue += sales;
      byDateAsin[key].units += orders; // ordens como proxy de unidades
      byDateAsin[key].orders += orders;
    }

    // 3. Também complementar com CampaignMetricsDaily (campos sales/orders agregados)
    const metricsRaw = await base44.asServiceRole.entities.CampaignMetricsDaily.filter(
      { amazon_account_id: aid }, '-date', 5000
    ).catch(() => []);

    // Para dias sem dados em AdsReportRaw, usar CampaignMetricsDaily como fallback
    // Precisamos do asin por campaign_id — buscar campanhas para o mapeamento
    const campaigns = await base44.asServiceRole.entities.Campaign.filter(
      { amazon_account_id: aid }, null, 2000
    ).catch(() => []);

    const campaignAsinMap: Record<string, string> = {};
    for (const c of campaigns) {
      const cid = c.campaign_id || c.amazon_campaign_id || '';
      if (cid && c.asin) campaignAsinMap[cid] = c.asin;
    }

    // Agregar CampaignMetricsDaily por data (sem asin — só como fallback de conta total)
    // Usar apenas quando não há dados de produto
    const metricsByDate: Record<string, { revenue: number; orders: number }> = {};
    for (const m of metricsRaw) {
      if (!m.date || m.date < since62 || m.date > yesterday) continue;
      if (!metricsByDate[m.date]) metricsByDate[m.date] = { revenue: 0, orders: 0 };
      metricsByDate[m.date].revenue += m.sales || 0;
      metricsByDate[m.date].orders += m.orders || 0;
    }

    // Para dias sem nenhum dado de produto em AdsReportRaw, criar um registro genérico
    // com asin='account_total' para não perder o dado de faturamento
    for (const [date, v] of Object.entries(metricsByDate)) {
      const hasProductData = Object.keys(byDateAsin).some(k => k.startsWith(date + '__'));
      if (!hasProductData && v.revenue > 0) {
        const key = `${date}__account_total`;
        byDateAsin[key] = { revenue: v.revenue, units: v.orders, orders: v.orders };
      }
    }

    // 4. Preparar registros para upsert
    const records: any[] = [];
    for (const [key, v] of Object.entries(byDateAsin)) {
      const [date, asin] = key.split('__');
      if (!date || !asin) continue;
      records.push({
        amazon_account_id: aid,
        date,
        asin: asin === 'account_total' ? '' : asin,
        units_ordered: v.units,
        ordered_product_sales: parseFloat(v.revenue.toFixed(2)),
        orders: v.orders,
        sessions: 0,
        page_views: 0,
        buy_box_pct: 0,
        conversion_rate: 0,
        source: 'ads_report',
      });
    }

    if (records.length === 0) {
      return Response.json({ ok: true, message: 'Nenhum dado de produto encontrado nos relatórios', records_saved: 0 });
    }

    // 5. Deletar SalesDaily do período e recriar com dados mais recentes
    await base44.asServiceRole.entities.SalesDaily.deleteMany({
      amazon_account_id: aid,
      date: { $gte: since62, $lte: yesterday },
    }).catch(() => {});

    // Inserir em batches
    const BATCH = 100;
    let saved = 0;
    for (let i = 0; i < records.length; i += BATCH) {
      await base44.asServiceRole.entities.SalesDaily.bulkCreate(records.slice(i, i + BATCH));
      saved += Math.min(BATCH, records.length - i);
    }

    // Log de execução
    const today = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: aid,
      operation: 'sync_sales_daily_from_reports',
      trigger_type: body._service_role ? 'automatic' : 'manual',
      status: 'success',
      execution_date: today,
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      records_processed: saved,
      result_summary: JSON.stringify({ raw_records_processed: allRaw.length, sales_daily_records: saved, period: `${since62}→${yesterday}` }),
    }).catch(() => {});

    return Response.json({
      ok: true,
      records_saved: saved,
      raw_records_read: allRaw.length,
      period: { start: since62, end: yesterday },
      message: `${saved} registros SalesDaily atualizados a partir dos relatórios baixados`,
    });

  } catch (error: any) {
    console.error('[syncSalesDailyFromReports]', error.message);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});