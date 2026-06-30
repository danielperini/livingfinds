/**
 * scheduledAdsReportPoll — Polling para relatórios Amazon Ads
 * 
 * Esta função é chamada 15 minutos após o request para verificar e baixar relatórios.
 * Se ainda estiverem pendentes, tenta novamente (até 3 tentativas).
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

Deno.serve(async (req) => {
  const startTime = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    
    // Obter primeira conta conectada
    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-last_sync_at', 1);
    const account = accounts[0];
    if (!account) return Response.json({ error: 'Nenhuma conta Amazon conectada' }, { status: 404 });
    
    const amazonAccountId = account.id;
    const refreshToken = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN');
    const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID');
    const adsBase = getAdsBase(account.region);
    
    if (!refreshToken) return Response.json({ error: 'Refresh token não configurado' }, { status: 400 });
    if (!profileId) return Response.json({ error: 'Profile ID não configurado' }, { status: 400 });

    // Buscar último SyncRun running
    const runs = await base44.asServiceRole.entities.SyncRun.filter(
      { amazon_account_id: amazonAccountId, status: 'running', operation: { $regex: 'scheduledReports:' } },
      '-started_at',
      1
    );
    
    if (runs.length === 0) {
      return Response.json({ ok: false, error: 'Nenhum relatório pendente encontrado' });
    }
    
    const syncRun = runs[0];
    const match = syncRun.operation.match(/scheduledReports:([^:]+):(.+)/);
    if (!match) return Response.json({ ok: false, error: 'Formato de operation inválido' });
    
    const endDate = match[1];
    const reportIds = JSON.parse(match[2]);
    
    console.log(`[scheduledAdsReportPoll] Processando relatórios de ${endDate}: ${Object.keys(reportIds).length} reports`);
    
    const token = await getAdsToken(refreshToken);
    
    // Verificar status de cada relatório
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
    
    // Se ainda há pendentes, tentar novamente em 5 minutos (máx 3 tentativas)
    if (Object.keys(pending).length > 0 && Object.keys(ready).length === 0) {
      const retryCount = syncRun.retry_count || 0;
      if (retryCount < 3) {
        await base44.asServiceRole.entities.SyncRun.update(syncRun.id, {
          retry_count: retryCount + 1,
          last_polled_at: new Date().toISOString(),
        });
        return Response.json({ 
          ok: true, 
          ready: false, 
          pending, 
          retry: retryCount + 1,
          message: `Relatórios pendentes. Tentativa ${retryCount + 1}/3. Aguarde 5 min.` 
        });
      }
      return Response.json({ ok: false, error: 'Timeout após 3 tentativas', pending }, { status: 500 });
    }
    
    if (Object.keys(ready).length === 0) {
      await base44.asServiceRole.entities.SyncRun.update(syncRun.id, {
        status: 'error',
        error_message: `Todos falharam: ${JSON.stringify(failed)}`,
        completed_at: new Date().toISOString(),
      });
      return Response.json({ ok: false, error: 'Todos os relatórios falharam', failed }, { status: 500 });
    }
    
    // Baixar e processar relatórios prontos
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
      }
    }
    
    // ── Processar Search Terms ──
    let searchTermsCount = 0;
    if (data.searchTerms?.length > 0) {
      const records = [];
      const seen = new Set();
      
      for (const row of data.searchTerms) {
        const date = row.date || endDate;
        const campaignId = String(row.campaignId || '');
        const adGroupId = String(row.adGroupId || '');
        const keywordId = String(row.keywordId || `st_${row.searchTerm || 'unknown'}`);
        const searchTerm = row.searchTerm || row.keyword || '';
        const asin = row.advertisedAsin || '';
        
        const uniqueKey = `${date}|${campaignId}|${adGroupId}|${searchTerm}|${keywordId}|${asin}`;
        if (seen.has(uniqueKey)) continue;
        seen.add(uniqueKey);
        
        const spend = Number(row.cost) || 0;
        records.push({
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
          impressions: Number(row.impressions) || 0,
          clicks: Number(row.clicks) || 0,
          ctr: Number(row.ctr) || 0,
          cpc: Number(row.cpc) || 0,
          spend,
          orders_1d: Number(row.purchases1d) || 0,
          orders_7d: Number(row.purchases7d) || 0,
          orders_14d: Number(row.purchases14d) || 0,
          orders_30d: Number(row.purchases30d) || 0,
          units_1d: Number(row.unitsSoldClicks1d) || 0,
          units_7d: Number(row.unitsSoldClicks7d) || 0,
          units_14d: Number(row.unitsSoldClicks14d) || 0,
          units_30d: Number(row.unitsSoldClicks30d) || 0,
          sales_1d: Number(row.sales1d) || 0,
          sales_7d: Number(row.sales7d) || 0,
          sales_14d: Number(row.sales14d) || 0,
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
      
      // Delete + insert por date
      const dates = [...new Set(records.map(r => r.date))];
      for (const date of dates) {
        await base44.asServiceRole.entities.SearchTerm.deleteMany({ amazon_account_id: amazonAccountId, date });
      }
      for (let i = 0; i < records.length; i += 500) {
        await base44.asServiceRole.entities.SearchTerm.bulkCreate(records.slice(i, i + 500));
      }
      searchTermsCount = records.length;
    }
    
    // ── Processar Campaigns ──
    let campaignsCount = 0;
    if (data.campaigns?.length > 0) {
      const metricsRecords = [];
      for (const row of data.campaigns) {
        const campaignId = String(row.campaignId);
        const date = row.date || endDate;
        const spend = Number(row.cost) || 0;
        const sales = Number(row.sales14d) || 0;
        const clicks = Number(row.clicks) || 0;
        const impressions = Number(row.impressions) || 0;
        const orders = Number(row.purchases14d) || 0;
        
        metricsRecords.push({
          amazon_account_id: amazonAccountId,
          campaign_id: campaignId,
          date,
          spend, sales, clicks, impressions, orders,
        });
      }
      
      // Upsert métricas
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
      campaignsCount = metricsRecords.length;
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
      
      const toUpdate = productRecords.filter(r => prodMap.has(r.asin)).map(r => ({ id: prodMap.get(r.asin).id, ...r }));
      const toCreate = productRecords.filter(r => !prodMap.has(r.asin));
      
      for (let i = 0; i < toCreate.length; i += 500) await base44.asServiceRole.entities.Product.bulkCreate(toCreate.slice(i, i + 500));
      for (let i = 0; i < toUpdate.length; i += 500) await base44.asServiceRole.entities.Product.bulkUpdate(toUpdate.slice(i, i + 500));
      
      productsCount = productRecords.length;
    }
    
    // Finalizar
    const durationMs = Date.now() - startTime;
    const now = new Date().toISOString();
    
    await base44.asServiceRole.entities.AmazonAccount.update(amazonAccountId, {
      last_sync_at: now,
      status: 'connected',
    });
    
    await base44.asServiceRole.entities.SyncRun.update(syncRun.id, {
      status: 'success',
      records_received: Object.values(data).reduce((sum, arr) => sum + arr.length, 0),
      records_upserted: searchTermsCount + campaignsCount + productsCount,
      duration_ms: durationMs,
      completed_at: now,
    });
    
    console.log(`[scheduledAdsReportPoll] Concluído: ${searchTermsCount} search terms, ${campaignsCount} campaigns, ${productsCount} products`);
    
    return Response.json({
      ok: true,
      ready: true,
      search_terms: searchTermsCount,
      campaigns: campaignsCount,
      products: productsCount,
      duration_s: (durationMs / 1000).toFixed(1),
    });
    
  } catch (error) {
    console.error('[scheduledAdsReportPoll] Erro:', error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
});