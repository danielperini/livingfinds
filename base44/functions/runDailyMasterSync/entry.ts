/**
 * runDailyMasterSync — Sync diário completo e autônomo
 *
 * Fluxo:
 * 1. Importa lista de campanhas da Amazon Ads API
 * 2. Solicita 3 relatórios SP (searchTerms, campaigns, products)
 * 3. Faz polling a cada 30s até os relatórios ficarem prontos (max 15 min)
 * 4. Baixa, descomprime e processa os dados
 * 5. Atualiza: CampaignMetricsDaily, SearchTerm, Campaign, Product
 * 6. Sincroniza inventário FBA (produtos + estoque)
 *
 * Pode ser invocado manualmente ou pelo scheduler.
 * Para automações agendadas, não requer auth de usuário.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

let _tokenCache = null;

async function getAdsToken(refreshToken) {
  if (_tokenCache && _tokenCache.expires_at > Date.now() + 5000) return _tokenCache.access_token;
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: Deno.env.get('ADS_CLIENT_ID') || '',
    client_secret: Deno.env.get('ADS_CLIENT_SECRET') || '',
  });
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Token failed: ${data.error_description || res.status}`);
  _tokenCache = { access_token: data.access_token, expires_at: Date.now() + (data.expires_in - 60) * 1000 };
  return data.access_token;
}

function getAdsBase(region) {
  const r = (region || Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function adsPost(base, path, token, profileId, body) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID') || '',
      'Amazon-Advertising-API-Scope': String(profileId),
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 500) }; }
  if (!res.ok && res.status === 425) {
    const match = JSON.stringify(data).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    if (match) return { reportId: match[0], _duplicate: true };
  }
  if (!res.ok) throw new Error(`ADS ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

async function adsGet(base, path, token, profileId) {
  const res = await fetch(`${base}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID') || '',
      'Amazon-Advertising-API-Scope': String(profileId),
      Accept: 'application/json',
    },
  });
  return await res.json();
}

async function decompress(buf) {
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();
  writer.write(new Uint8Array(buf));
  writer.close();
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { merged.set(c, off); off += c.length; }
  return JSON.parse(new TextDecoder().decode(merged));
}

function fmt(d) { return new Date(d).toISOString().slice(0, 10); }

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const REPORT_CONFIGS = [
  {
    key: 'campaigns',
    config: {
      adProduct: 'SPONSORED_PRODUCTS',
      groupBy: ['campaign'],
      columns: ['date', 'campaignId', 'campaignName', 'campaignStatus', 'campaignBudgetAmount',
        'impressions', 'clicks', 'cost',
        'purchases1d', 'purchases7d', 'purchases14d', 'purchases30d',
        'sales1d', 'sales7d', 'sales14d', 'sales30d',
        'acosClicks14d', 'roasClicks14d'],
      reportTypeId: 'spCampaigns',
      timeUnit: 'DAILY',
      format: 'GZIP_JSON',
    },
  },
  {
    key: 'searchTerms',
    config: {
      adProduct: 'SPONSORED_PRODUCTS',
      groupBy: ['searchTerm'],
      columns: ['date', 'campaignId', 'campaignName', 'adGroupId', 'adGroupName',
        'keywordId', 'keyword', 'matchType', 'searchTerm',
        'impressions', 'clicks', 'cost',
        'purchases1d', 'purchases7d', 'purchases14d', 'purchases30d',
        'sales1d', 'sales7d', 'sales14d', 'sales30d',
        'acosClicks14d', 'roasClicks14d'],
      reportTypeId: 'spSearchTerm',
      timeUnit: 'DAILY',
      format: 'GZIP_JSON',
    },
  },
  {
    key: 'products',
    config: {
      adProduct: 'SPONSORED_PRODUCTS',
      groupBy: ['advertiser'],
      columns: ['date', 'campaignId', 'campaignName', 'adGroupId', 'adGroupName',
        'advertisedAsin', 'advertisedSku',
        'impressions', 'clicks', 'cost',
        'purchases1d', 'purchases7d', 'purchases14d', 'purchases30d',
        'sales1d', 'sales7d', 'sales14d', 'sales30d'],
      reportTypeId: 'spAdvertisedProduct',
      timeUnit: 'DAILY',
      format: 'GZIP_JSON',
    },
  },
];

Deno.serve(async (req) => {
  const startTime = Date.now();
  const log = [];

  try {
    const base44 = createClientFromRequest(req);

    // Auth: suporta tanto chamadas de usuário quanto automações agendadas
    let amazonAccountId = null;
    try {
      const body = await req.clone().json().catch(() => ({}));
      amazonAccountId = body.amazon_account_id || null;
    } catch {}

    // Resolver conta
    let account = null;
    if (amazonAccountId) {
      account = await base44.asServiceRole.entities.AmazonAccount.get(amazonAccountId).catch(() => null);
    }
    if (!account) {
      const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-last_sync_at', 1);
      account = accounts[0] || null;
    }
    if (!account) {
      return Response.json({ ok: false, error: 'Nenhuma conta Amazon conectada' }, { status: 404 });
    }
    amazonAccountId = account.id;

    const refreshToken = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN');
    const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID');
    const adsBase = getAdsBase(account.region);
    const marketplaceId = account.marketplace_id || Deno.env.get('AMAZON_MARKETPLACE_ID') || 'A2Q3Y263D00KWC';

    if (!refreshToken) return Response.json({ ok: false, error: 'ADS_REFRESH_TOKEN não configurado' }, { status: 400 });
    if (!profileId) return Response.json({ ok: false, error: 'ADS_PROFILE_ID não configurado' }, { status: 400 });

    const now = new Date().toISOString();
    const today = fmt(Date.now());
    const endDate = fmt(Date.now() - 1 * 86400000); // ontem (dados maduros)
    const startDate = fmt(Date.now() - 30 * 86400000); // 30 dias atrás

    // ══════════════════════════════════════════════════════
    // PASSO 1: Importar lista de campanhas
    // ══════════════════════════════════════════════════════
    log.push('Importando campanhas...');
    const token = await getAdsToken(refreshToken);

    const campRes = await fetch(`${adsBase}/sp/campaigns/list`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID') || '',
        'Amazon-Advertising-API-Scope': String(profileId),
        'Content-Type': 'application/vnd.spCampaign.v3+json',
        Accept: 'application/vnd.spCampaign.v3+json',
      },
      body: JSON.stringify({ stateFilter: { include: ['ENABLED', 'PAUSED', 'ARCHIVED'] }, maxResults: 500 }),
    });

    let campaignsImported = 0;
    if (campRes.ok) {
      const campData = await campRes.json();
      const campaigns = campData?.campaigns || [];
      await base44.asServiceRole.entities.Campaign.deleteMany({ amazon_account_id: amazonAccountId });
      const campRecords = campaigns.map(c => ({
        amazon_account_id: amazonAccountId,
        campaign_id: String(c.campaignId),
        name: c.name,
        campaign_type: 'SP',
        targeting_type: c.targetingType,
        state: (c.state || 'ENABLED').toLowerCase(),
        status: (c.state || 'ENABLED').toLowerCase(),
        daily_budget: c.budget?.budget || c.dailyBudget || 0,
        start_date: c.startDate,
        end_date: c.endDate || null,
        bidding_strategy: c.dynamicBidding?.strategy || null,
        synced_at: now,
      }));
      for (let i = 0; i < campRecords.length; i += 500) {
        await base44.asServiceRole.entities.Campaign.bulkCreate(campRecords.slice(i, i + 500));
      }
      campaignsImported = campaigns.length;
      log.push(`✓ ${campaignsImported} campanhas importadas`);
    } else {
      const err = await campRes.text();
      log.push(`⚠ Falha ao importar campanhas: ${campRes.status} ${err.slice(0, 100)}`);
    }

    // ══════════════════════════════════════════════════════
    // PASSO 2: Solicitar relatórios de métricas
    // ══════════════════════════════════════════════════════
    log.push('Solicitando relatórios...');
    const reportIds = {};
    const ts = Date.now();

    const reportResults = await Promise.allSettled(
      REPORT_CONFIGS.map(async (rc) => {
        const result = await adsPost(adsBase, '/reporting/reports', token, profileId, {
          name: `LF_${rc.key}_${endDate}_${ts}`,
          startDate,
          endDate,
          configuration: rc.config,
        });
        return { key: rc.key, reportId: result.reportId };
      })
    );

    for (const r of reportResults) {
      if (r.status === 'fulfilled' && r.value.reportId) {
        reportIds[r.value.key] = r.value.reportId;
        log.push(`  ✓ ${r.value.key}: ${r.value.reportId}`);
      } else {
        log.push(`  ✗ ${r.reason?.message || 'Falha'}`);
      }
    }

    if (Object.keys(reportIds).length === 0) {
      return Response.json({ ok: false, error: 'Nenhum relatório solicitado', log }, { status: 500 });
    }

    // ══════════════════════════════════════════════════════
    // PASSO 3: Polling até os relatórios ficarem prontos
    // ══════════════════════════════════════════════════════
    log.push('Aguardando relatórios Amazon...');
    const MAX_WAIT_MS = 14 * 60 * 1000; // 14 minutos
    const POLL_INTERVAL_MS = 30 * 1000; // 30 segundos
    const waitStart = Date.now();
    const readyUrls = {};

    while (Date.now() - waitStart < MAX_WAIT_MS) {
      await sleep(POLL_INTERVAL_MS);
      const freshToken = await getAdsToken(refreshToken);
      const statuses = await Promise.all(
        Object.entries(reportIds)
          .filter(([key]) => !readyUrls[key])
          .map(async ([key, rid]) => {
            const s = await adsGet(adsBase, `/reporting/reports/${rid}`, freshToken, profileId);
            return { key, status: s.status, url: s.url };
          })
      );
      for (const s of statuses) {
        if (s.status === 'COMPLETED' && s.url) readyUrls[s.key] = s.url;
      }
      const pending = Object.keys(reportIds).filter(k => !readyUrls[k]);
      log.push(`  Aguardando: ${pending.join(', ') || 'nenhum'} (${Math.round((Date.now() - waitStart) / 1000)}s)`);
      if (pending.length === 0) break;
    }

    if (Object.keys(readyUrls).length === 0) {
      return Response.json({ ok: false, error: 'Relatórios não ficaram prontos no prazo de 14 minutos', log }, { status: 500 });
    }
    log.push(`✓ ${Object.keys(readyUrls).length} relatórios prontos`);

    // ══════════════════════════════════════════════════════
    // PASSO 4: Baixar e descomprimir relatórios
    // ══════════════════════════════════════════════════════
    log.push('Baixando relatórios...');
    const reportData = {};
    for (const [key, url] of Object.entries(readyUrls)) {
      const dlRes = await fetch(url);
      if (!dlRes.ok) { log.push(`  ✗ ${key}: download falhou ${dlRes.status}`); continue; }
      reportData[key] = await decompress(await dlRes.arrayBuffer());
      log.push(`  ✓ ${key}: ${reportData[key].length} linhas`);
    }

    // ══════════════════════════════════════════════════════
    // PASSO 5: Limpar dados antigos e processar
    // ══════════════════════════════════════════════════════
    log.push('Limpando dados antigos...');

    // Limpar SearchTerm, AdsMetricsHistory, AdsReportRaw (substituição completa)
    await Promise.all([
      base44.asServiceRole.entities.SearchTerm.deleteMany({ amazon_account_id: amazonAccountId }),
      base44.asServiceRole.entities.AdsMetricsHistory.deleteMany({ amazon_account_id: amazonAccountId }),
    ]);

    // Limpar CampaignMetricsDaily (últimos 31 dias)
    const datesToClear = [];
    for (let i = 0; i <= 31; i++) {
      datesToClear.push(fmt(Date.now() - i * 86400000));
    }
    for (const d of datesToClear) {
      await base44.asServiceRole.entities.CampaignMetricsDaily.deleteMany({ amazon_account_id: amazonAccountId, date: d });
    }

    log.push('Processando dados...');
    const seen = new Set();
    const historyRecords = [];
    const campaignMetricsMap = new Map();
    const prodAgg = new Map();

    // Processar cada relatório
    for (const [key, rows] of Object.entries(reportData)) {
      for (const row of rows) {
        const date = row.date || endDate;
        const campaignId = String(row.campaignId || '');
        const adGroupId = String(row.adGroupId || '');
        const searchTerm = row.searchTerm || '';
        const keywordId = String(row.keywordId || `kw_${row.keyword || 'none'}`);
        const asin = row.advertisedAsin || '';

        const uniqueKey = key === 'searchTerms'
          ? `${key}|${date}|${campaignId}|${adGroupId}|${searchTerm}|${keywordId}`
          : key === 'products'
          ? `${key}|${date}|${campaignId}|${adGroupId}|${asin}`
          : `${key}|${date}|${campaignId}`;

        if (seen.has(uniqueKey)) continue;
        seen.add(uniqueKey);

        const spend = Number(row.cost) || 0;
        const clicks = Number(row.clicks) || 0;
        const impressions = Number(row.impressions) || 0;
        const orders14d = Number(row.purchases14d) || 0;
        const sales14d = Number(row.sales14d) || 0;
        const sales30d = Number(row.sales30d) || 0;
        const orders30d = Number(row.purchases30d) || 0;

        historyRecords.push({
          amazon_account_id: amazonAccountId,
          date,
          campaign_id: campaignId,
          campaign_name: row.campaignName || '',
          ad_group_id: adGroupId,
          ad_group_name: row.adGroupName || '',
          keyword_id: keywordId,
          keyword_text: row.keyword || '',
          search_term: searchTerm,
          match_type: (row.matchType || '').toLowerCase(),
          advertised_asin: asin,
          advertised_sku: row.advertisedSku || '',
          report_type: key,
          impressions,
          clicks,
          spend,
          orders_1d: Number(row.purchases1d) || 0,
          orders_7d: Number(row.purchases7d) || 0,
          orders_14d: orders14d,
          orders_30d: orders30d,
          sales_1d: Number(row.sales1d) || 0,
          sales_7d: Number(row.sales7d) || 0,
          sales_14d: sales14d,
          sales_30d: sales30d,
          acos_14d: Number(row.acosClicks14d) || 0,
          roas_14d: Number(row.roasClicks14d) || 0,
          unique_key: uniqueKey,
          synced_at: now,
        });

        // Agregar métricas diárias por campanha
        const cmKey = `${campaignId}|${date}`;
        if (!campaignMetricsMap.has(cmKey)) {
          campaignMetricsMap.set(cmKey, {
            amazon_account_id: amazonAccountId,
            campaign_id: campaignId,
            date,
            spend: 0, sales: 0, clicks: 0, impressions: 0, orders: 0,
          });
        }
        // Usar apenas relatório 'campaigns' para métricas diárias (evitar double-count)
        if (key === 'campaigns') {
          const m = campaignMetricsMap.get(cmKey);
          m.spend += spend;
          m.sales += sales14d;
          m.clicks += clicks;
          m.impressions += impressions;
          m.orders += orders14d;
        }

        // Agregar por produto (ASIN)
        if (key === 'products' && asin) {
          if (!prodAgg.has(asin)) {
            prodAgg.set(asin, { asin, sku: row.advertisedSku || '', spend: 0, sales: 0, units: 0 });
          }
          const p = prodAgg.get(asin);
          p.spend += spend;
          p.sales += sales30d;
          p.units += orders30d;
        }
      }
    }

    // Bulk insert AdsMetricsHistory
    for (let i = 0; i < historyRecords.length; i += 500) {
      await base44.asServiceRole.entities.AdsMetricsHistory.bulkCreate(historyRecords.slice(i, i + 500));
    }
    log.push(`✓ AdsMetricsHistory: ${historyRecords.length}`);

    // SearchTerm
    const stRecords = historyRecords
      .filter(r => r.report_type === 'searchTerms' && r.search_term)
      .map(r => ({
        amazon_account_id: amazonAccountId,
        date: r.date,
        campaign_id: r.campaign_id,
        campaign_name: r.campaign_name,
        ad_group_id: r.ad_group_id,
        ad_group_name: r.ad_group_name,
        keyword_id: r.keyword_id,
        keyword_text: r.keyword_text,
        match_type: r.match_type,
        search_term: r.search_term,
        impressions: r.impressions,
        clicks: r.clicks,
        ctr: r.impressions > 0 ? r.clicks / r.impressions * 100 : 0,
        cpc: r.clicks > 0 ? r.spend / r.clicks : 0,
        spend: r.spend,
        orders_1d: r.orders_1d,
        orders_7d: r.orders_7d,
        orders_14d: r.orders_14d,
        orders_30d: r.orders_30d,
        sales_1d: r.sales_1d,
        sales_7d: r.sales_7d,
        sales_14d: r.sales_14d,
        sales_30d: r.sales_30d,
        acos_7d: 0,
        acos_14d: r.acos_14d,
        roas_7d: 0,
        roas_14d: r.roas_14d,
        conversion_rate: r.clicks > 0 ? r.orders_14d / r.clicks * 100 : 0,
        unique_key: r.unique_key,
        synced_at: now,
      }));
    for (let i = 0; i < stRecords.length; i += 500) {
      await base44.asServiceRole.entities.SearchTerm.bulkCreate(stRecords.slice(i, i + 500));
    }
    log.push(`✓ SearchTerm: ${stRecords.length}`);

    // CampaignMetricsDaily
    const cmRecords = Array.from(campaignMetricsMap.values()).map(m => ({
      ...m,
      acos: m.sales > 0 ? m.spend / m.sales * 100 : 0,
      roas: m.spend > 0 ? m.sales / m.spend : 0,
      ctr: m.impressions > 0 ? m.clicks / m.impressions * 100 : 0,
      cpc: m.clicks > 0 ? m.spend / m.clicks : 0,
    }));
    for (let i = 0; i < cmRecords.length; i += 500) {
      await base44.asServiceRole.entities.CampaignMetricsDaily.bulkCreate(cmRecords.slice(i, i + 500));
    }
    log.push(`✓ CampaignMetricsDaily: ${cmRecords.length}`);

    // Atualizar métricas de campanhas (spend/sales acumulados 30d)
    const campAgg30 = new Map();
    for (const r of historyRecords.filter(h => h.report_type === 'campaigns')) {
      if (!campAgg30.has(r.campaign_id)) {
        campAgg30.set(r.campaign_id, { spend: 0, sales: 0, clicks: 0, impressions: 0, orders: 0 });
      }
      const c = campAgg30.get(r.campaign_id);
      c.spend += r.spend;
      c.sales += r.sales_14d;
      c.clicks += r.clicks;
      c.impressions += r.impressions;
      c.orders += r.orders_14d;
    }

    const existingCamps = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: amazonAccountId }, null, 2000);
    const campMap = new Map(existingCamps.map(c => [c.campaign_id, c]));
    const campUpdates = [];
    for (const [campaignId, metrics] of campAgg30.entries()) {
      const existing = campMap.get(campaignId);
      if (!existing) continue;
      campUpdates.push({
        id: existing.id,
        spend: metrics.spend,
        sales: metrics.sales,
        clicks: metrics.clicks,
        impressions: metrics.impressions,
        orders: metrics.orders,
        acos: metrics.sales > 0 ? metrics.spend / metrics.sales * 100 : 0,
        roas: metrics.spend > 0 ? metrics.sales / metrics.spend : 0,
        ctr: metrics.impressions > 0 ? metrics.clicks / metrics.impressions * 100 : 0,
        cpc: metrics.clicks > 0 ? metrics.spend / metrics.clicks : 0,
        synced_at: now,
      });
    }
    for (let i = 0; i < campUpdates.length; i += 500) {
      await base44.asServiceRole.entities.Campaign.bulkUpdate(campUpdates.slice(i, i + 500));
    }
    log.push(`✓ Campaign metrics: ${campUpdates.length}`);

    // Atualizar métricas de produtos
    const existingProds = await base44.asServiceRole.entities.Product.filter({ amazon_account_id: amazonAccountId }, null, 2000);
    const prodMap = new Map(existingProds.map(p => [p.asin, p]));
    const prodUpdates = [];
    for (const [asin, metrics] of prodAgg.entries()) {
      const existing = prodMap.get(asin);
      if (!existing) continue;
      const acos = metrics.sales > 0 ? metrics.spend / metrics.sales * 100 : 0;
      const roas = metrics.spend > 0 ? metrics.sales / metrics.spend : 0;
      prodUpdates.push({
        id: existing.id,
        total_spend_30d: metrics.spend,
        total_sales_30d: metrics.sales,
        total_units_30d: metrics.units,
        acos,
        roas,
        last_sync_at: now,
        synced_at: now,
      });
    }
    for (let i = 0; i < prodUpdates.length; i += 500) {
      await base44.asServiceRole.entities.Product.bulkUpdate(prodUpdates.slice(i, i + 500));
    }
    log.push(`✓ Product metrics: ${prodUpdates.length}`);

    // ══════════════════════════════════════════════════════
    // PASSO 6: Sync de inventário FBA
    // ══════════════════════════════════════════════════════
    log.push('Sincronizando inventário FBA...');
    try {
      const invToken = await getAdsToken(refreshToken);
      const invRes = await fetch(`https://sellingpartnerapi-na.amazon.com/fba/inventory/v1/summaries?details=true&granularityType=Marketplace&granularityId=${marketplaceId}&marketplaceIds=${marketplaceId}`, {
        headers: {
          Authorization: `Bearer ${invToken}`,
          'x-amz-access-token': invToken,
        },
      });
      if (invRes.ok) {
        const invData = await invRes.json();
        const summaries = invData?.payload?.inventorySummaries || [];
        const invUpdates = [];
        const invCreates = [];
        for (const item of summaries) {
          if (!item.asin) continue;
          const totalQty = (item.inventoryDetails?.fulfillableQuantity || 0) + (item.inventoryDetails?.reservedQuantity?.totalReservedQuantity || 0);
          const inboundQty = item.inventoryDetails?.inboundShippingQuantity || 0;
          const inventoryStatus = totalQty === 0 ? 'out_of_stock' : totalQty < 10 ? 'low_stock' : 'in_stock';
          const existing = prodMap.get(item.asin);
          if (existing) {
            invUpdates.push({ id: existing.id, fba_inventory: totalQty, inbound_inventory: inboundQty, inventory_status: inventoryStatus, synced_at: now });
          } else {
            invCreates.push({ amazon_account_id: amazonAccountId, asin: item.asin, sku: item.sellerSku || '', product_name: item.productName || item.asin, fba_inventory: totalQty, inbound_inventory: inboundQty, inventory_status: inventoryStatus, status: 'active', synced_at: now });
          }
        }
        for (let i = 0; i < invUpdates.length; i += 500) await base44.asServiceRole.entities.Product.bulkUpdate(invUpdates.slice(i, i + 500));
        for (let i = 0; i < invCreates.length; i += 500) await base44.asServiceRole.entities.Product.bulkCreate(invCreates.slice(i, i + 500));
        log.push(`✓ Inventário: ${invUpdates.length} atualizados, ${invCreates.length} novos`);
      } else {
        log.push(`⚠ Inventário FBA ignorado (${invRes.status}) — credenciais SP-API`);
      }
    } catch (invErr) {
      log.push(`⚠ Inventário FBA ignorado: ${invErr.message}`);
    }

    // Atualizar last_sync_at da conta
    await base44.asServiceRole.entities.AmazonAccount.update(amazonAccountId, {
      last_sync_at: now,
      status: 'connected',
    });

    const durationS = ((Date.now() - startTime) / 1000).toFixed(1);
    log.push(`✅ Concluído em ${durationS}s`);

    return Response.json({
      ok: true,
      duration_s: durationS,
      campaigns_imported: campaignsImported,
      history_records: historyRecords.length,
      search_terms: stRecords.length,
      campaign_metrics: cmRecords.length,
      campaign_updates: campUpdates.length,
      product_updates: prodUpdates.length,
      log,
    });

  } catch (error) {
    console.error('[runDailyMasterSync] Erro:', error.message);
    return Response.json({ ok: false, error: error.message, log }, { status: 500 });
  }
});