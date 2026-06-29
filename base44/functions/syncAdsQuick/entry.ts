/**
 * syncAdsQuick — Fluxo completo Amazon Ads directo em 2 fases:
 *   action="request"  → importa campanhas + solicita relatório 30d; devolve reportId
 *   action="download" → verifica status e baixa relatório quando pronto; popula métricas
 * Payload: { amazon_account_id, action, report_id? }
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const tokenCache = {};

async function getAdsToken() {
  const cached = tokenCache['ads'];
  if (cached && cached.expires_at > Date.now()) return cached.access_token;
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: Deno.env.get('ADS_REFRESH_TOKEN'),
    client_id: Deno.env.get('ADS_CLIENT_ID'),
    client_secret: Deno.env.get('ADS_CLIENT_SECRET'),
  });
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || 'Token refresh failed');
  tokenCache['ads'] = { access_token: data.access_token, expires_at: Date.now() + (data.expires_in - 60) * 1000 };
  return data.access_token;
}

function getAdsBaseUrl() {
  const r = (Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function adsCall(method, path, body) {
  const token = await getAdsToken();
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID'),
      'Amazon-Advertising-API-Scope': String(Deno.env.get('ADS_PROFILE_ID')),
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${getAdsBaseUrl()}${path}`, opts);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    // 425 = duplicate — extrair reportId existente
    if (res.status === 425) {
      const match = (data?.detail || JSON.stringify(data)).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
      if (match) return { reportId: match[0], _duplicate: true };
    }
    throw new Error(`ADS ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data;
}

Deno.serve(async (req) => {
  const startTime = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { amazon_account_id, action, report_id } = body;
    if (!amazon_account_id) return Response.json({ error: 'amazon_account_id required' }, { status: 400 });

    // ── FASE 1: importar campanhas + solicitar relatório ──────────────────
    if (action === 'request' || !action) {
      // 1a. Importar lista de campanhas via SP Campaigns API
      const adsBase = getAdsBaseUrl();
      const token = await getAdsToken();
      const campRes = await fetch(`${adsBase}/sp/campaigns/list`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID'),
          'Amazon-Advertising-API-Scope': String(Deno.env.get('ADS_PROFILE_ID')),
          'Content-Type': 'application/vnd.spCampaign.v3+json',
          'Accept': 'application/vnd.spCampaign.v3+json',
        },
        body: JSON.stringify({ stateFilter: { include: ['ENABLED', 'PAUSED', 'ARCHIVED'] }, maxResults: 500 }),
      });
      const campData = await campRes.json();
      if (!campRes.ok) throw new Error(`Campaigns list failed ${campRes.status}: ${JSON.stringify(campData).slice(0, 200)}`);

      const campaigns = campData?.campaigns || [];
      // Apagar existentes e reinserir em lote
      await base44.asServiceRole.entities.Campaign.deleteMany({ amazon_account_id });
      const records = campaigns.map(c => ({
        amazon_account_id,
        campaign_id: String(c.campaignId),
        name: c.name,
        campaign_type: 'SP',
        targeting_type: c.targetingType,
        state: (c.state || 'ENABLED').toLowerCase(),
        daily_budget: c.budget?.budget || c.dailyBudget || 0,
        start_date: c.startDate,
        end_date: c.endDate || null,
        bidding_strategy: c.dynamicBidding?.strategy || c.bidding?.strategy || null,
        synced_at: new Date().toISOString(),
      }));
      for (let i = 0; i < records.length; i += 500) {
        await base44.asServiceRole.entities.Campaign.bulkCreate(records.slice(i, i + 500));
      }

      // 1b. Solicitar relatório de métricas 30d
      const endDate = new Date();
      const startDate = new Date(endDate - 30 * 86400000);
      const fmt = d => d.toISOString().slice(0, 10);

      const reportReq = await adsCall('POST', '/reporting/reports', {
        name: `SP Campaigns 30d ${fmt(endDate)}`,
        startDate: fmt(startDate),
        endDate: fmt(endDate),
        configuration: {
          adProduct: 'SPONSORED_PRODUCTS',
          groupBy: ['campaign'],
          columns: ['campaignId', 'campaignName', 'impressions', 'clicks', 'cost',
            'purchases30d', 'sales30d', 'unitsSoldClicks30d'],
          reportTypeId: 'spCampaigns',
          timeUnit: 'SUMMARY',
          format: 'GZIP_JSON',
        },
      });

      const reportId = reportReq.reportId;
      if (!reportId) throw new Error('No reportId: ' + JSON.stringify(reportReq));

      await base44.asServiceRole.entities.AmazonAccount.update(amazon_account_id, {
        last_sync_at: new Date().toISOString(),
        status: 'connected',
      });

      return Response.json({
        ok: true,
        campaigns_imported: campaigns.length,
        report_id: reportId,
        duplicate: reportReq._duplicate || false,
        message: 'Campanhas importadas. Aguarde 2-10 min e chame action=download com o report_id.',
      });
    }

    // ── FASE 2: verificar status e baixar relatório ───────────────────────
    if (action === 'download') {
      if (!report_id) return Response.json({ error: 'report_id required for action=download' }, { status: 400 });

      const status = await adsCall('GET', `/reporting/reports/${report_id}`);

      if (status.status === 'PENDING' || status.status === 'PROCESSING') {
        return Response.json({ ok: true, ready: false, status: status.status, message: 'Relatório ainda a processar. Tente novamente em 1-2 min.' });
      }

      if (status.status === 'FAILED') {
        throw new Error(`Relatório falhou: ${status.failureReason || JSON.stringify(status)}`);
      }

      if (status.status !== 'COMPLETED' || !status.url) {
        return Response.json({ ok: true, ready: false, status: status.status });
      }

      // Baixar e descomprimir
      const dlRes = await fetch(status.url);
      if (!dlRes.ok) throw new Error(`Download failed: ${dlRes.status}`);

      const gzipped = await dlRes.arrayBuffer();
      const ds = new DecompressionStream('gzip');
      const writer = ds.writable.getWriter();
      const reader = ds.readable.getReader();
      writer.write(new Uint8Array(gzipped));
      writer.close();

      let jsonText = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        jsonText += new TextDecoder().decode(value);
      }

      const rows = JSON.parse(jsonText);
      if (!Array.isArray(rows)) throw new Error('Unexpected report format');

      // Upsert métricas nas campanhas existentes
      let upserted = 0;
      let totalSpend = 0, totalSales = 0, totalClicks = 0, totalImpressions = 0, totalOrders = 0;

      for (const row of rows) {
        const campaignId = String(row.campaignId);
        const spend = Number(row.cost) || 0;
        const sales = Number(row.sales30d) || 0;
        const clicks = Number(row.clicks) || 0;
        const impressions = Number(row.impressions) || 0;
        const orders = Number(row.purchases30d) || 0;
        const acos = sales > 0 ? (spend / sales * 100) : 0;
        const roas = spend > 0 ? (sales / spend) : 0;
        const ctr = impressions > 0 ? (clicks / impressions * 100) : 0;
        const cpc = clicks > 0 ? (spend / clicks) : 0;

        totalSpend += spend;
        totalSales += sales;
        totalClicks += clicks;
        totalImpressions += impressions;
        totalOrders += orders;

        const existing = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id, campaign_id: campaignId });
        if (existing.length > 0) {
          await base44.asServiceRole.entities.Campaign.update(existing[0].id, {
            spend, sales, clicks, impressions, orders, acos, roas, ctr, cpc,
            synced_at: new Date().toISOString(),
          });
          upserted++;
        }

        // Gravar métricas diárias (ponto único de hoje = summary 30d)
        const today = new Date().toISOString().slice(0, 10);
        const metricEx = await base44.asServiceRole.entities.CampaignMetricsDaily.filter({ amazon_account_id, campaign_id: campaignId, date: today });
        const metricRecord = { amazon_account_id, campaign_id: campaignId, date: today, spend, sales, clicks, impressions, orders, acos, roas, ctr, cpc };
        if (metricEx.length > 0) {
          await base44.asServiceRole.entities.CampaignMetricsDaily.update(metricEx[0].id, metricRecord);
        } else {
          await base44.asServiceRole.entities.CampaignMetricsDaily.create(metricRecord);
        }
      }

      await base44.asServiceRole.entities.SyncRun.create({
        amazon_account_id,
        operation: 'syncAdsQuick:download',
        status: 'success',
        records_received: rows.length,
        records_upserted: upserted,
        duration_ms: Date.now() - startTime,
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
      });

      return Response.json({
        ok: true,
        ready: true,
        rows: rows.length,
        upserted,
        summary: { total_spend: totalSpend, total_sales: totalSales, total_clicks: totalClicks, total_impressions: totalImpressions, total_orders: totalOrders },
      });
    }

    return Response.json({ error: 'action must be "request" or "download"' }, { status: 400 });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});