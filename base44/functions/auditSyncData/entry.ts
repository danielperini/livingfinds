/**
 * auditSyncData — Auditoria de dados do último sync
 * Compara totais do dashboard com valores crus dos relatórios Amazon
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    // Buscar conta Amazon
    const accounts = await base44.entities.AmazonAccount.filter({ user_id: user.id });
    const account = accounts[0] || null;
    if (!account) return Response.json({ ok: false, message: 'Nenhuma conta Amazon' });

    const aid = account.id;

    // Buscar últimos SyncRuns
    const syncRuns = await base44.entities.SyncRun.filter({ amazon_account_id: aid }, '-started_at', 5);
    const lastSync = syncRuns[0];

    // Buscar CampaignMetricsDaily dos últimos 30 dias
    const cutoff = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const metricsDaily = await base44.entities.CampaignMetricsDaily.filter(
      { amazon_account_id: aid, date: { $gte: cutoff } }
    );

    // Remover duplicatas por campaign_id + date
    const uniqueMap = new Map();
    metricsDaily.forEach(m => {
      const key = `${m.campaign_id}-${m.date}`;
      uniqueMap.set(key, m);
    });
    const uniqueMetrics = Array.from(uniqueMap.values());

    // Totais
    const totals = uniqueMetrics.reduce((acc, m) => ({
      spend: acc.spend + (m.spend || 0),
      sales: acc.sales + (m.sales || 0),
      clicks: acc.clicks + (m.clicks || 0),
      orders: acc.orders + (m.orders || 0),
      impressions: acc.impressions + (m.impressions || 0),
    }), { spend: 0, sales: 0, clicks: 0, orders: 0, impressions: 0 });

    // Campanhas
    const campaigns = await base44.entities.Campaign.filter({ amazon_account_id: aid });
    const activeCampaigns = campaigns.filter(c => c.state === 'enabled' && !c.archived);

    // Buscar dados crus do último relatório (se existir)
    let rawDataSummary = null;
    if (lastSync?.records_received) {
      // Tentar buscar relatório SUMMARY original (se disponível em AdsReportReques)
      const reports = await base44.entities.AdsReportReques.filter(
        { amazon_account_id: aid, status: 'DOWNLOADED' },
        '-completed_at',
        10
      );
      if (reports.length > 0) {
        rawDataSummary = { count: reports.length, last_report_id: reports[0].report_id };
      }
    }

    return Response.json({
      ok: true,
      account: { id: account.id, seller_name: account.seller_name, region: account.region },
      period: { cutoff, days: 30 },
      metrics: {
        total_records: metricsDaily.length,
        unique_records: uniqueMetrics.length,
        duplicates_removed: metricsDaily.length - uniqueMetrics.length,
      },
      totals_30d: {
        spend: totals.spend,
        sales: totals.sales,
        clicks: totals.clicks,
        orders: totals.orders,
        impressions: totals.impressions,
        acos: totals.sales > 0 ? (totals.spend / totals.sales * 100) : 0,
        roas: totals.spend > 0 ? (totals.sales / totals.spend) : 0,
        cpc: totals.clicks > 0 ? (totals.spend / totals.clicks) : 0,
        ctr: totals.impressions > 0 ? (totals.clicks / totals.impressions * 100) : 0,
        cvr: totals.clicks > 0 ? (totals.orders / totals.clicks * 100) : 0,
      },
      campaigns: {
        total: campaigns.length,
        active: activeCampaigns.length,
        paused: campaigns.filter(c => c.state === 'paused' && !c.archived).length,
        archived: campaigns.filter(c => c.archived).length,
      },
      last_sync: lastSync ? {
        operation: lastSync.operation,
        status: lastSync.status,
        started_at: lastSync.started_at,
        completed_at: lastSync.completed_at,
        duration_ms: lastSync.duration_ms,
        records_upserted: lastSync.records_upserted,
      } : null,
      raw_data: rawDataSummary,
      formatted: {
        spend: `$${totals.spend.toFixed(2)}`,
        sales: `$${totals.sales.toFixed(2)}`,
        acos: `${(totals.sales > 0 ? (totals.spend / totals.sales * 100) : 0).toFixed(2)}%`,
        roas: `${(totals.spend > 0 ? (totals.sales / totals.spend) : 0).toFixed(2)}x`,
        cpc: `$${(totals.clicks > 0 ? (totals.spend / totals.clicks) : 0).toFixed(2)}`,
      },
    });
  } catch (error) {
    return Response.json({ ok: false, error: error.message, stack: error.stack?.slice(0, 300) });
  }
});