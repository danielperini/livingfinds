/**
 * scheduledAdsReportSync — Pipeline completo para relatórios Amazon Ads
 * 
 * action="request": Solicita relatórios de 30 dias
 * action="download": Limpa dados antigos, baixa, processa e armazena TUDO
 * 
 * Estratégia:
 * - Delete completo dos últimos 30 dias antes de insert
 * - Salva raw data em AdsReportRaw (para IA/auditoria)
 * - Salva histórico em AdsMetricsHistory (todas as métricas)
 * - Atualiza entidades operacionais (SearchTerm, Campaign, Product)
 * - NÃO soma dados entre relatórios — substitui completamente
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
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
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

async function adsGet(base, path, token, profileId) {
  const res = await fetch(`${base}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID') || '',
      'Amazon-Advertising-API-Scope': profileId,
      Accept: 'application/json',
    },
  });
  return await res.json();
}

async function adsPost(base, path, token, profileId, body) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID') || '',
      'Amazon-Advertising-API-Scope': profileId,
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

async function decompress(arrayBuffer) {
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();
  writer.write(new Uint8Array(arrayBuffer));
  writer.close();
  
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  
  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(merged));
}

function fmt(d) { return d.toISOString().slice(0, 10); }

// Configurações de relatórios — apenas colunas válidas
const REPORT_CONFIGS = [
  {
    key: 'searchTerms',
    config: {
      adProduct: 'SPONSORED_PRODUCTS',
      groupBy: ['searchTerm'],
      columns: [
        'date', 'campaignId', 'campaignName', 'adGroupId', 'adGroupName',
        'keywordId', 'keyword', 'keywordType', 'matchType', 'searchTerm',
        'impressions', 'clicks', 'cost',
        'purchases1d', 'purchases7d', 'purchases14d', 'purchases30d',
        'unitsSoldClicks1d', 'unitsSoldClicks7d', 'unitsSoldClicks14d', 'unitsSoldClicks30d',
        'sales1d', 'sales7d', 'sales14d', 'sales30d',
        'attributedSalesSameSku1d', 'attributedSalesSameSku7d', 'attributedSalesSameSku14d', 'attributedSalesSameSku30d',
        'unitsSoldSameSku1d', 'unitsSoldSameSku7d', 'unitsSoldSameSku14d', 'unitsSoldSameSku30d',
        'acosClicks14d', 'roasClicks14d',
      ],
      reportTypeId: 'spSearchTerm',
      timeUnit: 'DAILY',
      format: 'GZIP_JSON',
    },
  },
  {
    key: 'campaigns',
    config: {
      adProduct: 'SPONSORED_PRODUCTS',
      groupBy: ['campaign'],
      columns: [
        'date', 'campaignId', 'campaignName', 'campaignStatus', 'campaignBudgetAmount', 'campaignBiddingStrategy',
        'impressions', 'clicks', 'cost',
        'purchases1d', 'purchases7d', 'purchases14d', 'purchases30d',
        'unitsSoldClicks1d', 'unitsSoldClicks7d', 'unitsSoldClicks14d', 'unitsSoldClicks30d',
        'sales1d', 'sales7d', 'sales14d', 'sales30d',
        'attributedSalesSameSku1d', 'attributedSalesSameSku7d', 'attributedSalesSameSku14d', 'attributedSalesSameSku30d',
        'acosClicks14d', 'roasClicks14d',
      ],
      reportTypeId: 'spCampaigns',
      timeUnit: 'DAILY',
      format: 'GZIP_JSON',
    },
  },
  {
    key: 'products',
    config: {
      adProduct: 'SPONSORED_PRODUCTS',
      groupBy: ['advertiser'],
      columns: [
        'date', 'campaignId', 'campaignName', 'adGroupId', 'adGroupName',
        'adId', 'advertisedAsin', 'advertisedSku',
        'impressions', 'clicks', 'cost',
        'purchases1d', 'purchases7d', 'purchases14d', 'purchases30d',
        'unitsSoldClicks1d', 'unitsSoldClicks7d', 'unitsSoldClicks14d', 'unitsSoldClicks30d',
        'sales1d', 'sales7d', 'sales14d', 'sales30d',
      ],
      reportTypeId: 'spAdvertisedProduct',
      timeUnit: 'DAILY',
      format: 'GZIP_JSON',
    },
  },
];

// Limpa dados dos últimos 30 dias antes de importar
async function clearLast30Days(base44, amazonAccountId, startDate, endDate) {
  console.log(`[clearLast30Days] Limpando dados de ${startDate} a ${endDate}`);
  
  // Limpar SearchTerm por date range
  await base44.asServiceRole.entities.SearchTerm.deleteMany({
    amazon_account_id: amazonAccountId,
  });
  
  // Limpar AdsMetricsHistory
  await base44.asServiceRole.entities.AdsMetricsHistory.deleteMany({
    amazon_account_id: amazonAccountId,
  });
  
  // Limpar AdsReportRaw
  await base44.asServiceRole.entities.AdsReportRaw.deleteMany({
    amazon_account_id: amazonAccountId,
  });
  
  // Limpar CampaignMetricsDaily (apenas últimos 30 dias)
  const dates = [];
  const start = new Date(startDate);
  const end = new Date(endDate);
  for (let d = start; d <= end; d.setDate(d.getDate() + 1)) {
    dates.push(fmt(d));
  }
  
  for (const date of dates) {
    await base44.asServiceRole.entities.CampaignMetricsDaily.deleteMany({
      amazon_account_id: amazonAccountId,
      date,
    });
  }
  
  console.log(`[clearLast30Days] Dados limpos`);
}

Deno.serve(async (req) => {
  const startTime = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    
    let user = null;
    try { user = await base44.auth.me(); } catch {}
    
    const body = await req.json().catch(() => ({}));
    const action = body.action || 'request';
    let amazonAccountId = body.amazon_account_id;
    
    // Resolver conta
    let account = null;
    if (amazonAccountId) {
      account = await base44.asServiceRole.entities.AmazonAccount.get(amazonAccountId).catch(() => null);
    }
    if (!account) {
      const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-last_sync_at', 1);
      account = accounts[0] || (await base44.asServiceRole.entities.AmazonAccount.list('-created_date', 1))[0] || null;
    }
    if (!account) return Response.json({ error: 'Nenhuma conta Amazon encontrada' }, { status: 404 });
    
    amazonAccountId = account.id;
    const refreshToken = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN');
    const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID');
    const adsBase = getAdsBase(account.region);
    
    if (!refreshToken) return Response.json({ error: 'Refresh token não configurado' }, { status: 400 });
    if (!profileId) return Response.json({ error: 'Profile ID não configurado' }, { status: 400 });

    // ══════════════════════════════════════════════════════════════════
    // FASE 1: request — solicita relatórios
    // ══════════════════════════════════════════════════════════════════
    if (action === 'request') {
      const token = await getAdsToken(refreshToken);
      
      const endDate = new Date();
      endDate.setDate(endDate.getDate() - 1);
      const startDate = new Date(endDate);
      startDate.setDate(startDate.getDate() - 29);
      
      const ts = Date.now();
      const reportIds = {};
      const errors = [];

      const results = await Promise.allSettled(
        REPORT_CONFIGS.map(async (rc) => {
          const reportName = `SP_${rc.key}_${fmt(endDate)}_${ts}`;
          const result = await adsPost(
            adsBase,
            '/reporting/reports',
            token,
            profileId,
            {
              name: reportName,
              startDate: fmt(startDate),
              endDate: fmt(endDate),
              configuration: rc.config,
            }
          );
          return { key: rc.key, reportId: result.reportId, duplicate: result._duplicate || false };
        })
      );

      for (const r of results) {
        if (r.status === 'fulfilled' && r.value.reportId) {
          reportIds[r.value.key] = r.value.reportId;
          console.log(`✓ ${r.value.key}: ${r.value.reportId}${r.value.duplicate ? ' (duplicado)' : ''}`);
        } else {
          const err = r.status === 'rejected' ? r.reason.message : 'Sem reportId';
          errors.push(err);
        }
      }

      if (Object.keys(reportIds).length === 0) {
        return Response.json({ ok: false, error: 'Todos os relatórios falharam', errors }, { status: 500 });
      }

      const syncRun = await base44.asServiceRole.entities.SyncRun.create({
        amazon_account_id: amazonAccountId,
        operation: `scheduledReports:${fmt(endDate)}:${JSON.stringify(reportIds)}`,
        status: 'running',
        started_at: new Date().toISOString(),
      });

      console.log(`[scheduledAdsReportSync] ${Object.keys(reportIds).length} relatórios solicitados`);

      return Response.json({
        ok: true,
        reportIds,
        syncRunId: syncRun.id,
        period: { start: fmt(startDate), end: fmt(endDate) },
        errors,
        message: `${Object.keys(reportIds).length} relatórios solicitados. Execute action="download" em 5-15 minutos.`,
      });
    }

    // ══════════════════════════════════════════════════════════════════
    // FASE 2: download — LIMPA, baixa, processa e armazena TUDO
    // ══════════════════════════════════════════════════════════════════
    if (action === 'download') {
      const { reportIds, syncRunId } = body;
      if (!reportIds || Object.keys(reportIds).length === 0) {
        return Response.json({ error: 'reportIds required' }, { status: 400 });
      }

      const token = await getAdsToken(refreshToken);

      // Verificar status
      const statusChecks = await Promise.all(
        Object.entries(reportIds).map(async ([key, reportId]) => {
          const status = await adsGet(adsBase, `/reporting/reports/${reportId}`, token, profileId);
          return { key, status: status.status, url: status.url, failureReason: status.failureReason, reportId };
        })
      );

      const pending = {};
      const failed = {};
      const ready = {};

      for (const s of statusChecks) {
        if (s.status === 'COMPLETED' && s.url) ready[s.key] = s.url;
        else if (['FAILED', 'EXPIRED'].includes(s.status)) failed[s.key] = s.failureReason || s.status;
        else pending[s.key] = s.status;
      }

      if (Object.keys(pending).length > 0 && Object.keys(ready).length === 0) {
        return Response.json({ ok: true, ready: false, pending, failed });
      }

      if (Object.keys(ready).length === 0) {
        await base44.asServiceRole.entities.SyncRun.update(syncRunId, {
          status: 'error',
          error_message: `Todos falharam: ${JSON.stringify(failed)}`,
          completed_at: new Date().toISOString(),
        });
        return Response.json({ ok: false, error: 'Todos os relatórios falharam', failed }, { status: 500 });
      }

      // Extrair período do syncRun
      const syncRun = await base44.asServiceRole.entities.SyncRun.get(syncRunId);
      const match = syncRun?.operation?.match(/scheduledReports:([^:]+):/);
      const endDate = match ? match[1] : fmt(new Date());
      const startDate = fmt(new Date(new Date(endDate).getTime() - 29 * 86400000));

      // ── LIMPAR DADOS ANTIGOS ANTES DE IMPORTAR ──
      await clearLast30Days(base44, amazonAccountId, startDate, endDate);

      // Baixar dados
      const data = {};
      for (const [key, url] of Object.entries(ready)) {
        try {
          const res = await fetch(url);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const buf = await res.arrayBuffer();
          data[key] = await decompress(buf);
          console.log(`✓ ${key}: ${data[key].length} linhas`);
        } catch (e) {
          console.error(`✗ ${key} download: ${e.message}`);
        }
      }

      const now = new Date().toISOString();
      let totalRecords = 0;

      // ── SALVAR RAW DATA (AdsReportRaw) — PARA IA/AUDITORIA ──
      const rawRecords = [];
      for (const [key, rows] of Object.entries(data)) {
        for (const row of rows) {
          const reportDate = row.date || endDate;
          rawRecords.push({
            amazon_account_id: amazonAccountId,
            report_type: key,
            report_id: reportIds[key],
            report_date: reportDate,
            period_start: startDate,
            period_end: endDate,
            raw_data: row,
            processed: false,
            synced_at: now,
          });
        }
      }
      
      // Bulk insert raw data em lotes de 500
      for (let i = 0; i < rawRecords.length; i += 500) {
        await base44.asServiceRole.entities.AdsReportRaw.bulkCreate(rawRecords.slice(i, i + 500));
      }
      console.log(`✓ AdsReportRaw: ${rawRecords.length} registos`);
      totalRecords += rawRecords.length;

      // ── SALVAR HISTÓRICO COMPLETO (AdsMetricsHistory) ──
      const historyRecords = [];
      const seen = new Set();

      // Processar Search Terms
      if (data.searchTerms?.length > 0) {
        for (const row of data.searchTerms) {
          const date = row.date || endDate;
          const campaignId = String(row.campaignId || '');
          const adGroupId = String(row.adGroupId || '');
          const keywordId = String(row.keywordId || `st_${row.searchTerm || 'unknown'}`);
          const searchTerm = row.searchTerm || '';
          
          const uniqueKey = `${date}|${campaignId}|${adGroupId}|${searchTerm}|${keywordId}`;
          if (seen.has(uniqueKey)) continue;
          seen.add(uniqueKey);

          const spend = Number(row.cost) || 0;
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
            match_type: (row.matchType || 'broad').toLowerCase(),
            advertised_asin: '',
            advertised_sku: '',
            report_type: 'searchTerms',
            impressions: Number(row.impressions) || 0,
            clicks: Number(row.clicks) || 0,
            spend,
            orders_1d: Number(row.purchases1d) || 0,
            orders_7d: Number(row.purchases7d) || 0,
            orders_14d: Number(row.purchases14d) || 0,
            orders_30d: Number(row.purchases30d) || 0,
            sales_1d: Number(row.sales1d) || 0,
            sales_7d: Number(row.sales7d) || 0,
            sales_14d: Number(row.sales14d) || 0,
            sales_30d: Number(row.sales30d) || 0,
            acos_14d: Number(row.acosClicks14d) || 0,
            roas_14d: Number(row.roasClicks14d) || 0,
            unique_key: uniqueKey,
            synced_at: now,
          });
        }
      }

      // Processar Campaigns
      if (data.campaigns?.length > 0) {
        for (const row of data.campaigns) {
          const date = row.date || endDate;
          const campaignId = String(row.campaignId);
          const uniqueKey = `${date}|${campaignId}||||`;
          if (seen.has(uniqueKey)) continue;
          seen.add(uniqueKey);

          const spend = Number(row.cost) || 0;
          historyRecords.push({
            amazon_account_id: amazonAccountId,
            date,
            campaign_id: campaignId,
            campaign_name: row.campaignName || '',
            ad_group_id: '',
            ad_group_name: '',
            keyword_id: '',
            keyword_text: '',
            search_term: '',
            match_type: '',
            advertised_asin: '',
            advertised_sku: '',
            report_type: 'campaigns',
            impressions: Number(row.impressions) || 0,
            clicks: Number(row.clicks) || 0,
            spend,
            orders_1d: Number(row.purchases1d) || 0,
            orders_7d: Number(row.purchases7d) || 0,
            orders_14d: Number(row.purchases14d) || 0,
            orders_30d: Number(row.purchases30d) || 0,
            sales_1d: Number(row.sales1d) || 0,
            sales_7d: Number(row.sales7d) || 0,
            sales_14d: Number(row.sales14d) || 0,
            sales_30d: Number(row.sales30d) || 0,
            acos_14d: Number(row.acosClicks14d) || 0,
            roas_14d: Number(row.roasClicks14d) || 0,
            unique_key: uniqueKey,
            synced_at: now,
          });
        }
      }

      // Processar Products
      if (data.products?.length > 0) {
        for (const row of data.products) {
          const date = row.date || endDate;
          const campaignId = String(row.campaignId || '');
          const adGroupId = String(row.adGroupId || '');
          const asin = row.advertisedAsin || '';
          const uniqueKey = `${date}|${campaignId}|${adGroupId}|||${asin}`;
          if (seen.has(uniqueKey)) continue;
          seen.add(uniqueKey);

          const spend = Number(row.cost) || 0;
          historyRecords.push({
            amazon_account_id: amazonAccountId,
            date,
            campaign_id: campaignId,
            campaign_name: row.campaignName || '',
            ad_group_id: adGroupId,
            ad_group_name: row.adGroupName || '',
            keyword_id: '',
            keyword_text: '',
            search_term: '',
            match_type: '',
            advertised_asin: asin,
            advertised_sku: row.advertisedSku || '',
            report_type: 'products',
            impressions: Number(row.impressions) || 0,
            clicks: Number(row.clicks) || 0,
            spend,
            orders_1d: Number(row.purchases1d) || 0,
            orders_7d: Number(row.purchases7d) || 0,
            orders_14d: Number(row.purchases14d) || 0,
            orders_30d: Number(row.purchases30d) || 0,
            sales_1d: Number(row.sales1d) || 0,
            sales_7d: Number(row.sales7d) || 0,
            sales_14d: Number(row.sales14d) || 0,
            sales_30d: Number(row.sales30d) || 0,
            acos_14d: 0,
            roas_14d: 0,
            unique_key: uniqueKey,
            synced_at: now,
          });
        }
      }

      // Bulk insert history
      for (let i = 0; i < historyRecords.length; i += 500) {
        await base44.asServiceRole.entities.AdsMetricsHistory.bulkCreate(historyRecords.slice(i, i + 500));
      }
      console.log(`✓ AdsMetricsHistory: ${historyRecords.length} registos`);
      totalRecords += historyRecords.length;

      // ── ATUALIZAR ENTIDADES OPERACIONAIS ──
      
      // SearchTerm (apenas search terms)
      const searchTermRecords = historyRecords.filter(r => r.report_type === 'searchTerms').map(r => ({
        amazon_account_id: amazonAccountId,
        date: r.date,
        campaign_id: r.campaign_id,
        campaign_name: r.campaign_name,
        ad_group_id: r.ad_group_id,
        ad_group_name: r.ad_group_name,
        keyword_id: r.keyword_id,
        keyword_text: r.keyword_text,
        keyword_type: '',
        match_type: r.match_type,
        search_term: r.search_term,
        advertised_asin: r.advertised_asin,
        advertised_sku: r.advertised_sku,
        impressions: r.impressions,
        clicks: r.clicks,
        ctr: r.impressions > 0 ? (r.clicks / r.impressions * 100) : 0,
        cpc: r.clicks > 0 ? (r.spend / r.clicks) : 0,
        spend: r.spend,
        orders_1d: r.orders_1d,
        orders_7d: r.orders_7d,
        orders_14d: r.orders_14d,
        orders_30d: r.orders_30d,
        units_1d: 0,
        units_7d: 0,
        units_14d: 0,
        units_30d: 0,
        sales_1d: r.sales_1d,
        sales_7d: r.sales_7d,
        sales_14d: r.sales_14d,
        sales_30d: r.sales_30d,
        acos_7d: 0,
        acos_14d: r.acos_14d,
        roas_7d: 0,
        roas_14d: r.roas_14d,
        conversion_rate: r.clicks > 0 ? (r.orders_14d / r.clicks * 100) : 0,
        unique_key: r.unique_key,
        synced_at: now,
      }));

      for (let i = 0; i < searchTermRecords.length; i += 500) {
        await base44.asServiceRole.entities.SearchTerm.bulkCreate(searchTermRecords.slice(i, i + 500));
      }
      console.log(`✓ SearchTerm: ${searchTermRecords.length} registos`);

      // CampaignMetricsDaily (agregar por campaign_id + date)
      const campaignMetricsMap = new Map();
      for (const r of historyRecords) {
        const key = `${r.campaign_id}|${r.date}`;
        if (!campaignMetricsMap.has(key)) {
          campaignMetricsMap.set(key, {
            amazon_account_id: amazonAccountId,
            campaign_id: r.campaign_id,
            date: r.date,
            spend: 0,
            sales: 0,
            clicks: 0,
            impressions: 0,
            orders: 0,
          });
        }
        const m = campaignMetricsMap.get(key);
        m.spend += r.spend;
        m.sales += r.sales_14d;
        m.clicks += r.clicks;
        m.impressions += r.impressions;
        m.orders += r.orders_14d;
      }

      const metricsRecords = Array.from(campaignMetricsMap.values()).map(m => ({
        ...m,
        acos: m.sales > 0 ? (m.spend / m.sales * 100) : 0,
        roas: m.spend > 0 ? (m.sales / m.spend) : 0,
        ctr: m.impressions > 0 ? (m.clicks / m.impressions * 100) : 0,
        cpc: m.clicks > 0 ? (m.spend / m.clicks) : 0,
      }));

      for (let i = 0; i < metricsRecords.length; i += 500) {
        await base44.asServiceRole.entities.CampaignMetricsDaily.bulkCreate(metricsRecords.slice(i, i + 500));
      }
      console.log(`✓ CampaignMetricsDaily: ${metricsRecords.length} registos`);

      // Atualizar Campaigns e Products (agregado 30 dias)
      const campAgg = new Map();
      const prodAgg = new Map();
      
      for (const r of historyRecords) {
        // Campanhas
        if (r.campaign_id && !campAgg.has(r.campaign_id)) {
          campAgg.set(r.campaign_id, {
            amazon_account_id: amazonAccountId,
            campaign_id: r.campaign_id,
            name: r.campaign_name,
            campaign_type: 'SP',
            state: 'enabled',
            spend: 0,
            sales: 0,
            clicks: 0,
            impressions: 0,
            orders: 0,
          });
        }
        if (r.campaign_id) {
          const c = campAgg.get(r.campaign_id);
          c.spend += r.spend;
          c.sales += r.sales_14d;
          c.clicks += r.clicks;
          c.impressions += r.impressions;
          c.orders += r.orders_14d;
        }
        
        // Produtos
        if (r.advertised_asin && !prodAgg.has(r.advertised_asin)) {
          prodAgg.set(r.advertised_asin, {
            amazon_account_id: amazonAccountId,
            asin: r.advertised_asin,
            sku: r.advertised_sku,
            total_revenue_30d: 0,
            units_sold_30d: 0,
          });
        }
        if (r.advertised_asin) {
          const p = prodAgg.get(r.advertised_asin);
          p.total_revenue_30d += r.sales_14d;
          p.units_sold_30d += r.orders_14d;
        }
      }

      // Bulk create/update campaigns
      const campRecords = Array.from(campAgg.values()).map(c => ({
        ...c,
        acos: c.sales > 0 ? (c.spend / c.sales * 100) : 0,
        roas: c.spend > 0 ? (c.sales / c.spend) : 0,
        ctr: c.impressions > 0 ? (c.clicks / c.impressions * 100) : 0,
        cpc: c.clicks > 0 ? (c.spend / c.clicks) : 0,
        synced_at: now,
      }));

      const existingCamps = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: amazonAccountId });
      const campMap = new Map(existingCamps.map(c => [c.campaign_id, c]));
      
      const toUpdate = campRecords.filter(r => campMap.has(r.campaign_id)).map(r => ({ id: campMap.get(r.campaign_id).id, ...r }));
      const toCreate = campRecords.filter(r => !campMap.has(r.campaign_id));

      for (let i = 0; i < toCreate.length; i += 500) await base44.asServiceRole.entities.Campaign.bulkCreate(toCreate.slice(i, i + 500));
      for (let i = 0; i < toUpdate.length; i += 500) await base44.asServiceRole.entities.Campaign.bulkUpdate(toUpdate.slice(i, i + 500));
      console.log(`✓ Campaign: ${campRecords.length} atualizadas`);

      // Products
      const prodRecords = Array.from(prodAgg.values()).map(p => ({
        ...p,
        status: 'active',
        synced_at: now,
      }));

      const existingProds = await base44.asServiceRole.entities.Product.filter({ amazon_account_id: amazonAccountId });
      const prodMap = new Map(existingProds.map(p => [p.asin, p]));

      const prodToUpdate = prodRecords.filter(r => prodMap.has(r.asin)).map(r => ({ id: prodMap.get(r.asin).id, ...r }));
      const prodToCreate = prodRecords.filter(r => !prodMap.has(r.asin));

      for (let i = 0; i < prodToCreate.length; i += 500) await base44.asServiceRole.entities.Product.bulkCreate(prodToCreate.slice(i, i + 500));
      for (let i = 0; i < prodToUpdate.length; i += 500) await base44.asServiceRole.entities.Product.bulkUpdate(prodToUpdate.slice(i, i + 500));
      console.log(`✓ Product: ${prodRecords.length} atualizados`);

      // Finalizar
      const durationMs = Date.now() - startTime;
      
      await base44.asServiceRole.entities.AmazonAccount.update(amazonAccountId, {
        last_sync_at: now,
        status: 'connected',
      });
      
      if (syncRunId) {
        await base44.asServiceRole.entities.SyncRun.update(syncRunId, {
          status: 'success',
          records_received: Object.values(data).reduce((sum, arr) => sum + arr.length, 0),
          records_upserted: totalRecords,
          duration_ms: durationMs,
          completed_at: now,
        });
      }

      console.log(`[scheduledAdsReportSync] ✅ CONCLUÍDO em ${(durationMs/1000).toFixed(1)}s`);
      console.log(`  - AdsReportRaw: ${rawRecords.length}`);
      console.log(`  - AdsMetricsHistory: ${historyRecords.length}`);
      console.log(`  - SearchTerm: ${searchTermRecords.length}`);
      console.log(`  - CampaignMetricsDaily: ${metricsRecords.length}`);
      console.log(`  - Campaign: ${campRecords.length}`);
      console.log(`  - Product: ${prodRecords.length}`);

      return Response.json({
        ok: true,
        ready: true,
        raw_records: rawRecords.length,
        history_records: historyRecords.length,
        search_terms: searchTermRecords.length,
        campaign_metrics: metricsRecords.length,
        campaigns: campRecords.length,
        products: prodRecords.length,
        total_records: totalRecords,
        duration_s: (durationMs / 1000).toFixed(1),
      });
    }

    return Response.json({ error: 'action deve ser "request" ou "download"' }, { status: 400 });

  } catch (error) {
    console.error('[scheduledAdsReportSync] Erro:', error.message, error.stack);
    return Response.json({ error: error.message }, { status: 500 });
  }
});