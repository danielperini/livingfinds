/**
 * scheduledAdsReportSync — Pipeline completo para relatórios Amazon Ads
 * 
 * action="request": Solicita relatórios de 30 dias
 * action="download": Verifica, baixa, processa e armazena dados
 * 
 * Relatórios solicitados:
 * - spSearchTerm (termos de pesquisa) — principal
 * - spCampaigns (campanhas)
 * - spAdvertisedProduct (produtos)
 * 
 * Chave única: date|campaign_id|ad_group_id|search_term|keyword_id|asin
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

// ── Cache de Token ──
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
  if (!res.ok) {
    throw new Error(`Token refresh failed: ${data.error_description || data.error || res.status}`);
  }
  
  _tokenCache = {
    access_token: data.access_token,
    expires_at: Date.now() + (data.expires_in - 60) * 1000,
  };
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
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 500) }; }
  if (!res.ok) throw new Error(`ADS GET ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

async function adsPost(base, path, token, profileId, body, contentType = 'application/json') {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID') || '',
      'Amazon-Advertising-API-Scope': profileId,
      'Content-Type': contentType,
      Accept: contentType,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 500) }; }
  
  if (!res.ok) {
    if (res.status === 425) {
      const match = JSON.stringify(data).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      if (match) return { reportId: match[0], _duplicate: true };
    }
    throw new Error(`ADS POST ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  }
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

// ── Configurações de Relatórios ──
const REPORT_CONFIGS = [
  {
    key: 'searchTerms',
    name: 'SP_Termo_Pesquisa_BR',
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
        'acosClicks7d', 'acosClicks14d', 'roasClicks7d', 'roasClicks14d',
      ],
      reportTypeId: 'spSearchTerm',
      timeUnit: 'DAILY',
      format: 'GZIP_JSON',
    },
  },
  {
    key: 'campaigns',
    name: 'SP_Campanhas_BR',
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
        'unitsSoldSameSku1d', 'unitsSoldSameSku7d', 'unitsSoldSameSku14d', 'unitsSoldSameSku30d',
        'acosClicks14d', 'roasClicks14d',
      ],
      reportTypeId: 'spCampaigns',
      timeUnit: 'DAILY',
      format: 'GZIP_JSON',
    },
  },
  {
    key: 'products',
    name: 'SP_Produtos_BR',
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

Deno.serve(async (req) => {
  const startTime = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    
    // Para automações agendadas (sem user auth), usar service role diretamente
    let user = null;
    try {
      user = await base44.auth.me();
    } catch {}
    
    const body = await req.json().catch(() => ({}));
    const action = body.action || 'request';
    let amazonAccountId = body.amazon_account_id;

    // Resolver conta: do payload ou primeira conta conectada
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
    if (!refreshToken) return Response.json({ error: 'Refresh token não configurado' }, { status: 400 });
    
    const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID');
    if (!profileId) return Response.json({ error: 'Profile ID não configurado' }, { status: 400 });
    
    const adsBase = getAdsBase(account.region);

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
          const reportName = body.report_name_prefix 
            ? `${body.report_name_prefix}_${rc.key}_${fmt(endDate)}`
            : `${rc.name}_${fmt(endDate)}_${ts}`;
          
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
          console.error(`✗ ${r.status === 'fulfilled' ? r.value.key : 'unknown'}: ${err}`);
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
    // FASE 2: download — verifica, baixa, processa
    // ══════════════════════════════════════════════════════════════════
    if (action === 'download') {
      const { reportIds, syncRunId } = body;
      if (!reportIds || Object.keys(reportIds).length === 0) {
        return Response.json({ error: 'reportIds required' }, { status: 400 });
      }

      const token = await getAdsToken(refreshToken);

      const statusChecks = await Promise.all(
        Object.entries(reportIds).map(async ([key, reportId]) => {
          const status = await adsGet(adsBase, `/reporting/reports/${reportId}`, token, profileId);
          return { key, status: status.status, url: status.url, failureReason: status.failureReason };
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
        return Response.json({ 
          ok: true, 
          ready: false, 
          pending, 
          failed,
          message: `Aguardando ${Object.keys(pending).length} relatório(s): ${Object.keys(pending).join(', ')}` 
        });
      }

      if (Object.keys(ready).length === 0) {
        return Response.json({ ok: false, error: 'Todos os relatórios falharam', failed }, { status: 500 });
      }

      const data = {};
      const downloadErrors = [];

      for (const [key, url] of Object.entries(ready)) {
        try {
          const res = await fetch(url);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const buf = await res.arrayBuffer();
          data[key] = await decompress(buf);
          console.log(`✓ ${key}: ${data[key].length} linhas`);
        } catch (e) {
          downloadErrors.push(`${key}: ${e.message}`);
          console.error(`✗ ${key} download: ${e.message}`);
        }
      }

      // ── Processar Search Terms ──
      let searchTermsCount = 0;
      if (data.searchTerms?.length > 0) {
        const searchTermRecords = [];
        const seen = new Set();

        for (const row of data.searchTerms) {
          const date = row.date || fmt(new Date());
          const campaignId = String(row.campaignId || '');
          const adGroupId = String(row.adGroupId || '');
          const keywordId = String(row.keywordId || `st_${row.searchTerm || 'unknown'}`);
          const searchTerm = row.searchTerm || row.keyword || '';
          const asin = row.advertisedAsin || '';
          
          const uniqueKey = `${date}|${campaignId}|${adGroupId}|${searchTerm}|${keywordId}|${asin}`;
          if (seen.has(uniqueKey)) continue;
          seen.add(uniqueKey);

          const spend = Number(row.cost) || 0;
          const sales14d = Number(row.sales14d) || Number(row.sales7d) || Number(row.sales1d) || 0;
          const clicks = Number(row.clicks) || 0;
          const impressions = Number(row.impressions) || 0;
          const orders14d = Number(row.purchases14d) || Number(row.purchases7d) || 0;

          searchTermRecords.push({
            amazon_account_id: amazonAccountId,
            date,
            campaign_id: campaignId,
            campaign_name: row.campaignName || '',
            ad_group_id: adGroupId,
            ad_group_name: row.adGroupName || '',
            keyword_id: keywordId,
            keyword_text: row.keyword || '',
            keyword_type: row.keywordType || '',
            match_type: (row.matchType || 'broad').toLowerCase(),
            search_term: searchTerm,
            advertised_asin: asin,
            advertised_sku: row.advertisedSku || '',
            impressions,
            clicks,
            ctr: impressions > 0 ? (clicks / impressions * 100) : 0,
            cpc: clicks > 0 ? (spend / clicks) : 0,
            spend,
            orders_1d: Number(row.purchases1d) || 0,
            orders_7d: Number(row.purchases7d) || 0,
            orders_14d: orders14d,
            orders_30d: Number(row.purchases30d) || 0,
            units_1d: Number(row.unitsSoldClicks1d) || 0,
            units_7d: Number(row.unitsSoldClicks7d) || 0,
            units_14d: Number(row.unitsSoldClicks14d) || 0,
            units_30d: Number(row.unitsSoldClicks30d) || 0,
            sales_1d: Number(row.sales1d) || 0,
            sales_7d: Number(row.sales7d) || 0,
            sales_14d: sales14d,
            sales_30d: Number(row.sales30d) || 0,
            acos_7d: Number(row.acosClicks7d) || 0,
            acos_14d: Number(row.acosClicks14d) || 0,
            roas_7d: Number(row.roasClicks7d) || 0,
            roas_14d: Number(row.roasClicks14d) || 0,
            conversion_rate: Number(row.conversionRate) || 0,
            unique_key: uniqueKey,
            synced_at: new Date().toISOString(),
          });
        }

        const dates = [...new Set(searchTermRecords.map(r => r.date))];
        for (const date of dates) {
          await base44.asServiceRole.entities.SearchTerm.deleteMany({
            amazon_account_id: amazonAccountId,
            date,
          });
        }

        for (let i = 0; i < searchTermRecords.length; i += 500) {
          await base44.asServiceRole.entities.SearchTerm.bulkCreate(searchTermRecords.slice(i, i + 500));
        }
        searchTermsCount = searchTermRecords.length;
        console.log(`✓ SearchTerm: ${searchTermsCount} registos`);
      }

      // ── Processar Campaigns ──
      let campaignsCount = 0;
      if (data.campaigns?.length > 0) {
        const campaignRecords = [];
        const metricsRecords = [];

        for (const row of data.campaigns) {
          const campaignId = String(row.campaignId);
          const date = row.date || fmt(new Date());
          const spend = Number(row.cost) || 0;
          const sales = Number(row.sales14d) || Number(row.sales7d) || 0;
          const clicks = Number(row.clicks) || 0;
          const impressions = Number(row.impressions) || 0;
          const orders = Number(row.purchases14d) || 0;

          campaignRecords.push({
            amazon_account_id: amazonAccountId,
            campaign_id: campaignId,
            name: row.campaignName,
            campaign_type: 'SP',
            state: (row.campaignStatus || 'ENABLED').toLowerCase(),
            daily_budget: Number(row.campaignBudgetAmount) || 0,
            spend, sales, clicks, impressions, orders,
            synced_at: new Date().toISOString(),
          });

          metricsRecords.push({
            amazon_account_id: amazonAccountId,
            campaign_id: campaignId,
            date,
            spend, sales, clicks, impressions, orders,
          });
        }

        const existingCamps = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: amazonAccountId });
        const campMap = new Map(existingCamps.map(c => [c.campaign_id, c]));
        
        const toUpdate = campaignRecords.filter(r => campMap.has(r.campaign_id)).map(r => ({
          id: campMap.get(r.campaign_id).id,
          ...r,
        }));

        for (let i = 0; i < toUpdate.length; i += 500) {
          await base44.asServiceRole.entities.Campaign.bulkUpdate(toUpdate.slice(i, i + 500));
        }

        for (const m of metricsRecords) {
          const existing = await base44.asServiceRole.entities.CampaignMetricsDaily.filter({
            amazon_account_id: amazonAccountId,
            campaign_id: m.campaign_id,
            date: m.date,
          }, '-created_date', 1);
          
          if (existing.length > 0) {
            await base44.asServiceRole.entities.CampaignMetricsDaily.update(existing[0].id, m);
          } else {
            await base44.asServiceRole.entities.CampaignMetricsDaily.create(m);
          }
        }

        campaignsCount = campaignRecords.length;
        console.log(`✓ Campaigns: ${campaignsCount} atualizadas`);
      }

      // ── Processar Products ──
      let productsCount = 0;
      if (data.products?.length > 0) {
        const asinMap = {};
        for (const row of data.products) {
          const asin = row.advertisedAsin || '';
          if (!asin) continue;
          if (!asinMap[asin]) asinMap[asin] = { spend: 0, sales: 0, units: 0, sku: row.advertisedSku };
          asinMap[asin].spend += Number(row.cost) || 0;
          asinMap[asin].sales += Number(row.sales14d) || 0;
          asinMap[asin].units += Number(row.unitsSoldClicks14d) || 0;
        }

        const productRecords = Object.entries(asinMap).map(([asin, m]) => ({
          amazon_account_id: amazonAccountId,
          asin,
          sku: m.sku,
          total_revenue_30d: m.sales,
          units_sold_30d: m.units,
          synced_at: new Date().toISOString(),
        }));

        const existingProds = await base44.asServiceRole.entities.Product.filter({ amazon_account_id: amazonAccountId });
        const prodMap = new Map(existingProds.map(p => [p.asin, p]));

        const toUpdate = productRecords.filter(r => prodMap.has(r.asin)).map(r => ({
          id: prodMap.get(r.asin).id,
          ...r,
        }));
        const toCreate = productRecords.filter(r => !prodMap.has(r.asin));

        for (let i = 0; i < toCreate.length; i += 500) {
          await base44.asServiceRole.entities.Product.bulkCreate(toCreate.slice(i, i + 500));
        }
        for (let i = 0; i < toUpdate.length; i += 500) {
          await base44.asServiceRole.entities.Product.bulkUpdate(toUpdate.slice(i, i + 500));
        }

        productsCount = productRecords.length;
        console.log(`✓ Products: ${productsCount}`);
      }

      // ── Finalizar ──
      const durationMs = Date.now() - startTime;
      const now = new Date().toISOString();

      await base44.asServiceRole.entities.AmazonAccount.update(amazonAccountId, {
        last_sync_at: now,
        status: 'connected',
      });

      if (syncRunId) {
        await base44.asServiceRole.entities.SyncRun.update(syncRunId, {
          status: 'success',
          records_received: Object.values(data).reduce((sum, arr) => sum + arr.length, 0),
          records_upserted: searchTermsCount + campaignsCount + productsCount,
          duration_ms: durationMs,
          completed_at: now,
        });
      }

      console.log(`[scheduledAdsReportSync] Concluído em ${(durationMs/1000).toFixed(1)}s`);

      return Response.json({
        ok: true,
        ready: true,
        search_terms: searchTermsCount,
        campaigns: campaignsCount,
        products: productsCount,
        download_errors: downloadErrors,
        duration_s: (durationMs / 1000).toFixed(1),
      });
    }

    return Response.json({ error: 'action deve ser "request" ou "download"' }, { status: 400 });

  } catch (error) {
    console.error('[scheduledAdsReportSync] Erro:', error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
});