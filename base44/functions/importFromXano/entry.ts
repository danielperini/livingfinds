/**
 * importFromXano — Importa dados reais do Xano para a Base44
 *
 * Endpoints Xano (base: XANO_BASE_URL = https://[dominio]/api:amazon):
 *   GET  /health           → valida tokens Amazon
 *   GET  /dashboard        → resumo financeiro (Revenue, Spend, ROAS) 30 dias
 *   POST /sync_all         → importa campanhas/produtos e pede relatórios
 *   POST /reports/download → baixa métricas da Amazon
 *
 * Payload: { amazon_account_id, action? }
 *   action = "sync"     → POST /sync_all + POST /reports/download + GET /dashboard
 *   action = "download" → POST /reports/download + GET /dashboard
 *   action = "dashboard"→ GET /dashboard apenas (default)
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const XANO_BASE = Deno.env.get('XANO_BASE_URL')?.replace(/\/$/, '') || '';

async function callXano(method, path, body) {
  const key = Deno.env.get('XANO_API_KEY');
  if (!key) throw new Error('XANO_API_KEY não configurada nos secrets');
  if (!XANO_BASE) throw new Error('XANO_BASE_URL não configurada nos secrets');

  const opts = {
    method: method.toUpperCase(),
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': key,
    },
  };
  if (body && ['POST', 'PUT', 'PATCH'].includes(opts.method)) {
    opts.body = JSON.stringify(body);
  }

  const res = await fetch(`${XANO_BASE}${path}`, opts);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`Xano ${path} → ${res.status}: ${data?.message || data?.error || text.slice(0, 200)}`);
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

    // 1. Validar saúde (sempre)
    try {
      const health = await callXano('GET', '/health');
      result.health = health;
    } catch (e) {
      result.health_error = e.message;
    }

    // 2. Se action = "sync" → POST /sync_all
    if (action === 'sync') {
      try {
        const syncRes = await callXano('POST', '/sync_all', {});
        result.sync_all = syncRes;
      } catch (e) {
        result.sync_all_error = e.message;
      }
    }

    // 3. Se action = "sync" ou "download" → POST /reports/download
    if (action === 'sync' || action === 'download') {
      try {
        const dlRes = await callXano('POST', '/reports/download', {});
        result.reports_download = dlRes;

        // Persistir métricas de campanhas vindas do download
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
            targeting_type: c.targeting_type || c.targetingType || 'MANUAL',
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

    // 4. Sempre busca /dashboard para resumo financeiro
    try {
      const dash = await callXano('GET', '/dashboard');
      result.dashboard = dash;

      // Persistir métricas do dashboard em CampaignMetricsDaily se houver histórico
      const dailyData = normalizeArray(dash, 'daily', 'metrics', 'history', 'data');
      let metricsUpserted = 0;
      for (const d of dailyData) {
        const date = d.date || d.day;
        if (!date) continue;
        const existing = await base44.asServiceRole.entities.CampaignMetricsDaily.filter({
          amazon_account_id: amazonAccountId, date,
        });
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
          await base44.asServiceRole.entities.CampaignMetricsDaily.create({
            ...record, amazon_account_id: amazonAccountId, campaign_id: 'all', date,
          });
        }
        metricsUpserted++;
      }
      result.metrics_upserted = metricsUpserted;
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
      status: 'success',
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