/**
 * syncAdsMetrics — Busca métricas de campanhas SP via Amazon Ads Reporting API v3
 * Payload: { amazon_account_id, days? (default 30) }
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
  const r = (Deno.env.get('ADS_REGION') || 'NA').toUpperCase().trim();
  if (r.includes('EU') || r.includes('EUROP')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE') || r.includes('JAPAN') || r.includes('ASIA')) return 'https://advertising-api-fe.amazon.com';
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
    // 425 = duplicate report — extrair o reportId existente da mensagem
    if (res.status === 425) {
      const match = (data?.detail || '').match(/[0-9a-f-]{36}/);
      if (match) return { reportId: match[0], _duplicate: true };
    }
    throw new Error(`ADS ${res.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function waitForReport(reportId, maxWaitMs = 180000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    await new Promise(r => setTimeout(r, 10000));
    const status = await adsCall('GET', `/reporting/reports/${reportId}`);
    if (status.status === 'COMPLETED') return status.url;
    if (status.status === 'FAILED') throw new Error(`Report failed: ${JSON.stringify(status)}`);
  }
  throw new Error('Report timed out after 180s');
}

Deno.serve(async (req) => {
  const startTime = Date.now();
  let syncRunId = null;
  let base44;

  try {
    base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const amazonAccountId = body.amazon_account_id;
    if (!amazonAccountId) return Response.json({ error: 'amazon_account_id required' }, { status: 400 });

    const days = body.days || 30;
    const endDate = new Date();
    const startDate = new Date(endDate - days * 86400000);
    const fmt = d => d.toISOString().slice(0, 10);
    const startDateStr = fmt(startDate);
    const endDateStr = fmt(endDate);

    const syncRun = await base44.asServiceRole.entities.SyncRun.create({
      amazon_account_id: amazonAccountId,
      operation: 'syncAdsMetrics',
      status: 'running',
      started_at: new Date().toISOString(),
    });
    syncRunId = syncRun.id;

    // 1. Solicitar relatório (ou reutilizar duplicado)
    const reportReq = await adsCall('POST', '/reporting/reports', {
      name: `SP Campaign Metrics ${endDateStr}`,
      startDate: startDateStr,
      endDate: endDateStr,
      configuration: {
        adProduct: 'SPONSORED_PRODUCTS',
        groupBy: ['campaign'],
        columns: ['campaignId', 'campaignName', 'impressions', 'clicks', 'cost', 'purchases1d', 'sales1d'],
        reportTypeId: 'spCampaigns',
        timeUnit: 'SUMMARY',
        format: 'GZIP_JSON',
      },
    });

    const reportId = reportReq.reportId;
    if (!reportId) throw new Error('No reportId returned: ' + JSON.stringify(reportReq));

    // 2. Aguardar conclusão
    const downloadUrl = await waitForReport(reportId);

    // 3. Baixar e descomprimir GZIP
    const dlRes = await fetch(downloadUrl);
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
    if (!Array.isArray(rows)) throw new Error('Unexpected report format: ' + typeof rows);

    // 4. Upsert métricas em Campaign
    let upserted = 0;
    for (const row of rows) {
      const campaignId = String(row.campaignId);
      const spend = Number(row.cost) || 0;
      const sales = Number(row.sales1d) || 0;
      const clicks = Number(row.clicks) || 0;
      const impressions = Number(row.impressions) || 0;
      const orders = Number(row.purchases1d) || 0;
      const acos = sales > 0 ? (spend / sales * 100) : 0;
      const roas = spend > 0 ? (sales / spend) : 0;
      const ctr = impressions > 0 ? (clicks / impressions * 100) : 0;
      const cpc = clicks > 0 ? (spend / clicks) : 0;

      const existing = await base44.asServiceRole.entities.Campaign.filter({
        amazon_account_id: amazonAccountId,
        campaign_id: campaignId,
      });

      if (existing.length > 0) {
        await base44.asServiceRole.entities.Campaign.update(existing[0].id, {
          spend, sales, clicks, impressions, orders, acos, roas, ctr, cpc,
          synced_at: new Date().toISOString(),
        });
        upserted++;
      }
    }

    await base44.asServiceRole.entities.SyncRun.update(syncRunId, {
      status: 'success',
      records_received: rows.length,
      records_upserted: upserted,
      duration_ms: Date.now() - startTime,
      completed_at: new Date().toISOString(),
    });

    return Response.json({ ok: true, records_received: rows.length, records_upserted: upserted, days });

  } catch (error) {
    if (syncRunId && base44) {
      await base44.asServiceRole.entities.SyncRun.update(syncRunId, {
        status: 'error', error_message: error.message,
        duration_ms: Date.now() - startTime, completed_at: new Date().toISOString(),
      }).catch(() => {});
    }
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});