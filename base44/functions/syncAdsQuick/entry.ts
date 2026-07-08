/**
 * syncAdsQuick — Fluxo unificado Amazon Ads:
 *   1. Importa campanhas + inventário FBA
 *   2. Solicita relatório 30d
 *   3. Aguarda 30 min fixos (relatórios Amazon raramente ficam prontos antes disso)
 *   4. Faz polling a cada 30s por até 10 min adicionais
 *   5. Baixa e processa métricas
 *
 * action="request" ainda suportado para compatibilidade (retorna report_id sem baixar).
 * action="download" ainda suportado para baixar um report_id existente.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const BATCH_DB = 50;
const BATCH_PAUSE_MS = 200;
const WAIT_BEFORE_POLL_MS = 30 * 60 * 1000;  // 30 min fixos antes do 1º poll
const POLL_INTERVAL_MS = 30_000;              // 30s entre checks
const POLL_MAX_ATTEMPTS = 20;                 // até 10 min adicionais

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

// ── Solicitar relatório de métricas 30d ──────────────────────────────────────
async function requestReport(token: string, profileId: string) {
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
  if (!reportReq.reportId) throw new Error('No reportId: ' + JSON.stringify(reportReq));
  return reportReq;
}

// ── Importar campanhas da Amazon para o DB ───────────────────────────────────
async function importCampaigns(base44: any, token: string, profileId: string, amazon_account_id: string) {
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
  const existingCamps = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id }, '-created_date', 1000).catch(() => []);
  const existingById = new Map(existingCamps.map((c: any) => [String(c.campaign_id), c]));
  const now = new Date().toISOString();
  const toCreate: any[] = [];
  const toUpdate: any[] = [];

  for (const c of campaigns) {
    const id = String(c.campaignId);
    const state = (c.state || 'ENABLED').toLowerCase();
    const record = {
      amazon_account_id, campaign_id: id, amazon_campaign_id: id,
      name: c.name, campaign_name: c.name, campaign_type: 'SP',
      targeting_type: c.targetingType, state, status: state,
      archived: false, is_operational: state === 'enabled',
      daily_budget: c.budget?.budget || c.dailyBudget || 0,
      start_date: c.startDate, end_date: c.endDate || null,
      bidding_strategy: c.dynamicBidding?.strategy || c.bidding?.strategy || null,
      synced_at: now, last_api_sync_at: now,
    };
    const existing = existingById.get(id);
    if (existing) toUpdate.push({ id: existing.id, ...record });
    else toCreate.push(record);
  }

  toUpdate.sort((a: any, b: any) => (b.daily_budget || 0) - (a.daily_budget || 0));

  for (let i = 0; i < toCreate.length; i += BATCH_DB) {
    await base44.asServiceRole.entities.Campaign.bulkCreate(toCreate.slice(i, i + BATCH_DB));
    if (i + BATCH_DB < toCreate.length) await pause(BATCH_PAUSE_MS);
  }
  for (let i = 0; i < toUpdate.length; i += BATCH_DB) {
    await base44.asServiceRole.entities.Campaign.bulkUpdate(toUpdate.slice(i, i + BATCH_DB));
    if (i + BATCH_DB < toUpdate.length) await pause(BATCH_PAUSE_MS);
  }

  return { campaigns_imported: campaigns.length, campaigns_created: toCreate.length, campaigns_updated: toUpdate.length };
}

// ── Sincronizar inventário FBA via SP-API ────────────────────────────────────
async function syncInventory(base44: any, account: any, amazon_account_id: string) {
  const spRefreshToken = Deno.env.get('AMAZON_SP_REFRESH_TOKEN') || Deno.env.get('SP_REFRESH_TOKEN') || '';
  const spClientId = Deno.env.get('AMAZON_LWA_CLIENT_ID') || Deno.env.get('SP_CLIENT_ID') || '';
  const spClientSecret = Deno.env.get('AMAZON_LWA_CLIENT_SECRET') || Deno.env.get('SP_CLIENT_SECRET') || '';
  const marketplaceId = account?.marketplace_id || Deno.env.get('AMAZON_MARKETPLACE_ID') || 'A2Q3Y263D00KWC';

  if (!spRefreshToken || !spClientId || !spClientSecret) return 0;

  const spTokenRes = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: spRefreshToken, client_id: spClientId, client_secret: spClientSecret }).toString(),
  });
  const spTokenData = await spTokenRes.json();
  const spToken = spTokenData.access_token;
  if (!spToken) return 0;

  const spBase = (account?.region || '').toUpperCase().includes('EU')
    ? 'https://sellingpartnerapi-eu.amazon.com'
    : 'https://sellingpartnerapi-na.amazon.com';

  const invRes = await fetch(
    `${spBase}/fba/inventory/v1/summaries?granularityType=Marketplace&granularityId=${marketplaceId}&marketplaceIds=${marketplaceId}`,
    { headers: { 'Authorization': `Bearer ${spToken}`, 'x-amz-access-token': spToken } }
  );
  if (!invRes.ok) return 0;

  const invData = await invRes.json();
  const summaries: any[] = invData?.payload?.inventorySummaries || [];
  const existingProducts = await base44.asServiceRole.entities.Product.filter({ amazon_account_id }, '-created_date', 500).catch(() => []);
  const productByAsin = new Map(existingProducts.map((p: any) => [p.asin, p]));
  const productBySku = new Map(existingProducts.map((p: any) => [p.sku, p]));
  const now = new Date().toISOString();
  const invUpdates: any[] = [];
  const invCreates: any[] = [];

  for (const s of summaries) {
    const asin = s.asin || '';
    const sku = s.sellerSku || '';
    const qty = s.inventoryDetails?.fulfillableQuantity ?? s.totalQuantity ?? 0;
    const inbound = (s.inventoryDetails?.inboundWorkingQuantity || 0) + (s.inventoryDetails?.inboundShippedQuantity || 0);
    const reserved = s.inventoryDetails?.reservedQuantity?.totalReservedQuantity || 0;
    const inventoryStatus = qty === 0 ? 'out_of_stock' : qty < 5 ? 'low_stock' : 'in_stock';
    const existing = productByAsin.get(asin) || productBySku.get(sku);
    const record: any = { fba_inventory: qty, reserved_inventory: reserved, inbound_inventory: inbound, inventory_status: inventoryStatus, last_sync_at: now };
    if (s.productName) record.product_name = s.productName;
    if (existing) invUpdates.push({ id: existing.id, ...record });
    else if (asin) invCreates.push({ amazon_account_id, asin, sku, product_name: s.productName || asin, ...record, status: 'active' });
  }

  for (let i = 0; i < invUpdates.length; i += BATCH_DB) {
    await base44.asServiceRole.entities.Product.bulkUpdate(invUpdates.slice(i, i + BATCH_DB));
    if (i + BATCH_DB < invUpdates.length) await pause(BATCH_PAUSE_MS);
  }
  for (let i = 0; i < invCreates.length; i += BATCH_DB) {
    await base44.asServiceRole.entities.Product.bulkCreate(invCreates.slice(i, i + BATCH_DB));
    if (i + BATCH_DB < invCreates.length) await pause(BATCH_PAUSE_MS);
  }
  return invUpdates.length + invCreates.length;
}

// ── Polling do relatório (após espera inicial) ───────────────────────────────
async function pollUntilReady(token: string, profileId: string, reportId: string): Promise<string | null> {
  console.log(`[syncAdsQuick] Aguardando 30 min antes do 1º poll (relatório: ${reportId})...`);
  await pause(WAIT_BEFORE_POLL_MS);

  for (let attempt = 1; attempt <= POLL_MAX_ATTEMPTS; attempt++) {
    const status = await adsCall('GET', `/reporting/reports/${reportId}`, null, token, profileId);
    console.log(`[syncAdsQuick] Poll ${attempt}/${POLL_MAX_ATTEMPTS}: status=${status.status}`);
    if (status.status === 'COMPLETED' && status.url) return status.url;
    if (status.status === 'FAILED') throw new Error(`Relatório falhou: ${status.failureReason || JSON.stringify(status)}`);
    await pause(POLL_INTERVAL_MS);
  }
  return null; // timeout
}

// ── Baixar e processar métricas do relatório ─────────────────────────────────
async function downloadAndProcess(base44: any, downloadUrl: string, amazon_account_id: string, startTime: number) {
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

  const rows: any[] = JSON.parse(jsonText);
  if (!Array.isArray(rows)) throw new Error('Unexpected report format');

  const allCampaigns = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id }, '-created_date', 2000).catch(() => []);
  const campById = new Map(allCampaigns.map((c: any) => [String(c.campaign_id), c]));

  const today = new Date().toISOString().slice(0, 10);
  const existingMetrics = await base44.asServiceRole.entities.CampaignMetricsDaily.filter({ amazon_account_id, date: today }, '-created_date', 2000).catch(() => []);
  const metricsById = new Map(existingMetrics.map((m: any) => [String(m.campaign_id), m]));

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

    totalSpend += spend; totalSales += sales; totalClicks += clicks;
    totalImpressions += impressions; totalOrders += orders;

    const campLocal = campById.get(campaignId);
    if (campLocal) campUpdates.push({ id: campLocal.id, spend, sales, clicks, impressions, orders, acos, roas, ctr, cpc, synced_at: now });

    const metricRecord = { amazon_account_id, campaign_id: campaignId, date: today, spend, sales, clicks, impressions, orders, acos, roas, ctr, cpc };
    const existingMetric = metricsById.get(campaignId);
    if (existingMetric) metricsToUpdate.push({ id: existingMetric.id, ...metricRecord });
    else metricsToCreate.push(metricRecord);
  }

  campUpdates.sort((a: any, b: any) => (b.spend || 0) - (a.spend || 0));

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
    amazon_account_id, operation: 'syncAdsQuick',
    status: 'success', records_received: rows.length, records_upserted: campUpdates.length,
    duration_ms: Date.now() - startTime, started_at: now, completed_at: new Date().toISOString(),
  });

  return { rows: rows.length, campaigns_updated: campUpdates.length, metrics_created: metricsToCreate.length, metrics_updated: metricsToUpdate.length, summary: { totalSpend, totalSales, totalClicks, totalImpressions, totalOrders } };
}

// ── Handler principal ────────────────────────────────────────────────────────
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

    // ── Modo compatibilidade: apenas solicitar relatório (sem esperar) ────────
    if (action === 'request') {
      const token = await getAdsToken(refreshToken);
      const [campResult, reportReq] = await Promise.all([
        importCampaigns(base44, token, profileId, amazon_account_id),
        requestReport(token, profileId),
      ]);
      const inventoryUpdated = await syncInventory(base44, account, amazon_account_id).catch(() => 0);
      await base44.asServiceRole.entities.AmazonAccount.update(amazon_account_id, { last_sync_at: new Date().toISOString(), status: 'connected' });
      return Response.json({ ok: true, ...campResult, inventory_updated: inventoryUpdated, report_id: reportReq.reportId, duplicate: reportReq._duplicate || false, message: 'Campanhas e inventário importados. Chame action=download com o report_id após ~30 min.' });
    }

    // ── Modo compatibilidade: baixar relatório existente (sem espera) ─────────
    if (action === 'download') {
      if (!report_id) return Response.json({ error: 'report_id required for action=download' }, { status: 400 });
      const token = await getAdsToken(refreshToken);
      // Polling imediato para compatibilidade (sem espera de 30 min)
      for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
        const status = await adsCall('GET', `/reporting/reports/${report_id}`, null, token, profileId);
        if (status.status === 'COMPLETED' && status.url) {
          const result = await downloadAndProcess(base44, status.url, amazon_account_id, startTime);
          return Response.json({ ok: true, ready: true, ...result });
        }
        if (status.status === 'FAILED') throw new Error(`Relatório falhou: ${status.failureReason}`);
        await pause(POLL_INTERVAL_MS);
      }
      return Response.json({ ok: true, ready: false, status: 'TIMEOUT', message: `Relatório não ficou pronto após ${POLL_MAX_ATTEMPTS} polls.` });
    }

    // ── Fluxo unificado padrão: request → esperar 30 min → download ──────────
    console.log('[syncAdsQuick] Iniciando fluxo unificado...');
    const token = await getAdsToken(refreshToken);

    // Fase 1: importar campanhas + inventário + solicitar relatório (em paralelo)
    const [campResult, reportReq, inventoryUpdated] = await Promise.all([
      importCampaigns(base44, token, profileId, amazon_account_id),
      requestReport(token, profileId),
      syncInventory(base44, account, amazon_account_id).catch(() => 0),
    ]);

    console.log(`[syncAdsQuick] Relatório solicitado: ${reportReq.reportId}. Aguardando 30 min...`);

    // Fase 2: esperar 30 min + polling
    const downloadUrl = await pollUntilReady(token, profileId, reportReq.reportId);

    if (!downloadUrl) {
      return Response.json({ ok: false, error: `Relatório não ficou pronto após 30 min de espera + ${POLL_MAX_ATTEMPTS} polls (${POLL_MAX_ATTEMPTS * 30}s)`, report_id: reportReq.reportId, ...campResult });
    }

    // Fase 3: baixar e processar métricas
    const result = await downloadAndProcess(base44, downloadUrl, amazon_account_id, startTime);

    await base44.asServiceRole.entities.AmazonAccount.update(amazon_account_id, { last_sync_at: new Date().toISOString(), status: 'connected' });

    return Response.json({
      ok: true,
      ...campResult,
      inventory_updated: inventoryUpdated,
      ...result,
      duration_ms: Date.now() - startTime,
    });

  } catch (error: any) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});