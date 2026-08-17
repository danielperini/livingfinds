/**
 * syncUnifiedAdsReportsDaily
 * Solicita e processa relatório unificado Amazon Ads por DATA (granularidade DAILY).
 * Salva em UnifiedAdsMetricsDaily.
 * Limite: máximo 120 dias por chamada.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function getAdsBaseUrl(region?: string) {
  const r = (region || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function getAdsToken(refreshToken: string, clientId: string, clientSecret: string) {
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }).toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || 'Token refresh failed');
  return data.access_token;
}

async function pollReport(baseUrl: string, token: string, clientId: string, profileId: string, reportId: string, maxWaitMs = 600000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    await new Promise(r => setTimeout(r, 15000));
    const res = await fetch(`${baseUrl}/reporting/reports/${reportId}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Amazon-Advertising-API-ClientId': clientId,
        'Amazon-Advertising-API-Scope': profileId,
      },
    });
    if (!res.ok) continue;
    const data = await res.json();
    if (data.status === 'COMPLETED') return data;
    if (data.status === 'FAILED') throw new Error(`Report failed: ${data.statusDetails}`);
  }
  throw new Error('Report polling timeout after 10 minutes');
}

async function downloadReport(url: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const buffer = await res.arrayBuffer();
  // Decompress GZIP
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

function naturalKey(row: any) {
  return [
    row.amazon_account_id,
    row.date,
    row.campaign_id,
    row.ad_group_id,
    row.advertised_product_id,
    row.advertised_sku,
  ].map((value) => String(value || '').trim()).join('|');
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
      return Response.json({ ok: false, skipped: true, reason: 'unified_reports_access=false. Execute testUnifiedReportsAccess primeiro.' });
    }

    const days = Math.min(body.days || 30, 120);
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
      name: `LivingFinds_Daily_${startDate}_${endDate}`,
      startDate,
      endDate,
      configuration: {
        adProduct: 'SPONSORED_PRODUCTS',
        groupBy: ['campaignId', 'adGroupId', 'advertiserSku'],
        columns: [
          'date', 'campaignId', 'campaignName', 'campaignStatus', 'campaignBudget', 'campaignBudgetType',
          'adGroupId', 'adGroupName', 'adGroupStatus',
          'advertisedAsin', 'advertisedSku',
          'impressions', 'clicks', 'clickThroughRate', 'costPerClick', 'cost',
          'purchases14d', 'sales14d', 'unitsSoldClicks14d', 'purchaseRate', 'costPerPurchase14d', 'roasClicks14d',
          'promotedPurchases14d', 'promotedSales14d', 'promotedUnitsSold14d', 'promotedRoas14d', 'promotedAcos14d',
          'haloOrders14d', 'haloSales14d',
          'attributedOrdersNewToBrand14d', 'attributedSalesNewToBrand14d',
          'topOfSearchImpressionShare', 'impressionShare', 'impressionShareRank',
        ],
        reportTypeId: 'spCampaigns',
        timeUnit: 'DAILY',
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
      return Response.json({ ok: false, error: `Failed to create report: ${createRes.status} - ${err.slice(0, 300)}` });
    }

    const createData = await createRes.json();
    const reportId = createData.reportId;
    if (!reportId) return Response.json({ ok: false, error: 'No reportId returned', data: createData });

    // Poll for completion
    const completedReport = await pollReport(baseUrl, token, clientId, profileId, reportId);
    if (!completedReport.url) return Response.json({ ok: false, error: 'No download URL in completed report' });

    // Download and parse
    const records = await downloadReport(completedReport.url);
    if (!Array.isArray(records) || records.length === 0) {
      return Response.json({ ok: true, records_saved: 0, message: 'Report empty or no data for period' });
    }

    // Map and upsert
    const toSave = records.map((r: any) => ({
      amazon_account_id: account.id,
      profile_id: profileId,
      date: r.date,
      ad_product: 'SPONSORED_PRODUCTS',
      campaign_id: String(r.campaignId || ''),
      campaign_name: r.campaignName || '',
      campaign_status: r.campaignStatus || '',
      campaign_budget: Number(r.campaignBudget || 0),
      campaign_budget_type: r.campaignBudgetType || '',
      ad_group_id: String(r.adGroupId || ''),
      ad_group_name: r.adGroupName || '',
      ad_group_status: r.adGroupStatus || '',
      advertised_product_id: r.advertisedAsin || '',
      advertised_sku: r.advertisedSku || '',
      currency: account.currency_code || 'BRL',
      impressions: Number(r.impressions || 0),
      clicks: Number(r.clicks || 0),
      ctr: Number(r.clickThroughRate || 0),
      cpc: Number(r.costPerClick || 0),
      cost: Number(r.cost || 0),
      purchases: Number(r.purchases14d || 0),
      sales: Number(r.sales14d || 0),
      units_sold: Number(r.unitsSoldClicks14d || 0),
      purchase_rate: Number(r.purchaseRate || 0),
      click_purchase_rate: Number(r.purchaseRate || 0),
      cost_per_purchase: Number(r.costPerPurchase14d || 0),
      roas: Number(r.roasClicks14d || 0),
      promoted_purchases: Number(r.promotedPurchases14d || 0),
      promoted_sales: Number(r.promotedSales14d || 0),
      promoted_units_sold: Number(r.promotedUnitsSold14d || 0),
      promoted_roas: Number(r.promotedRoas14d || 0),
      promoted_acos: Number(r.promotedAcos14d || 0),
      halo_purchases: Number(r.haloOrders14d || 0),
      halo_sales: Number(r.haloSales14d || 0),
      impression_share: Number(r.impressionShare || 0),
      impression_share_rank: Number(r.impressionShareRank || 0),
      top_of_search_impression_share: Number(r.topOfSearchImpressionShare || 0),
      source: 'unified_reports',
      synced_at: now,
    }));

    // Upsert por chave natural. Relatórios de atribuição são reprocessados e
    // revisados; bulkCreate incondicional duplicava gasto, pedidos e vendas.
    const existingRows = await base44.asServiceRole.entities.UnifiedAdsMetricsDaily.filter(
      { amazon_account_id: account.id }, '-date', 30000,
    ).catch(() => []);
    const existingByKey = new Map<string, any>();
    for (const row of existingRows) {
      if (String(row.date || '') < startDate || String(row.date || '') > endDate) continue;
      const key = naturalKey(row);
      const current = existingByKey.get(key);
      const rowTime = new Date(row.synced_at || row.updated_at || row.created_at || 0).getTime();
      const currentTime = new Date(current?.synced_at || current?.updated_at || current?.created_at || 0).getTime();
      if (!current || rowTime >= currentTime) existingByKey.set(key, row);
    }

    const incomingByKey = new Map<string, any>();
    for (const row of toSave) incomingByKey.set(naturalKey(row), row);
    const uniqueToSave = Array.from(incomingByKey.values());
    const creates: any[] = [];
    const updates: any[] = [];
    for (const row of uniqueToSave) {
      const existing = existingByKey.get(naturalKey(row));
      if (existing?.id) updates.push({ id: existing.id, ...row });
      else creates.push(row);
    }
    for (let i = 0; i < creates.length; i += 100) {
      await base44.asServiceRole.entities.UnifiedAdsMetricsDaily.bulkCreate(creates.slice(i, i + 100));
    }
    for (let i = 0; i < updates.length; i += 100) {
      await base44.asServiceRole.entities.UnifiedAdsMetricsDaily.bulkUpdate(updates.slice(i, i + 100));
    }

    return Response.json({
      ok: true,
      report_id: reportId,
      records_total: records.length,
      records_unique: uniqueToSave.length,
      records_created: creates.length,
      records_updated: updates.length,
      records_saved: creates.length + updates.length,
      period: `${startDate} → ${endDate}`,
    });

  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || String(error) }, { status: 500 });
  }
});
