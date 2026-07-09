/**
 * syncUnifiedAdsReportsHourly
 * Relatório unificado por HORA — máximo 14 dias.
 * Usado para dayparting, detecção de gasto sem conversão e horário de melhor CVR.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function getAdsBaseUrl(region) {
  const r = (region || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function getAdsToken(refreshToken, clientId, clientSecret) {
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }).toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || 'Token failed');
  return data.access_token;
}

async function pollReport(baseUrl, token, clientId, profileId, reportId, maxWaitMs = 600000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    await new Promise(r => setTimeout(r, 15000));
    const res = await fetch(`${baseUrl}/reporting/reports/${reportId}`, {
      headers: { 'Authorization': `Bearer ${token}`, 'Amazon-Advertising-API-ClientId': clientId, 'Amazon-Advertising-API-Scope': profileId },
    });
    if (!res.ok) continue;
    const data = await res.json();
    if (data.status === 'COMPLETED') return data;
    if (data.status === 'FAILED') throw new Error(`Report failed: ${data.statusDetails}`);
  }
  throw new Error('Hourly report polling timeout');
}

async function downloadReport(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const buffer = await res.arrayBuffer();
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();
  writer.write(new Uint8Array(buffer));
  writer.close();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const text = new TextDecoder().decode(chunks.reduce((a, b) => { const c = new Uint8Array(a.length + b.length); c.set(a); c.set(b, a.length); return c; }, new Uint8Array(0)));
  return JSON.parse(text);
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    let account = null;
    if (body.amazon_account_id) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id });
      account = accs[0];
    }
    if (!account) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      account = accs[0];
    }
    if (!account) return Response.json({ ok: false, error: 'Conta não encontrada' });
    if (!account.unified_reports_access) {
      return Response.json({ ok: false, skipped: true, reason: 'unified_reports_access=false' });
    }

    const days = Math.min(body.days || 7, 14); // máximo 14 dias para hourly
    const endDate = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const startDate = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const now = new Date().toISOString();

    const token = await getAdsToken(
      account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN') || '',
      Deno.env.get('ADS_CLIENT_ID') || '',
      Deno.env.get('ADS_CLIENT_SECRET') || '',
    );
    const baseUrl = getAdsBaseUrl(account.region || 'NA');
    const profileId = String(account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID') || '');
    const clientId = Deno.env.get('ADS_CLIENT_ID') || '';

    const reportPayload = {
      name: `LivingFinds_Hourly_${startDate}_${endDate}`,
      startDate,
      endDate,
      configuration: {
        adProduct: 'SPONSORED_PRODUCTS',
        groupBy: ['campaignId', 'adGroupId'],
        columns: [
          'date', 'hour', 'campaignId', 'campaignName', 'adGroupId', 'adGroupName',
          'impressions', 'clicks', 'clickThroughRate', 'costPerClick', 'cost',
          'purchases14d', 'sales14d', 'promotedPurchases14d', 'promotedSales14d',
          'haloOrders14d', 'haloSales14d',
          'topOfSearchImpressionShare', 'impressionShare',
        ],
        reportTypeId: 'spCampaigns',
        timeUnit: 'HOURLY',
        format: 'GZIP_JSON',
      },
    };

    const createRes = await fetch(`${baseUrl}/reporting/reports`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Amazon-Advertising-API-ClientId': clientId,
        'Amazon-Advertising-API-Scope': profileId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(reportPayload),
    });

    if (!createRes.ok) {
      const err = await createRes.text();
      return Response.json({ ok: false, error: `Create report failed: ${createRes.status} - ${err.slice(0, 300)}` });
    }

    const createData = await createRes.json();
    const reportId = createData.reportId;
    if (!reportId) return Response.json({ ok: false, error: 'No reportId', data: createData });

    const completedReport = await pollReport(baseUrl, token, clientId, profileId, reportId);
    if (!completedReport.url) return Response.json({ ok: false, error: 'No download URL' });

    const records = await downloadReport(completedReport.url);
    if (!Array.isArray(records) || records.length === 0) {
      return Response.json({ ok: true, records_saved: 0, message: 'No hourly data' });
    }

    const toSave = records.map((r: any) => ({
      amazon_account_id: account.id,
      date: r.date,
      hour: Number(r.hour || 0),
      ad_product: 'SPONSORED_PRODUCTS',
      campaign_id: String(r.campaignId || ''),
      campaign_name: r.campaignName || '',
      ad_group_id: String(r.adGroupId || ''),
      ad_group_name: r.adGroupName || '',
      currency: account.currency_code || 'BRL',
      impressions: Number(r.impressions || 0),
      clicks: Number(r.clicks || 0),
      ctr: Number(r.clickThroughRate || 0),
      cpc: Number(r.costPerClick || 0),
      cost: Number(r.cost || 0),
      purchases: Number(r.purchases14d || 0),
      sales: Number(r.sales14d || 0),
      promoted_purchases: Number(r.promotedPurchases14d || 0),
      promoted_sales: Number(r.promotedSales14d || 0),
      halo_purchases: Number(r.haloOrders14d || 0),
      halo_sales: Number(r.haloSales14d || 0),
      impression_share: Number(r.impressionShare || 0),
      top_of_search_impression_share: Number(r.topOfSearchImpressionShare || 0),
      source: 'unified_reports',
      synced_at: now,
    }));

    let saved = 0;
    for (let i = 0; i < toSave.length; i += 100) {
      await base44.asServiceRole.entities.UnifiedAdsMetricsHourly.bulkCreate(toSave.slice(i, i + 100)).catch(() => {});
      saved += Math.min(100, toSave.length - i);
    }

    return Response.json({ ok: true, report_id: reportId, records_saved: saved, period: `${startDate} → ${endDate}` });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});