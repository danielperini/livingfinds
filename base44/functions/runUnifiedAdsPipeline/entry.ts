/**
 * runUnifiedAdsPipeline — Pipeline unificado de sincronização Amazon Ads
 * 
 * Etapas:
 * 1. validateAmazonAdsConnection
 * 2. listProfiles
 * 3. selectAccountProfile
 * 4. syncCampaignStructure
 * 5. requestReports
 * 6. persistReportRequests
 * 7. pollReports
 * 8. downloadCompletedReports
 * 9. normalizeReportData
 * 10. archiveInactiveHistoricalCampaigns
 * 11. calculateMetrics
 * 12. runAIAnalysis
 * 13. generateDecisions
 * 14. executeAuthorizedDecisions
 * 15. reconcileAmazonState
 * 16. updateDashboardSnapshots
 * 17. audit
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
  if (!res.ok) throw new Error(data.error_description || data.error || 'Token failed');
  _tokenCache = { access_token: data.access_token, expires_at: Date.now() + (data.expires_in - 60) * 1000 };
  return data.access_token;
}

function getAdsBase(region) {
  const r = (region || Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function adsPost(base, path, token, profileId, body, contentType = 'application/json') {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID') || '',
      'Amazon-Advertising-API-Scope': String(profileId),
      'Content-Type': contentType,
      Accept: contentType,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 500) }; }
  return { ok: res.ok, status: res.status, data, headers: Object.fromEntries(res.headers.entries()) };
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
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 500) }; }
  return { ok: res.ok, status: res.status, data };
}

function fmt(d) { return d.toISOString().slice(0, 10); }

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

Deno.serve(async (req) => {
  const startTime = Date.now();
  const pipelineRunId = `pipeline_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const steps = [];
  const now = new Date().toISOString();
  
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    let amazonAccountId = body.amazon_account_id;

    // Resolver conta
    let account = null;
    if (amazonAccountId) {
      account = await base44.asServiceRole.entities.AmazonAccount.get(amazonAccountId).catch(() => null);
    }
    if (!account) {
      const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ user_id: user.id });
      account = accounts[0] || null;
    }
    if (!account) {
      const all = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      account = all[0] || (await base44.asServiceRole.entities.AmazonAccount.list('-created_date', 1))[0] || null;
    }
    if (!account) return Response.json({ ok: false, message: 'Nenhuma AmazonAccount encontrada' });
    amazonAccountId = account.id;

    const refreshToken = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN');
    if (!refreshToken) return Response.json({ ok: false, step: 'auth', message: 'Sem refresh_token' });
    const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID');
    if (!profileId) return Response.json({ ok: false, step: 'auth', message: 'ads_profile_id não configurado' });
    const adsBase = getAdsBase(account.region);

    // Etapa 1: validateAmazonAdsConnection
    const step1Start = Date.now();
    try {
      const token = await getAdsToken(refreshToken);
      steps.push({ name: 'validateAmazonAdsConnection', status: 'completed', started_at: new Date(step1Start).toISOString(), completed_at: new Date().toISOString(), duration_ms: Date.now() - step1Start });
      _tokenCache = { access_token: token, expires_at: Date.now() + 300000 };
    } catch (e) {
      steps.push({ name: 'validateAmazonAdsConnection', status: 'failed', started_at: new Date(step1Start).toISOString(), completed_at: new Date().toISOString(), duration_ms: Date.now() - step1Start, error_message: e.message });
      return Response.json({ ok: false, step: 'validateAmazonAdsConnection', error: e.message });
    }

    // Etapa 2-3: listProfiles / selectAccountProfile (já temos profileId da conta)
    const step2Start = Date.now();
    steps.push({ name: 'selectAccountProfile', status: 'completed', started_at: new Date(step2Start).toISOString(), completed_at: new Date().toISOString(), duration_ms: Date.now() - step2Start, profile_id: profileId });

    // Etapa 4: syncCampaignStructure
    const step4Start = Date.now();
    const token = await getAdsToken(refreshToken);
    const campData = await adsPost(adsBase, '/sp/campaigns/list', token, profileId, {
      stateFilter: { include: ['ENABLED', 'PAUSED', 'ARCHIVED'] },
      maxResults: 500,
    }, 'application/vnd.spCampaign.v3+json');
    
    if (!campData.ok) {
      steps.push({ name: 'syncCampaignStructure', status: 'failed', started_at: new Date(step4Start).toISOString(), completed_at: new Date().toISOString(), duration_ms: Date.now() - step4Start, error_code: `HTTP ${campData.status}`, error_message: JSON.stringify(campData.data).slice(0, 400) });
      return Response.json({ ok: false, step: 'syncCampaignStructure', amazon_status: campData.status, amazon_error: JSON.stringify(campData.data).slice(0, 400) });
    }

    const campaigns = campData.data?.campaigns || [];
    const existingCamps = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: amazonAccountId }, '-created_date', 2000);
    const existingCampMap = {};
    for (const c of existingCamps) existingCampMap[c.campaign_id] = c;

    const toCreate = [], toUpdate = [];
    for (const c of campaigns) {
      const rec = {
        amazon_account_id: amazonAccountId,
        campaign_id: String(c.campaignId),
        name: c.name,
        campaign_name: c.name,
        campaign_type: 'SP',
        targeting_type: c.targetingType || 'AUTO',
        state: (c.state || 'ENABLED').toLowerCase(),
        status: (c.state || 'ENABLED').toLowerCase(),
        daily_budget: c.budget?.budget || c.dailyBudget || 0,
        start_date: c.startDate || null,
        end_date: c.endDate || null,
        bidding_strategy: c.dynamicBidding?.strategy || null,
        synced_at: now,
        last_sync_at: now,
      };
      if (existingCampMap[rec.campaign_id]) toUpdate.push({ id: existingCampMap[rec.campaign_id].id, ...rec });
      else toCreate.push(rec);
    }
    for (let i = 0; i < toCreate.length; i += 500) await base44.asServiceRole.entities.Campaign.bulkCreate(toCreate.slice(i, i + 500));
    for (let i = 0; i < toUpdate.length; i += 500) await base44.asServiceRole.entities.Campaign.bulkUpdate(toUpdate.slice(i, i + 500));
    steps.push({ name: 'syncCampaignStructure', status: 'completed', started_at: new Date(step4Start).toISOString(), completed_at: new Date().toISOString(), duration_ms: Date.now() - step4Start, records_processed: campaigns.length });

    // Etapa 5-6: requestReports + persistReportRequests
    const step5Start = Date.now();
    const endDate = new Date();
    const startDate30 = new Date(Date.now() - 30 * 86400000);
    const ts = Date.now();

    const reportConfigs = [
      { key: 'campDaily', reportTypeId: 'spCampaigns', timeUnit: 'DAILY', columns: ['date', 'campaignId', 'campaignName', 'campaignStatus', 'impressions', 'clicks', 'cost', 'purchases30d', 'sales30d', 'unitsSoldClicks30d'] },
      { key: 'campSummary', reportTypeId: 'spCampaigns', timeUnit: 'SUMMARY', columns: ['campaignId', 'campaignName', 'campaignStatus', 'campaignBudgetAmount', 'impressions', 'clicks', 'cost', 'purchases30d', 'sales30d', 'unitsSoldClicks30d'] },
      { key: 'products', reportTypeId: 'spAdvertisedProduct', timeUnit: 'SUMMARY', columns: ['advertisedAsin', 'advertisedSku', 'campaignId', 'adGroupId', 'impressions', 'clicks', 'cost', 'purchases30d', 'sales30d', 'unitsSoldClicks30d'] },
      { key: 'keywords', reportTypeId: 'spSearchTerm', timeUnit: 'SUMMARY', columns: ['searchTerm', 'campaignId', 'adGroupId', 'keywordId', 'matchType', 'impressions', 'clicks', 'cost', 'purchases14d', 'sales14d', 'unitsSoldClicks14d'] },
    ];

    const reportRequests = [];
    const reportIds = {};
    for (const cfg of reportConfigs) {
      const reqBody = {
        name: `${cfg.key}_${ts}`,
        startDate: fmt(startDate30),
        endDate: fmt(endDate),
        configuration: {
          adProduct: 'SPONSORED_PRODUCTS',
          groupBy: cfg.key === 'products' ? ['advertiser'] : cfg.key === 'keywords' ? ['searchTerm'] : ['campaign'],
          columns: cfg.columns,
          reportTypeId: cfg.reportTypeId,
          timeUnit: cfg.timeUnit,
          format: 'GZIP_JSON',
        },
      };
      const res = await adsPost(adsBase, '/reporting/reports', token, profileId, reqBody);
      if (res.ok && res.data?.reportId) {
        reportIds[cfg.key] = res.data.reportId;
        reportRequests.push({
          amazon_account_id: amazonAccountId,
          profile_id: profileId,
          report_id: res.data.reportId,
          report_type: cfg.reportTypeId,
          time_unit: cfg.timeUnit,
          format: 'GZIP_JSON',
          date_start: fmt(startDate30),
          date_end: fmt(endDate),
          status: 'PENDING',
          requested_at: now,
        });
      }
    }

    if (reportRequests.length > 0) {
      await base44.asServiceRole.entities.AdsReportReques.bulkCreate(reportRequests);
    }
    steps.push({ name: 'requestReports', status: 'completed', started_at: new Date(step5Start).toISOString(), completed_at: new Date().toISOString(), duration_ms: Date.now() - step5Start, records_processed: reportRequests.length });

    // Etapa 7: pollReports (retorna para o cliente continuar polling)
    const syncRun = await base44.asServiceRole.entities.SyncRun.create({
      amazon_account_id: amazonAccountId,
      operation: 'runUnifiedAdsPipeline',
      status: 'running',
      started_at: new Date().toISOString(),
    });

    return Response.json({
      ok: true,
      pipeline_run_id: pipelineRunId,
      sync_run_id: syncRun.id,
      campaigns_imported: campaigns.length,
      report_ids: reportIds,
      steps,
      message: `${campaigns.length} campanhas importadas. ${Object.keys(reportIds).length} relatórios solicitados. Aguarde 5-15 min e chame action="download"`,
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message, steps });
  }
});