/**
 * downloadAdsReport — Verifica e baixa relatório de métricas, actualiza campanhas
 * Payload: { amazon_account_id, report_id }
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

async function adsGet(path) {
  const token = await getAdsToken();
  const res = await fetch(`${getAdsBaseUrl()}${path}`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID'),
      'Amazon-Advertising-API-Scope': String(Deno.env.get('ADS_PROFILE_ID')),
      'Accept': 'application/json',
    },
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`ADS ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

Deno.serve(async (req) => {
  const startTime = Date.now();
  let base44;

  try {
    base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const amazonAccountId = body.amazon_account_id;
    const reportId = body.report_id;
    if (!amazonAccountId || !reportId) return Response.json({ error: 'amazon_account_id and report_id required' }, { status: 400 });

    // 1. Verificar status
    const reportStatus = await adsGet(`/reporting/reports/${reportId}`);

    if (reportStatus.status === 'PENDING' || reportStatus.status === 'PROCESSING') {
      return Response.json({ ok: true, ready: false, status: reportStatus.status, message: 'Relatório ainda a processar. Tente novamente em 1-2 minutos.' });
    }

    if (reportStatus.status === 'FAILED') {
      throw new Error(`Report failed: ${JSON.stringify(reportStatus)}`);
    }

    if (reportStatus.status !== 'COMPLETED') {
      return Response.json({ ok: true, ready: false, status: reportStatus.status });
    }

    // 2. Baixar e descomprimir
    const downloadUrl = reportStatus.url;
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
    if (!Array.isArray(rows)) throw new Error('Unexpected format: ' + typeof rows);

    // 3. Upsert métricas
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

    // Actualizar SyncRun
    const syncRuns = await base44.asServiceRole.entities.SyncRun.filter({ operation: `metricsReport:${reportId}` });
    if (syncRuns.length > 0) {
      await base44.asServiceRole.entities.SyncRun.update(syncRuns[0].id, {
        status: 'success',
        records_received: rows.length,
        records_upserted: upserted,
        duration_ms: Date.now() - startTime,
        completed_at: new Date().toISOString(),
      });
    }

    return Response.json({ ok: true, ready: true, records_received: rows.length, records_upserted: upserted });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});