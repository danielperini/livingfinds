/**
 * requestAdsReport — Solicita relatório de métricas SP à Amazon Ads Reporting API
 * Retorna imediatamente com { reportId, status }
 * Payload: { amazon_account_id, days? }
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

async function adsPost(path, body) {
  const token = await getAdsToken();
  const res = await fetch(`${getAdsBaseUrl()}${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID'),
      'Amazon-Advertising-API-Scope': String(Deno.env.get('ADS_PROFILE_ID')),
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    // 425 = duplicado — extrair reportId existente
    if (res.status === 425) {
      const match = (data?.detail || '').match(/[0-9a-f]{8}-[0-9a-f-]{27}/);
      if (match) return { reportId: match[0], status: 'PENDING', _duplicate: true };
    }
    throw new Error(`ADS ${res.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const amazonAccountId = body.amazon_account_id;
    if (!amazonAccountId) return Response.json({ error: 'amazon_account_id required' }, { status: 400 });

    const days = body.days || 30;
    const endDate = new Date();
    const startDate = new Date(endDate - days * 86400000);
    const fmt = d => d.toISOString().slice(0, 10);

    const result = await adsPost('/reporting/reports', {
      name: `SP Metrics ${fmt(endDate)}`,
      startDate: fmt(startDate),
      endDate: fmt(endDate),
      configuration: {
        adProduct: 'SPONSORED_PRODUCTS',
        groupBy: ['campaign'],
        columns: ['campaignId', 'campaignName', 'impressions', 'clicks', 'cost', 'purchases1d', 'sales1d'],
        reportTypeId: 'spCampaigns',
        timeUnit: 'SUMMARY',
        format: 'GZIP_JSON',
      },
    });

    const reportId = result.reportId;
    if (!reportId) throw new Error('No reportId: ' + JSON.stringify(result));

    // Guardar reportId no SyncRun para referência
    await base44.asServiceRole.entities.SyncRun.create({
      amazon_account_id: amazonAccountId,
      operation: `metricsReport:${reportId}`,
      status: 'running',
      started_at: new Date().toISOString(),
    });

    return Response.json({
      ok: true,
      reportId,
      status: result.status || 'PENDING',
      duplicate: result._duplicate || false,
      message: 'Relatório solicitado. Chame downloadAdsReport em 2-5 minutos com o reportId.',
    });
  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});