/**
 * requestAdsReportsFull — Solicita 11 relatórios completos de 30 dias e guarda em AdsReportRequest.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

async function getAdsToken() {
  const cached = globalThis.__adsToken;
  if (cached && cached.expires > Date.now()) return cached.token;
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: Deno.env.get('ADS_REFRESH_TOKEN'),
    client_id: Deno.env.get('ADS_CLIENT_ID'),
    client_secret: Deno.env.get('ADS_CLIENT_SECRET'),
  });
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString(),
  });
  const d = await res.json();
  if (!res.ok) throw new Error(d.error_description || 'Token failed');
  globalThis.__adsToken = { token: d.access_token, expires: Date.now() + (d.expires_in - 120) * 1000 };
  return d.access_token;
}

async function requestOne(baseUrl, config) {
  const token = await getAdsToken();
  const res = await fetch(`${baseUrl}/reporting/reports`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID'),
      'Amazon-Advertising-API-Scope': String(Deno.env.get('ADS_PROFILE_ID')),
      'Content-Type': 'application/json', 'Accept': 'application/json',
    },
    body: JSON.stringify(config),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok && res.status !== 425) throw new Error(`${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
  if (data.reportId) return data.reportId;
  if (res.status === 425) {
    const m = (data.detail || text).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    if (m) return m[1];
  }
  throw new Error(`No reportId from request ${config.key}`);
  return null;
}

const end30d = new Date(Date.now() - 86400000);
const start30d = new Date(end30d.getTime() - 29 * 86400000);
const fmt = d => d.toISOString().slice(0, 10);
const dateStr = fmt(end30d);

const REPORT_DEFINITIONS = [
  { key: 'spCampaigns', name: 'SP Campaigns', config: { adProduct: 'SPONSORED_PRODUCTS', groupBy: ['campaign'], columns: ['campaignId','campaignName','campaignStatus','campaignBudgetAmount','campaignBudgetType','impressions','clicks','cost','purchases1d','purchases30d','unitsSoldClicks1d','unitsSoldClicks30d','sales1d','sales30d','acosClicks14d','roasClicks14d'], reportTypeId: 'spCampaigns', timeUnit: 'SUMMARY', format: 'GZIP_JSON' } },
  { key: 'spAdGroups', name: 'SP Ad Groups', config: { adProduct: 'SPONSORED_PRODUCTS', groupBy: ['adGroup'], columns: ['campaignId','campaignName','adGroupId','adGroupName','impressions','clicks','cost','purchases1d','purchases7d','unitsSoldClicks1d','unitsSoldClicks7d','sales1d','sales7d','acosClicks14d','roasClicks14d'], reportTypeId: 'spAdGroups', timeUnit: 'SUMMARY', format: 'GZIP_JSON' } },
  { key: 'spProductAds', name: 'SP Product Ads', config: { adProduct: 'SPONSORED_PRODUCTS', groupBy: ['advertiser'], columns: ['campaignId','campaignName','adGroupId','adGroupName','adId','advertisedAsin','advertisedSku','impressions','clicks','cost','purchases1d','purchases7d','sales1d','sales7d','acosClicks14d','roasClicks14d'], reportTypeId: 'spProductAds', timeUnit: 'SUMMARY', format: 'GZIP_JSON' } },
  { key: 'spKeywords', name: 'SP Keywords', config: { adProduct: 'SPONSORED_PRODUCTS', groupBy: ['keyword'], columns: ['campaignId','campaignName','adGroupId','adGroupName','keywordId','keyword','keywordType','matchType','impressions','clicks','cost','purchases1d','purchases7d','sales1d','sales7d','acosClicks14d','roasClicks14d'], reportTypeId: 'spKeywords', timeUnit: 'SUMMARY', format: 'GZIP_JSON' } },
  { key: 'spSearchTerms', name: 'SP Search Terms', config: { adProduct: 'SPONSORED_PRODUCTS', groupBy: ['searchTerm'], columns: ['campaignId','campaignName','adGroupId','adGroupName','keywordId','keyword','matchType','searchTerm','impressions','clicks','cost','purchases1d','purchases30d','sales1d','sales30d','acosClicks14d','roasClicks14d'], reportTypeId: 'spSearchTerm', timeUnit: 'SUMMARY', format: 'GZIP_JSON' } },
  { key: 'spTargeting', name: 'SP Targeting', config: { adProduct: 'SPONSORED_PRODUCTS', groupBy: ['targeting'], columns: ['campaignId','campaignName','adGroupId','targetId','targetingExpression','targetingType','impressions','clicks','cost','purchases1d','sales1d','acosClicks14d','roasClicks14d'], reportTypeId: 'spTargeting', timeUnit: 'SUMMARY', format: 'GZIP_JSON' } },
  { key: 'spNegativeKeywords', name: 'SP Negative Keywords', config: { adProduct: 'SPONSORED_PRODUCTS', groupBy: ['negativeKeyword'], columns: ['campaignId','adGroupId','keywordId','keywordText','matchType','cost'], reportTypeId: 'spNegativeKeywords', timeUnit: 'SUMMARY', format: 'GZIP_JSON' } },
  { key: 'advertisedProduct', name: 'Advertised Products', config: { adProduct: 'SPONSORED_PRODUCTS', groupBy: ['advertiser'], columns: ['campaignId','campaignName','adGroupId','advertisedAsin','advertisedSku','impressions','clicks','cost','purchases1d','purchases7d','sales1d','sales7d','unitsSoldClicks1d','unitsSoldClicks7d','acosClicks14d','roasClicks14d'], reportTypeId: 'spAdvertisedProduct', timeUnit: 'SUMMARY', format: 'GZIP_JSON' } },
];

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    const { amazon_account_id } = await req.json().catch(() => ({}));
    if (!amazon_account_id) return Response.json({ error: 'amazon_account_id required' }, { status: 400 });

    const baseUrl = ((Deno.env.get('ADS_REGION') || 'NA')).includes('EU') ? 'https://advertising-api-eu.amazon.com'
      : Deno.env.get('ADS_REGION').includes('FE') ? 'https://advertising-api-fe.amazon.com'
      : 'https://advertising-api.amazon.com';
    const requestedAt = new Date().toISOString();
    const results = [];
    for (const r of REPORT_DEFINITIONS) {
      try {
        const reportId = await requestOne(baseUrl, { ...r.config, startDate: fmt(start30d), endDate: dateStr });
        await base44.asServiceRole.entities.AdsReportRequest.create({
          amazon_account_id,
          report_id: reportId,
          report_type: r.key,
          requested_at: requestedAt,
          date_start: fmt(start30d),
          date_end: dateStr,
          status: 'requested',
        });
        results.push({ report_type: r.key, ok: true, report_id: reportId });
      } catch (e) {
        results.push({ report_type: r.key, ok: false, error: e.message });
      }
    }
    return Response.json({ ok: true, results, batch_date: dateStr });
  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});