/**
 * fetchSearchTermsFromApi — Busca search terms das campanhas automáticas via Amazon Ads API.
 * Solicita relatório de Search Term Report (SP), aguarda processamento e salva na entidade SearchTerm.
 * Executa 1x por dia automaticamente; pode ser chamada manualmente também.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const TOKEN_CACHE = {};

async function getAdsToken() {
  const c = TOKEN_CACHE['ads'];
  if (c && c.expires_at > Date.now()) return c.access_token;
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
  if (!res.ok) throw new Error(data.error_description || 'Ads token refresh failed');
  TOKEN_CACHE['ads'] = { access_token: data.access_token, expires_at: Date.now() + (data.expires_in - 60) * 1000 };
  return data.access_token;
}

function adsBaseUrl() {
  const r = (Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function adsCall(method, path, body, ct = 'application/json') {
  const token = await getAdsToken();
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID'),
      'Amazon-Advertising-API-Scope': String(Deno.env.get('ADS_PROFILE_ID')),
      'Content-Type': ct,
      'Accept': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${adsBaseUrl()}${path}`, opts);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`ADS ${res.status} ${path}: ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

// Solicita relatório de Search Terms (SP) para os últimos N dias
async function requestSearchTermReport(startDate, endDate) {
  const body = {
    name: `search-terms-${startDate}-${endDate}`,
    startDate,
    endDate,
    configuration: {
      adProduct: 'SPONSORED_PRODUCTS',
      groupBy: ['searchTerm'],
      columns: [
        'campaignId', 'campaignName', 'adGroupId', 'adGroupName',
        'keywordId', 'keywordText', 'matchType', 'searchTerm',
        'advertisedAsin', 'advertisedSku',
        'impressions', 'clicks', 'cost', 'purchases1d', 'purchases7d', 'purchases14d', 'purchases30d',
        'sales1d', 'sales7d', 'sales14d', 'sales30d',
        'unitsSoldClicks1d', 'unitsSoldClicks7d', 'unitsSoldClicks14d', 'unitsSoldClicks30d',
      ],
      reportTypeId: 'spSearchTerm',
      timeUnit: 'SUMMARY',
      format: 'GZIP_JSON',
    },
  };
  const data = await adsCall('POST', '/reporting/reports', body);
  return data.reportId;
}

// Verifica status do relatório e retorna URL de download quando pronto
async function pollReport(reportId, maxWaitMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const data = await adsCall('GET', `/reporting/reports/${reportId}`);
    if (data.status === 'COMPLETED') return data.url;
    if (data.status === 'FAILED') throw new Error(`Relatório falhou: ${data.failureReason || 'unknown'}`);
    await new Promise(r => setTimeout(r, 5000));
  }
  throw new Error(`Timeout aguardando relatório ${reportId}`);
}

// Faz download do relatório (gzip JSON)
async function downloadReport(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download falhou: ${res.status}`);
  // Amazon retorna gzip; usar DecompressionStream
  const ds = new DecompressionStream('gzip');
  const stream = res.body.pipeThrough(ds);
  const reader = stream.getReader();
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const text = new TextDecoder().decode(
    chunks.reduce((a, b) => { const c = new Uint8Array(a.length + b.length); c.set(a); c.set(b, a.length); return c; }, new Uint8Array(0))
  );
  return JSON.parse(text);
}

Deno.serve(async (req) => {
  const startTime = Date.now();
  const base44 = createClientFromRequest(req);
  const now = new Date().toISOString();
  const today = now.slice(0, 10);

  try {
    const body = await req.json().catch(() => ({}));
    let amazonAccountId = body.amazon_account_id;

    // Resolver conta
    let account = null;
    if (amazonAccountId) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: amazonAccountId });
      account = accs[0] || null;
    } else {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      account = accs[0] || null;
      if (account) amazonAccountId = account.id;
    }
    if (!account) return Response.json({ ok: false, message: 'Nenhuma conta conectada' });

    const aid = account.id;
    const days = body.days || 30;

    // Período do relatório: últimos N dias excluindo hoje (Amazon requer dados do passado)
    const endDate = new Date(Date.now() - 86400000).toISOString().slice(0, 10); // ontem
    const startDate = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

    console.log(`Solicitando relatório de search terms: ${startDate} → ${endDate}`);

    // Verificar se já houve busca hoje (anti-duplicata)
    if (!body.force) {
      const recentLogs = await base44.asServiceRole.entities.SyncExecutionLog.filter({
        amazon_account_id: aid,
        operation: 'quick_sync',
        execution_date: today,
        status: 'success',
      });
      // Verificar se há um log com "fetchSearchTerms" na operação
      const existingSearchTermFetch = recentLogs.find(l => l.error_message?.includes('fetchSearchTerms'));
      if (existingSearchTermFetch) {
        return Response.json({ ok: true, skipped: true, message: 'Busca de search terms já realizada hoje. Use force=true para forçar.' });
      }
    }

    // 1. Solicitar relatório
    let reportId;
    try {
      reportId = await requestSearchTermReport(startDate, endDate);
    } catch (e) {
      // Fallback: buscar dados já existentes na API de search terms (v3)
      console.log('Relatório assíncrono falhou, tentando API direta:', e.message);
      return Response.json({ ok: false, error: `Falha ao solicitar relatório: ${e.message}`, hint: 'A Amazon Ads API requer permissão de relatórios. Verifique o perfil de anúncios.' });
    }

    // 2. Aguardar processamento (máx 90s para chamada síncrona)
    let reportUrl;
    try {
      reportUrl = await pollReport(reportId, 90000);
    } catch (e) {
      // Salvar reportId para polling assíncrono posterior
      await base44.asServiceRole.entities.SyncExecutionLog.create({
        amazon_account_id: aid,
        operation: 'quick_sync',
        trigger_type: 'manual',
        status: 'started',
        execution_date: today,
        started_at: now,
        error_message: `fetchSearchTerms:pending:${reportId}`,
      });
      return Response.json({ ok: false, pending: true, report_id: reportId, message: 'Relatório ainda processando. Tente novamente em alguns minutos.' });
    }

    // 3. Fazer download
    let rows;
    try {
      rows = await downloadReport(reportUrl);
    } catch (e) {
      return Response.json({ ok: false, error: `Falha no download: ${e.message}` });
    }

    if (!Array.isArray(rows) || rows.length === 0) {
      return Response.json({ ok: true, imported: 0, message: 'Nenhum dado retornado pela Amazon para o período.' });
    }

    console.log(`Relatório com ${rows.length} linhas recebido`);

    // 4. Processar e salvar em SearchTerm (deduplicado por unique_key)
    const existingTerms = await base44.asServiceRole.entities.SearchTerm.filter(
      { amazon_account_id: aid }, '-created_date', 5000
    );
    const existingKeys = new Map(existingTerms.filter(t => t.unique_key).map(t => [t.unique_key, t.id]));

    let imported = 0, updated = 0, skipped = 0;
    const toCreate = [];

    for (const row of rows) {
      const term = (row.searchTerm || row.search_term || '').trim();
      const campaignId = String(row.campaignId || row.campaign_id || '');
      const adGroupId = String(row.adGroupId || row.ad_group_id || '');
      const keywordId = String(row.keywordId || row.keyword_id || '');
      const asin = row.advertisedAsin || row.advertised_asin || '';
      if (!term || !campaignId) { skipped++; continue; }

      const clicks = Number(row.clicks || 0);
      const impressions = Number(row.impressions || 0);
      const spend = Number(row.cost || row.spend || 0);
      const orders14 = Number(row.purchases14d || 0);
      const sales14 = Number(row.sales14d || 0);
      const orders7 = Number(row.purchases7d || 0);
      const sales7 = Number(row.sales7d || 0);
      const orders30 = Number(row.purchases30d || 0);
      const sales30 = Number(row.sales30d || 0);
      const acos14 = spend > 0 && sales14 > 0 ? (spend / sales14) * 100 : 0;
      const cpc = clicks > 0 ? spend / clicks : 0;
      const ctr = impressions > 0 ? (clicks / impressions) * 100 : 0;

      // unique_key: campanha + adgroup + keyword + termo (engloba período)
      const uniqueKey = `${aid}|${campaignId}|${adGroupId}|${keywordId}|${term}`;

      const record = {
        amazon_account_id: aid,
        date: endDate,
        campaign_id: campaignId,
        campaign_name: row.campaignName || row.campaign_name || '',
        ad_group_id: adGroupId,
        ad_group_name: row.adGroupName || row.ad_group_name || '',
        keyword_id: keywordId,
        keyword_text: row.keywordText || row.keyword_text || '',
        match_type: (row.matchType || row.match_type || 'auto').toLowerCase(),
        search_term: term,
        advertised_asin: asin,
        advertised_sku: row.advertisedSku || row.advertised_sku || '',
        impressions,
        clicks,
        ctr: Number(ctr.toFixed(4)),
        cpc: Number(cpc.toFixed(4)),
        spend: Number(spend.toFixed(4)),
        orders_7d: orders7,
        orders_14d: orders14,
        orders_30d: orders30,
        sales_7d: Number(sales7.toFixed(4)),
        sales_14d: Number(sales14.toFixed(4)),
        sales_30d: Number(sales30.toFixed(4)),
        acos_14d: Number(acos14.toFixed(2)),
        roas_14d: sales14 > 0 && spend > 0 ? Number((sales14 / spend).toFixed(2)) : 0,
        unique_key: uniqueKey,
        synced_at: now,
        source_campaign_type: 'AUTO',
      };

      if (existingKeys.has(uniqueKey)) {
        // Atualizar registro existente
        await base44.asServiceRole.entities.SearchTerm.update(existingKeys.get(uniqueKey), record);
        updated++;
      } else {
        toCreate.push(record);
      }
    }

    // Bulk create em lotes de 50
    for (let i = 0; i < toCreate.length; i += 50) {
      await base44.asServiceRole.entities.SearchTerm.bulkCreate(toCreate.slice(i, i + 50));
      imported += toCreate.slice(i, i + 50).length;
    }

    // Registrar execução
    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: aid,
      operation: 'quick_sync',
      trigger_type: body.manual ? 'manual' : 'automatic',
      status: 'success',
      execution_date: today,
      started_at: now,
      completed_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      records_processed: rows.length,
      error_message: `fetchSearchTerms:done`,
    });

    return Response.json({
      ok: true,
      total_rows: rows.length,
      imported,
      updated,
      skipped,
      period: `${startDate} → ${endDate}`,
      duration_ms: Date.now() - startTime,
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});