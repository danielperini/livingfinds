/**
 * syncAds — Sincroniza campanhas SP via Amazon Ads API.
 * Payload: { amazon_account_id }
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const tokenCache = {};

async function getAdsToken(refreshTokenOverride = null) {
  const cacheKey = refreshTokenOverride ? 'ads_override' : 'ads';
  const cached = tokenCache[cacheKey];
  if (cached && cached.expires_at > Date.now()) return cached.access_token;
  const refreshToken = refreshTokenOverride || Deno.env.get('ADS_REFRESH_TOKEN');
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: Deno.env.get('ADS_CLIENT_ID'),
    client_secret: Deno.env.get('ADS_CLIENT_SECRET'),
  });
  let attempt = 0;
  while (attempt < 3) {
    attempt++;
    const res = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    if (res.status === 429 || res.status >= 500) {
      await new Promise((resolve) => setTimeout(resolve, Math.pow(2, attempt) * 500));
      continue;
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error_description || `Token refresh failed (${res.status})`);
    tokenCache[cacheKey] = { access_token: data.access_token, expires_at: Date.now() + (data.expires_in - 60) * 1000 };
    return data.access_token;
  }
  throw new Error('Token refresh failed after 3 attempts');
}

function getAdsBaseUrl() {
  const region = (Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
  if (region.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (region.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

Deno.serve(async (req) => {
  const startTime = Date.now();
  let syncRunId = null;
  let base44;

  try {
    base44 = createClientFromRequest(req);
    const isAuthenticated = await base44.auth.isAuthenticated().catch(() => false);
    if (!isAuthenticated) console.log('[syncAds] Chamada sem sessão de usuário — modo service role');

    const body = await req.json().catch(() => ({}));
    const amazonAccountId = body.amazon_account_id;
    if (!amazonAccountId) return Response.json({ error: 'amazon_account_id required' }, { status: 400 });

    const account = await base44.asServiceRole.entities.AmazonAccount.get(amazonAccountId);
    const entityRefreshToken = account?.ads_refresh_token || null;

    const syncRun = await base44.asServiceRole.entities.SyncRun.create({
      amazon_account_id: amazonAccountId,
      operation: 'syncAds',
      status: 'running',
      started_at: new Date().toISOString(),
    });
    syncRunId = syncRun.id;

    const token = await getAdsToken(entityRefreshToken);
    const adsBase = getAdsBaseUrl();
    const profileId = account?.ads_profile_id || Deno.env.get('ADS_PROFILE_ID');
    const headers = {
      Authorization: `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID'),
      'Amazon-Advertising-API-Scope': String(profileId),
      'Content-Type': 'application/vnd.spCampaign.v3+json',
      Accept: 'application/vnd.spCampaign.v3+json',
    };

    const campaignList = [];
    const requestIds = [];
    const seenTokens = new Set();
    let nextToken = null;
    let pages = 0;

    do {
      const payload = {
        stateFilter: { include: ['ENABLED', 'PAUSED'] },
        maxResults: 500,
        ...(nextToken ? { nextToken } : {}),
      };

      const gatewayResponse = await base44.asServiceRole.functions.invoke('amazonApiGateway', {
        amazon_account_id: amazonAccountId,
        api_family: 'ADS',
        operation: 'listSponsoredProductsCampaigns',
        endpoint: `${adsBase}/sp/campaigns/list`,
        method: 'POST',
        headers,
        payload,
        max_attempts: 5,
        _service_role: true,
      });

      const gatewayData = gatewayResponse?.data || gatewayResponse || {};
      if (!gatewayData.ok) {
        const firstError = gatewayData.errors?.[0];
        throw new Error(`ADS ${gatewayData.status || 500}: ${firstError?.message || firstError?.code || 'Falha ao listar campanhas'}`);
      }

      const data = gatewayData.payload || {};
      campaignList.push(...(data?.campaigns || []));
      if (gatewayData.request_id) requestIds.push(gatewayData.request_id);
      pages++;

      nextToken = data?.nextToken || null;
      if (nextToken && seenTokens.has(nextToken)) throw new Error('Paginação Ads retornou nextToken repetido');
      if (nextToken) seenTokens.add(nextToken);
      if (pages >= 100 && nextToken) throw new Error('Paginação Ads excedeu o limite de segurança de 100 páginas');
    } while (nextToken);

    let upserted = 0;
    for (const campaign of campaignList) {
      const existing = await base44.asServiceRole.entities.Campaign.filter({
        amazon_account_id: amazonAccountId,
        campaign_id: String(campaign.campaignId),
      });
      const record = {
        amazon_account_id: amazonAccountId,
        campaign_id: String(campaign.campaignId),
        name: campaign.name,
        campaign_type: 'SP',
        targeting_type: campaign.targetingType,
        state: (campaign.state || 'ENABLED').toLowerCase(),
        daily_budget: campaign.budget?.budget || campaign.dailyBudget || 0,
        start_date: campaign.startDate,
        end_date: campaign.endDate || null,
        bidding_strategy: campaign.dynamicBidding?.strategy || campaign.bidding?.strategy || null,
        synced_at: new Date().toISOString(),
      };
      if (existing.length > 0) await base44.asServiceRole.entities.Campaign.update(existing[0].id, record);
      else await base44.asServiceRole.entities.Campaign.create(record);
      upserted++;
    }

    await base44.asServiceRole.entities.SyncRun.update(syncRunId, {
      status: 'success',
      records_received: campaignList.length,
      records_upserted: upserted,
      duration_ms: Date.now() - startTime,
      completed_at: new Date().toISOString(),
    });

    return Response.json({
      ok: true,
      pages,
      records_received: campaignList.length,
      records_upserted: upserted,
      amazon_request_ids: requestIds,
    });
  } catch (error) {
    if (syncRunId && base44) {
      await base44.asServiceRole.entities.SyncRun.update(syncRunId, {
        status: 'error',
        error_message: error.message,
        duration_ms: Date.now() - startTime,
        completed_at: new Date().toISOString(),
      }).catch(() => {});
    }
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});
