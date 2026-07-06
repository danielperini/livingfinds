/**
 * syncAdsQuick — Fluxo completo Amazon Ads em 2 fases:
 *   action="request"  → importa campanhas + solicita relatório 30d; devolve reportId
 *   action="download" → verifica status e baixa relatório; popula métricas em lotes
 *
 * Processamento em lotes para evitar rate limit da Amazon e do SDK.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const BATCH_DB = 50;   // registros por operação bulk no DB
const BATCH_PAUSE_MS = 200; // pausa entre lotes para reduzir rate limit

function getAdsBaseUrl() {
  const r = (Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function getAdsToken(refreshToken: string) {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken || Deno.env.get('ADS_REFRESH_TOKEN') || '',
    client_id: Deno.env.get('ADS_CLIENT_ID') || '',
    client_secret: Deno.env.get('ADS_CLIENT_SECRET') || '',
  });
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || 'Token refresh failed');
  return data.access_token as string;
}

async function adsCall(method: string, path: string, body: any, token: string, profileId: string) {
  const opts: any = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID') || '',
      'Amazon-Advertising-API-Scope': String(profileId),
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${getAdsBaseUrl()}${path}`, opts);
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    if (res.status === 425) {
      const match = (data?.detail || JSON.stringify(data)).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
      if (match) return { reportId: match[0], _duplicate: true };
    }
    throw new Error(`ADS ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data;
}

async function pause(ms: number) {
  return new Promise(r => setTimeout(r, ms));
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

    const account = await base44.asServiceRole.entities.AmazonAccount.get(amazon_account_id).catch(() => null);
    const refreshToken = account?.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN') || '';
    const profileId = account?.ads_profile_id || Deno.env.get('ADS_PROFILE_ID') || '';

    // ── FASE 1: importar campanhas + solicitar relatório ──────────────────
    if (action === 'request' || !action) {
      const token = await getAdsToken(refreshToken);

      // Importar lista de campanhas (apenas ENABLED e PAUSED para não sobrecarregar)
      const campRes = await fetch(`${getAdsBaseUrl()}/sp/campaigns/list`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID') || '',
          'Amazon-Advertising-API-Scope': String(profileId),
          'Content-Type': 'application/vnd.spCampaign.v3+json',
          'Accept': 'application/vnd.spCampaign.v3+json',
        },
        body: JSON.stringify({ stateFilter: { include: ['ENABLED', 'PAUSED'] }, maxResults: 500 }),
      });
      const campData = await campRes.json();
      if (!campRes.ok) throw new Error(`Campaigns list failed ${campRes.status}: ${JSON.stringify(campData).slice(0, 200)}`);

      const campaigns: any[] = campData?.campaigns || [];

      // Carregar campanhas existentes para upsert (sem apagar tudo)
      const existingCamps = await base44.asServiceRole.entities.Campaign.filter(
        { amazon_account_id }, '-created_date', 1000
      ).catch(() => []);
      const existingById = new Map(existingCamps.map((c: any) => [String(c.campaign_id), c]));

      const toCreate: any[] = [];
      const toUpdate: any[] = [];
      const now = new Date().toISOString();

      for (const c of campaigns) {
        const id = String(c.campaignId);
        const state = (c.state || 'ENABLED').toLowerCase();
        const record = {
          amazon_account_id,
          campaign_id: id,
          amazon_campaign_id: id,
          name: c.name,
          campaign_name: c.name,
          campaign_type: 'SP',
          targeting_type: c.targetingType,
          state,
          status: state,
          archived: false,
          is_operational: state === 'enabled',
          daily_budget: c.budget?.budget || c.dailyBudget || 0,
          start_date: c.startDate,
          end_date: c.endDate || null,
          bidding_strategy: c.dynamicBidding?.strategy || c.bidding?.strategy || null,
          synced_at: now,
          last_api_sync_at: now,
        };
        const existing = existingById.get(id);
        if (existing) toUpdate.push({ id: existing.id, ...record });
        else toCreate.push(record);
      }

      // Processar em lotes com pausa para evitar rate limit
      for (let i = 0; i < toCreate.length; i += BATCH_DB) {
        await base44.asServiceRole.entities.Campaign.bulkCreate(toCreate.slice(i, i + BATCH_DB));
        if (i + BATCH_DB < toCreate.length) await pause(BATCH_PAUSE_MS);
      }
      for (let i = 0; i < toUpdate.length; i += BATCH_DB) {
        await base44.asServiceRole.entities.Campaign.bulkUpdate(toUpdate.slice(i, i + BATCH_DB));
        if (i + BATCH_DB < toUpdate.length) await pause(BATCH_PAUSE_MS);
      }

      // Solicitar relatório de métricas 30d
      const endDate = new Date();
      const startDate = new Date(endDate.getTime() - 30 * 86400000);
      const fmt = (d: Date) => d.toISOString().slice(0, 10);

      const reportReq = await adsCall('POST', '/reporting/reports', {
        name: `SP Campaigns 30d ${fmt(endDate)}-${Date.now()}`,
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
      }, token, profileId);

      const reportId = reportReq.reportId;
      if (!reportId) throw new Error('No reportId: ' + JSON.stringify(reportReq));

      await base44.asServiceRole.entities.AmazonAccount.update(amazon_account_id, {
        last_sync_at: now,
        status: 'connected',
      });

      return Response.json({
        ok: true,
        campaigns_imported: campaigns.length,
        campaigns_created: toCreate.length,
        campaigns_updated: toUpdate.length,
        report_id: reportId,
        duplicate: reportReq._duplicate || false,
        message: 'Campanhas importadas. Aguarde 2-10 min e chame action=download com o report_id.',
      });
    }

    // ── FASE 2: verificar status e baixar relatório ───────────────────────
    if (action === 'download') {
      if (!report_id) return Response.json({ error: 'report_id required for action=download' }, { status: 400 });

      const token = await getAdsToken(refreshToken);
      const status = await adsCall('GET', `/reporting/reports/${report_id}`, null, token, profileId);

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

      const rows: any[] = JSON.parse(jsonText);
      if (!Array.isArray(rows)) throw new Error('Unexpected report format');

      // Carregar todas as campanhas locais de uma vez (uma query, sem loop)
      const allCampaigns = await base44.asServiceRole.entities.Campaign.filter(
        { amazon_account_id }, '-created_date', 2000
      ).catch(() => []);
      const campById = new Map(allCampaigns.map((c: any) => [String(c.campaign_id), c]));

      // Carregar métricas diárias existentes de hoje de uma vez
      const today = new Date().toISOString().slice(0, 10);
      const existingMetrics = await base44.asServiceRole.entities.CampaignMetricsDaily.filter(
        { amazon_account_id, date: today }, '-created_date', 2000
      ).catch(() => []);
      const metricsById = new Map(existingMetrics.map((m: any) => [String(m.campaign_id), m]));

      // Construir listas de upsert
      const campUpdates: any[] = [];
      const metricsToCreate: any[] = [];
      const metricsToUpdate: any[] = [];
      let totalSpend = 0, totalSales = 0, totalClicks = 0, totalImpressions = 0, totalOrders = 0;
      const now = new Date().toISOString();

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

        const campLocal = campById.get(campaignId);
        if (campLocal) {
          campUpdates.push({ id: campLocal.id, spend, sales, clicks, impressions, orders, acos, roas, ctr, cpc, synced_at: now });
        }

        const metricRecord = { amazon_account_id, campaign_id: campaignId, date: today, spend, sales, clicks, impressions, orders, acos, roas, ctr, cpc };
        const existingMetric = metricsById.get(campaignId);
        if (existingMetric) metricsToUpdate.push({ id: existingMetric.id, ...metricRecord });
        else metricsToCreate.push(metricRecord);
      }

      // Aplicar updates em lotes com pausa
      for (let i = 0; i < campUpdates.length; i += BATCH_DB) {
        await base44.asServiceRole.entities.Campaign.bulkUpdate(campUpdates.slice(i, i + BATCH_DB));
        if (i + BATCH_DB < campUpdates.length) await pause(BATCH_PAUSE_MS);
      }

      for (let i = 0; i < metricsToCreate.length; i += BATCH_DB) {
        await base44.asServiceRole.entities.CampaignMetricsDaily.bulkCreate(metricsToCreate.slice(i, i + BATCH_DB));
        if (i + BATCH_DB < metricsToCreate.length) await pause(BATCH_PAUSE_MS);
      }

      for (let i = 0; i < metricsToUpdate.length; i += BATCH_DB) {
        await base44.asServiceRole.entities.CampaignMetricsDaily.bulkUpdate(metricsToUpdate.slice(i, i + BATCH_DB));
        if (i + BATCH_DB < metricsToUpdate.length) await pause(BATCH_PAUSE_MS);
      }

      await base44.asServiceRole.entities.SyncRun.create({
        amazon_account_id,
        operation: 'syncAdsQuick:download',
        status: 'success',
        records_received: rows.length,
        records_upserted: campUpdates.length,
        duration_ms: Date.now() - startTime,
        started_at: now,
        completed_at: new Date().toISOString(),
      });

      return Response.json({
        ok: true,
        ready: true,
        rows: rows.length,
        campaigns_updated: campUpdates.length,
        metrics_created: metricsToCreate.length,
        metrics_updated: metricsToUpdate.length,
        summary: { total_spend: totalSpend, total_sales: totalSales, total_clicks: totalClicks, total_impressions: totalImpressions, total_orders: totalOrders },
      });
    }

    return Response.json({ error: 'action must be "request" or "download"' }, { status: 400 });

  } catch (error: any) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});