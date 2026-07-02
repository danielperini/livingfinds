/**
 * auditSyncData — Auditoria de dados do último sync
 * Inclui detecção de duplicatas de campanhas por (amazon_account_id + campaign_id)
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

async function loadAllCampaigns(base44, amazonAccountId) {
  const all = [];
  let offset = 0;
  const PAGE = 200;
  while (true) {
    const page = await base44.entities.Campaign.filter(
      { amazon_account_id: amazonAccountId },
      '-created_date',
      PAGE,
      offset
    );
    all.push(...page);
    if (page.length < PAGE) break;
    offset += PAGE;
  }
  return all;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const accounts = await base44.entities.AmazonAccount.filter({ user_id: user.id });
    const account = accounts[0] || null;
    if (!account) return Response.json({ ok: false, message: 'Nenhuma conta Amazon' });

    const aid = account.id;

    // Métricas diárias — últimos 30 dias
    const cutoff = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const metricsDaily = await base44.entities.CampaignMetricsDaily.filter(
      { amazon_account_id: aid, date: { $gte: cutoff } }
    );

    const uniqueMetricsMap = new Map();
    metricsDaily.forEach(m => {
      const key = `${m.campaign_id}-${m.date}`;
      uniqueMetricsMap.set(key, m);
    });
    const uniqueMetrics = Array.from(uniqueMetricsMap.values());

    const totals = uniqueMetrics.reduce((acc, m) => ({
      spend: acc.spend + (m.spend || 0),
      sales: acc.sales + (m.sales || 0),
      clicks: acc.clicks + (m.clicks || 0),
      orders: acc.orders + (m.orders || 0),
      impressions: acc.impressions + (m.impressions || 0),
    }), { spend: 0, sales: 0, clicks: 0, orders: 0, impressions: 0 });

    // Campanhas — carregamento paginado completo
    const campaigns = await loadAllCampaigns(base44, aid);

    // Classificação correta: archived exclui do total operacional
    const activeCampaigns   = campaigns.filter(c => (c.state === 'enabled' || c.status === 'enabled') && !c.archived && c.state !== 'archived');
    const pausedCampaigns   = campaigns.filter(c => (c.state === 'paused'  || c.status === 'paused')  && !c.archived && c.state !== 'archived');
    const archivedCampaigns = campaigns.filter(c => c.archived || c.state === 'archived' || c.status === 'archived');
    const totalCurrent      = activeCampaigns.length + pausedCampaigns.length; // operacional

    // Detecção de duplicatas por campaign_id
    const byId = new Map();
    const duplicates = [];
    for (const c of campaigns) {
      const key = `${c.amazon_account_id}|${c.campaign_id}`;
      if (!byId.has(key)) {
        byId.set(key, c);
      } else {
        duplicates.push({ duplicate_db_id: c.id, campaign_id: c.campaign_id, name: c.name, created_date: c.created_date });
      }
    }

    // Sync runs
    const syncRuns = await base44.entities.SyncRun.filter({ amazon_account_id: aid }, '-started_at', 5);
    const lastSync = syncRuns[0];

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
        total_all: campaigns.length,
        total_current: totalCurrent,       // operacional = ativas + pausadas
        active: activeCampaigns.length,
        paused: pausedCampaigns.length,
        archived: archivedCampaigns.length,
        duplicates_found: duplicates.length,
        duplicate_campaign_ids: duplicates.map(d => d.campaign_id),
      },
      last_sync: lastSync ? {
        operation: lastSync.operation,
        status: lastSync.status,
        started_at: lastSync.started_at,
        completed_at: lastSync.completed_at,
        duration_ms: lastSync.duration_ms,
        records_upserted: lastSync.records_upserted,
      } : null,
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