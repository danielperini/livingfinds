/**
 * autoRequestAndDownloadReports
 *
 * Fase única: SOLICITA os 3 relatórios Amazon Ads (campaigns, searchTerms, products)
 * e salva os IDs num SyncRun para a fase de download (scheduledAdsReportPoll).
 *
 * Design: uma função = uma responsabilidade, execução < 30s.
 * O download é feito pela automação agendada 40 min depois (scheduledAdsReportPoll).
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function getAdsBase(region: string) {
  const r = (region || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

function fmt(d: Date) { return d.toISOString().slice(0, 10); }

const REPORT_CONFIGS = [
  {
    key: 'campaigns',
    reportTypeId: 'spCampaigns',
    groupBy: ['campaign'],
    columns: ['date','campaignId','campaignName','campaignStatus','campaignBudgetAmount',
      'impressions','clicks','cost',
      'purchases1d','purchases7d','purchases14d','purchases30d',
      'sales1d','sales7d','sales14d','sales30d',
      'acosClicks14d','roasClicks14d'],
  },
  {
    key: 'searchTerms',
    reportTypeId: 'spSearchTerm',
    groupBy: ['searchTerm'],
    columns: ['date','campaignId','campaignName','adGroupId','adGroupName',
      'keywordId','keyword','matchType','searchTerm',
      'impressions','clicks','cost',
      'purchases7d','purchases14d','purchases30d',
      'sales7d','sales14d','sales30d',
      'acosClicks14d','roasClicks14d'],
  },
  {
    key: 'products',
    reportTypeId: 'spAdvertisedProduct',
    groupBy: ['advertiser'],
    columns: ['date','campaignId','campaignName','adGroupId','adGroupName',
      'advertisedAsin','advertisedSku',
      'impressions','clicks','cost',
      'purchases14d','purchases30d',
      'sales14d','sales30d'],
  },
];

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);

    // Resolver conta
    const accounts = await base44.asServiceRole.entities.AmazonAccount.list('-created_date', 1);
    const account = accounts[0];
    if (!account) return Response.json({ ok: false, error: 'Nenhuma conta Amazon encontrada' });

    const aid = account.id;
    const refreshToken = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN');
    const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID');
    const clientId = Deno.env.get('ADS_CLIENT_ID') || '';
    const clientSecret = Deno.env.get('ADS_CLIENT_SECRET') || '';

    if (!refreshToken || !profileId || !clientId || !clientSecret) {
      return Response.json({ ok: false, error: 'Credenciais Amazon Ads não configuradas' });
    }

    // Obter token LWA
    const tokenRes = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }).toString(),
    });
    const tokenData = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok || !tokenData.access_token) {
      return Response.json({ ok: false, error: `Token falhou: ${tokenData.error_description || tokenRes.status}` });
    }
    const token = tokenData.access_token;

    const adsBase = getAdsBase(account.region || Deno.env.get('ADS_REGION') || 'NA');
    const endDate = new Date();
    endDate.setDate(endDate.getDate() - 1); // ontem
    const startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - 29); // 30 dias

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': clientId,
      'Amazon-Advertising-API-Scope': profileId,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };

    console.log(`[autoRequestReports] Solicitando 3 relatórios (${fmt(startDate)} → ${fmt(endDate)})...`);

    const reportIds: Record<string, string> = {};
    const errors: string[] = [];

    await Promise.all(REPORT_CONFIGS.map(async (rc) => {
      try {
        const r = await fetch(`${adsBase}/reporting/reports`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            name: `SP_${rc.key}_${fmt(endDate)}_${Date.now()}`,
            startDate: fmt(startDate),
            endDate: fmt(endDate),
            configuration: {
              adProduct: 'SPONSORED_PRODUCTS',
              groupBy: rc.groupBy,
              columns: rc.columns,
              reportTypeId: rc.reportTypeId,
              timeUnit: 'DAILY',
              format: 'GZIP_JSON',
            },
          }),
        });
        const d = await r.json().catch(() => ({}));

        if (r.status === 425) {
          // Duplicata — extrair o reportId do corpo do erro
          const match = JSON.stringify(d).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
          if (match) { reportIds[rc.key] = match[0]; console.log(`[autoRequestReports] ${rc.key}: duplicado → ${match[0]}`); }
          else errors.push(`${rc.key}: 425 sem reportId`);
        } else if (r.ok && d.reportId) {
          reportIds[rc.key] = d.reportId;
          console.log(`[autoRequestReports] ${rc.key}: ${d.reportId}`);
        } else {
          errors.push(`${rc.key}: HTTP ${r.status} — ${JSON.stringify(d).slice(0, 200)}`);
        }
      } catch (e: any) {
        errors.push(`${rc.key}: ${e.message}`);
      }
    }));

    if (Object.keys(reportIds).length === 0) {
      console.error('[autoRequestReports] Todos os relatórios falharam:', errors);
      return Response.json({ ok: false, error: 'Todos os relatórios falharam', errors });
    }

    // Salvar IDs no SyncRun para a fase de download
    const syncRun = await base44.asServiceRole.entities.SyncRun.create({
      amazon_account_id: aid,
      operation: `adsReports:${fmt(endDate)}:${JSON.stringify(reportIds)}`,
      status: 'running',
      started_at: new Date().toISOString(),
    });

    console.log(`[autoRequestReports] ✅ ${Object.keys(reportIds).length} relatórios solicitados. SyncRun: ${syncRun.id}`);
    return Response.json({ ok: true, reportIds, syncRunId: syncRun.id, period: { start: fmt(startDate), end: fmt(endDate) }, errors });

  } catch (err: any) {
    console.error('[autoRequestReports] Erro:', err.message);
    return Response.json({ ok: false, error: err.message });
  }
});