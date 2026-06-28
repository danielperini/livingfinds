/**
 * importFromXano — Importa dados reais do Xano para a Base44
 *
 * Namespaces Xano:
 *   XANO_BASE_URL          → api:living-finds-api  (health, produtos legacy)
 *   XANO_BASE_URL_AMAZON   → api:amazon            (dashboard, sync_all, reports/download)
 *
 * Se XANO_BASE_URL_AMAZON não estiver definido, usa XANO_BASE_URL com namespace corrigido.
 *
 * Payload: { amazon_account_id, action? }
 *   "dashboard" → GET /dashboard (default)
 *   "sync"      → POST /sync_all + GET /dashboard
 *   "download"  → POST /reports/download + GET /dashboard
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function getBase(namespace) {
  const key = Deno.env.get('XANO_API_KEY');
  if (!key) throw new Error('XANO_API_KEY não configurada');

  const raw = (Deno.env.get('XANO_BASE_URL') || '').replace(/\/$/, '');
  if (!raw) throw new Error('XANO_BASE_URL não configurada');

  // Substituir namespace na URL base
  // Padrão: https://x8ki-letl-twmt.n7.xano.io/api:living-finds-api
  // → troca o api:XXXX pelo namespace pedido
  const base = raw.replace(/\/api:[^/\s]+$/, `/api:${namespace}`);
  return { base, key };
}

async function callXano(namespace, method, path, body) {
  const { base, key } = getBase(namespace);
  const opts = {
    method: method.toUpperCase(),
    headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
  };
  if (body && ['POST', 'PUT', 'PATCH'].includes(opts.method)) {
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${base}${path}`, opts);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`[${namespace}] ${path} → ${res.status}: ${data?.message || data?.error || text.slice(0, 150)}`);
  return data;
}

function normalizeArray(val, ...keys) {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  for (const k of keys) { if (val[k] && Array.isArray(val[k])) return val[k]; }
  const arrKey = Object.keys(val).find(k => Array.isArray(val[k]));
  return arrKey ? val[arrKey] : [];
}

Deno.serve(async (req) => {
  const startTime = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const amazonAccountId = body.amazon_account_id;
    const action = body.action || 'dashboard';
    if (!amazonAccountId) return Response.json({ error: 'amazon_account_id required' }, { status: 400 });

    const result = { action, ok: true };

    // 1. Health check via namespace living-finds-api
    try {
      const health = await callXano('living-finds-api', 'GET', '/health');
      result.health = health?.data || health;
    } catch (e) {
      result.health_error = e.message;
      // Se health falha, abortar
      return Response.json({ ok: false, error: `Health check falhou: ${e.message}`, result }, { status: 503 });
    }

    // 2. sync_all via namespace amazon
    if (action === 'sync') {
      try {
        const syncRes = await callXano('amazon', 'POST', '/sync_all', {});
        result.sync_all = syncRes?.data || syncRes;
      } catch (e) {
        result.sync_all_error = e.message;
      }
    }

    // 3. reports/download via namespace amazon
    if (action === 'sync' || action === 'download') {
      try {
        const dlRes = await callXano('amazon', 'POST', '/reports/download', {});
        result.reports_download = dlRes?.data || dlRes;

        const campaigns = normalizeArray(dlRes, 'campaigns', 'items', 'data');
        let campaignUpserted = 0;
        for (const c of campaigns) {
          const campaignId = String(c.amazon_campaign_id || c.campaignId || c.id || '');
          if (!campaignId) continue;
          const existing = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: amazonAccountId, campaign_id: campaignId });
          const record = {
            name: c.name || `Campaign ${campaignId}`,
            state: (c.state || c.status || 'enabled').toLowerCase().includes('paus') ? 'paused' : 'enabled',
            campaign_type: c.campaign_type || c.campaignType || 'SP',
            daily_budget: c.daily_budget || c.dailyBudget || 0,
            spend: c.spend || c.cost || 0,
            sales: c.sales || c.attributedSales30d || 0,
            impressions: c.impressions || 0,
            clicks: c.clicks || 0,
            orders: c.orders || c.attributedConversions30d || 0,
            acos: c.acos || 0,
            roas: c.roas || 0,
            ctr: c.ctr || 0,
            cpc: c.cpc || 0,
            synced_at: new Date().toISOString(),
          };
          if (existing.length > 0) {
            await base44.asServiceRole.entities.Campaign.update(existing[0].id, record);
          } else {
            await base44.asServiceRole.entities.Campaign.create({ ...record, amazon_account_id: amazonAccountId, campaign_id: campaignId });
          }
          campaignUpserted++;
        }
        result.campaigns_upserted = campaignUpserted;
      } catch (e) {
        result.reports_error = e.message;
      }
    }

    // 4. dashboard via namespace amazon
    try {
      const dash = await callXano('amazon', 'GET', '/dashboard');
      const dashData = dash?.data || dash;
      result.dashboard = dashData;

      // Persistir métricas diárias se houver
      const dailyData = normalizeArray(dashData, 'daily', 'metrics', 'history', 'data');
      let metricsUpserted = 0;
      for (const d of dailyData) {
        const date = d.date || d.day;
        if (!date) continue;
        const existing = await base44.asServiceRole.entities.CampaignMetricsDaily.filter({ amazon_account_id: amazonAccountId, date });
        const record = {
          spend: d.spend || d.cost || 0,
          sales: d.sales || d.revenue || 0,
          impressions: d.impressions || 0,
          clicks: d.clicks || 0,
          orders: d.orders || d.conversions || 0,
          acos: d.acos || 0,
          roas: d.roas || 0,
          ctr: d.ctr || 0,
          cpc: d.cpc || 0,
        };
        if (existing.length > 0) {
          await base44.asServiceRole.entities.CampaignMetricsDaily.update(existing[0].id, record);
        } else {
          await base44.asServiceRole.entities.CampaignMetricsDaily.create({ ...record, amazon_account_id: amazonAccountId, campaign_id: 'all', date });
        }
        metricsUpserted++;
      }
      result.metrics_upserted = metricsUpserted;

      // Persistir KPIs do dashboard diretamente nas campanhas se vier resumo
      const totalSpend = dashData?.total_spend || dashData?.spend || dashData?.data?.total_spend || 0;
      const totalSales = dashData?.total_revenue || dashData?.sales || dashData?.revenue || dashData?.data?.total_revenue || 0;
      result.kpis = { spend: totalSpend, sales: totalSales };

    } catch (e) {
      result.dashboard_error = e.message;
    }

    // 5. Atualizar conta + SyncRun
    await base44.asServiceRole.entities.AmazonAccount.update(amazonAccountId, {
      last_sync_at: new Date().toISOString(),
      status: 'connected',
    });
    await base44.asServiceRole.entities.SyncRun.create({
      amazon_account_id: amazonAccountId,
      operation: `importFromXano:${action}`,
      status: result.dashboard_error && !result.dashboard ? 'partial' : 'success',
      records_upserted: (result.campaigns_upserted || 0) + (result.metrics_upserted || 0),
      duration_ms: Date.now() - startTime,
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    });

    return Response.json({ ...result, duration_ms: Date.now() - startTime });

  } catch (error) {
    console.error('importFromXano failed:', error.message);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});