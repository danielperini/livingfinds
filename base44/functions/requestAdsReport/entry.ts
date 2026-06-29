/**
 * requestAdsReport — Solicita 3 relatórios completos de 30 dias:
 *   1. spCampaigns — todas as colunas de campanha
 *   2. spAdvertisedProduct — todas as colunas de produto anunciado
 *   3. spSearchTerm — todas as colunas de keyword/search term
 * Guarda os reportIds em SyncRun para polling posterior.
 * Payload: { amazon_account_id }
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
  const r = (Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
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
    if (res.status === 425) {
      // duplicado — extrair reportId da mensagem de erro
      const match = (data?.detail || JSON.stringify(data)).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
      if (match) return { reportId: match[0], status: 'PENDING', _duplicate: true };
    }
    throw new Error(`ADS ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data;
}

const REPORT_CONFIGS = [
  {
    key: 'campaigns',
    name: 'SP Campaigns Full',
    config: {
      adProduct: 'SPONSORED_PRODUCTS',
      groupBy: ['campaign'],
      columns: [
        'campaignId', 'campaignName', 'campaignStatus', 'campaignBudgetAmount',
        'campaignBudgetType', 'campaignRuleBasedBudgetAmount', 'impressions', 'clicks',
        'cost', 'purchases1d', 'purchases7d', 'purchases14d', 'purchases30d',
        'purchasesSameSku1d', 'purchasesSameSku7d', 'purchasesSameSku14d', 'purchasesSameSku30d',
        'unitsSoldClicks1d', 'unitsSoldClicks7d', 'unitsSoldClicks14d', 'unitsSoldClicks30d',
        'sales1d', 'sales7d', 'sales14d', 'sales30d',
        'attributedSalesSameSku1d', 'attributedSalesSameSku7d', 'attributedSalesSameSku14d', 'attributedSalesSameSku30d',
        'unitsSoldSameSku1d', 'unitsSoldSameSku7d', 'unitsSoldSameSku14d', 'unitsSoldSameSku30d',
        'kindleEditionNormalizedPagesRead14d', 'kindleEditionNormalizedPagesRoyalties14d',
        'acosClicks14d', 'roasClicks14d',
      ],
      reportTypeId: 'spCampaigns',
      timeUnit: 'SUMMARY',
      format: 'GZIP_JSON',
    },
  },
  {
    key: 'products',
    name: 'SP Advertised Products Full',
    config: {
      adProduct: 'SPONSORED_PRODUCTS',
      groupBy: ['advertiser'],
      columns: [
        'campaignId', 'campaignName', 'adGroupId', 'adGroupName',
        'adId', 'advertisedAsin', 'advertisedSku',
        'impressions', 'clicks', 'cost',
        'purchases1d', 'purchases7d', 'purchases14d', 'purchases30d',
        'purchasesSameSku1d', 'purchasesSameSku7d', 'purchasesSameSku14d', 'purchasesSameSku30d',
        'unitsSoldClicks1d', 'unitsSoldClicks7d', 'unitsSoldClicks14d', 'unitsSoldClicks30d',
        'sales1d', 'sales7d', 'sales14d', 'sales30d',
        'attributedSalesSameSku1d', 'attributedSalesSameSku7d', 'attributedSalesSameSku14d', 'attributedSalesSameSku30d',
        'unitsSoldSameSku1d', 'unitsSoldSameSku7d', 'unitsSoldSameSku14d', 'unitsSoldSameSku30d',
      ],
      reportTypeId: 'spAdvertisedProduct',
      timeUnit: 'SUMMARY',
      format: 'GZIP_JSON',
    },
  },
  {
    key: 'keywords',
    name: 'SP Search Terms Full',
    config: {
      adProduct: 'SPONSORED_PRODUCTS',
      groupBy: ['searchTerm'],
      columns: [
        'campaignId', 'campaignName', 'adGroupId', 'adGroupName',
        'keywordId', 'keyword', 'keywordType', 'matchType', 'searchTerm',
        'impressions', 'clicks', 'cost',
        'purchases1d', 'purchases7d', 'purchases14d', 'purchases30d',
        'unitsSoldClicks1d', 'unitsSoldClicks7d', 'unitsSoldClicks14d', 'unitsSoldClicks30d',
        'sales1d', 'sales7d', 'sales14d', 'sales30d',
        'acosClicks7d', 'acosClicks14d', 'roasClicks7d', 'roasClicks14d',
      ],
      reportTypeId: 'spSearchTerm',
      timeUnit: 'SUMMARY',
      format: 'GZIP_JSON',
    },
  },
];

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const amazonAccountId = body.amazon_account_id;
    if (!amazonAccountId) return Response.json({ error: 'amazon_account_id required' }, { status: 400 });

    const endDate = new Date();
    endDate.setDate(endDate.getDate() - 1); // ontem como end date para evitar duplicates
    const startDate = new Date(endDate - 29 * 86400000);
    const fmt = d => d.toISOString().slice(0, 10);
    const dateStr = fmt(endDate);

    const reportIds = {};
    const errors = [];

    for (const rc of REPORT_CONFIGS) {
      try {
        const result = await adsPost('/reporting/reports', {
          name: `${rc.name} ${dateStr}`,
          startDate: fmt(startDate),
          endDate: dateStr,
          configuration: rc.config,
        });
        const reportId = result.reportId;
        if (!reportId) throw new Error('No reportId returned');
        reportIds[rc.key] = reportId;
      } catch (e) {
        errors.push(`${rc.key}: ${e.message}`);
      }
    }

    if (Object.keys(reportIds).length === 0) {
      return Response.json({ ok: false, error: 'Todos os relatórios falharam', errors }, { status: 500 });
    }

    // Cancelar SyncRuns running anteriores para este account para não poluir o histórico
    await base44.asServiceRole.entities.SyncRun.updateMany(
      { amazon_account_id: amazonAccountId, status: 'running' },
      { $set: { status: 'error', error_message: 'Cancelado por novo ciclo', completed_at: new Date().toISOString() } }
    );

    // Persistir reportIds no SyncRun para o downloader encontrar
    const syncRun = await base44.asServiceRole.entities.SyncRun.create({
      amazon_account_id: amazonAccountId,
      operation: `adsReports:${dateStr}:${JSON.stringify(reportIds)}`,
      status: 'running',
      started_at: new Date().toISOString(),
    });

    return Response.json({
      ok: true,
      reportIds,
      syncRunId: syncRun.id,
      date: dateStr,
      errors,
      message: `${Object.keys(reportIds).length} relatórios solicitados. Execute downloadAdsReport em 5-15 minutos.`,
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});