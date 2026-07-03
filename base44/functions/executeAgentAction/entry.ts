/**
 * executeAgentAction — Executa uma ação aprovada via Amazon Ads API v3.
 * Usa as credenciais da AmazonAccount da própria ação, com fallback nos secrets.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const tokenCache = {};

async function getAdsToken(refreshToken) {
  const cacheKey = String(refreshToken).slice(-16);
  const cached = tokenCache[cacheKey];
  if (cached && cached.expires_at > Date.now()) return cached.access_token;

  const clientId = Deno.env.get('ADS_CLIENT_ID');
  const clientSecret = Deno.env.get('ADS_CLIENT_SECRET');
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Credenciais Amazon Ads incompletas.');
  }

  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const response = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || 'Falha ao gerar token Amazon Ads.');
  }

  tokenCache[cacheKey] = {
    access_token: data.access_token,
    expires_at: Date.now() + Math.max(60, Number(data.expires_in || 3600) - 60) * 1000,
  };

  return data.access_token;
}

function getAdsBaseUrl(region) {
  const normalized = String(region || Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
  if (normalized.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (normalized.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function adsRequestV3(account, method, path, body, contentType) {
  const refreshToken = account?.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN');
  const profileId = account?.ads_profile_id || account?.profile_id || Deno.env.get('ADS_PROFILE_ID');
  const clientId = Deno.env.get('ADS_CLIENT_ID');

  if (!refreshToken || !profileId || !clientId) {
    throw new Error('ADS_REFRESH_TOKEN, ADS_PROFILE_ID ou ADS_CLIENT_ID não configurado.');
  }

  const token = await getAdsToken(refreshToken);
  const response = await fetch(`${getAdsBaseUrl(account?.region)}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': clientId,
      'Amazon-Advertising-API-Scope': String(profileId),
      'Content-Type': contentType,
      Accept: contentType,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  const requestId = response.headers.get('x-amzn-requestid') || '';
  const successes = data?.campaigns?.success || data?.keywords?.success || data?.negativeKeywords?.success || data?.success || [];
  const errors = data?.campaigns?.error || data?.campaigns?.errors || data?.keywords?.error || data?.negativeKeywords?.error || data?.errors || data?.error || [];
  const hasSuccess = Array.isArray(successes) ? successes.length > 0 : Boolean(successes);
  const hasErrors = Array.isArray(errors) ? errors.length > 0 : Boolean(errors);

  if (!response.ok || (!hasSuccess && hasErrors)) {
    const error = new Error(`Amazon Ads recusou a operação (HTTP ${response.status}).`);
    error.http_status = response.status;
    error.amazon_response = data;
    error.request_id = requestId;
    throw error;
  }

  return { status: response.status, data, requestId };
}

async function updateCampaignLocal(base44, action, state, now) {
  const campaigns = await base44.asServiceRole.entities.Campaign.filter({
    amazon_account_id: action.amazon_account_id,
    campaign_id: String(action.campaign_id),
  });

  for (const campaign of campaigns) {
    await base44.asServiceRole.entities.Campaign.update(campaign.id, {
      state,
      status: state,
      archived: false,
      synced_at: now,
      last_sync_at: now,
      last_activity_at: now,
    });
  }

  const linked = await base44.asServiceRole.entities.Product.filter({
    amazon_account_id: action.amazon_account_id,
    linked_campaign_id: String(action.campaign_id),
  });

  for (const product of linked) {
    await base44.asServiceRole.entities.Product.update(product.id, {
      has_campaign: true,
      linked_campaign_id: String(action.campaign_id),
      campaign_status: state === 'enabled' ? 'active' : 'paused',
    });
  }
}

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const user = await base44.auth.me();
    if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

    const body = await request.json().catch(() => ({}));
    const { action_id, approve, reject } = body;
    if (!action_id) {
      return Response.json({ ok: false, error: 'action_id required' }, { status: 400 });
    }

    const action = await base44.asServiceRole.entities.AgentAction.get(action_id);
    if (!action) {
      return Response.json({ ok: false, error: 'Action not found' }, { status: 404 });
    }

    const account = await base44.asServiceRole.entities.AmazonAccount
      .get(action.amazon_account_id)
      .catch(() => null);
    if (!account) {
      return Response.json({ ok: false, error: 'AmazonAccount não encontrada' }, { status: 404 });
    }

    const now = new Date().toISOString();

    if (reject) {
      await base44.asServiceRole.entities.AgentAction.update(action_id, {
        status: 'rejected',
        reviewed_by: user.id,
        reviewed_at: now,
      });
      return Response.json({ ok: true, status: 'rejected' });
    }

    if (action.requires_approval && !approve && action.status !== 'approved') {
      return Response.json({ ok: false, error: 'Ação requer aprovação antes de executar' }, { status: 403 });
    }

    if (approve) {
      await base44.asServiceRole.entities.AgentAction.update(action_id, {
        status: 'approved',
        reviewed_by: user.id,
        reviewed_at: now,
      });
    }

    await base44.asServiceRole.entities.AgentAction.update(action_id, {
      status: 'executing',
      last_attempt_at: now,
    }).catch(() => {});

    let result;

    switch (action.action) {
      case 'update_bid':
        result = await adsRequestV3(account, 'PUT', '/sp/keywords', {
          keywords: [{ keywordId: String(action.keyword_id), bid: Number(action.new_value) }],
        }, 'application/vnd.spKeyword.v3+json');
        break;

      case 'update_budget':
        result = await adsRequestV3(account, 'PUT', '/sp/campaigns', {
          campaigns: [{
            campaignId: String(action.campaign_id),
            budget: { budgetType: 'DAILY', budget: Number(action.new_value) },
          }],
        }, 'application/vnd.spCampaign.v3+json');
        break;

      case 'pause_campaign':
        result = await adsRequestV3(account, 'PUT', '/sp/campaigns', {
          campaigns: [{ campaignId: String(action.campaign_id), state: 'PAUSED' }],
        }, 'application/vnd.spCampaign.v3+json');
        await updateCampaignLocal(base44, action, 'paused', now);
        break;

      case 'enable_campaign':
        result = await adsRequestV3(account, 'PUT', '/sp/campaigns', {
          campaigns: [{ campaignId: String(action.campaign_id), state: 'ENABLED' }],
        }, 'application/vnd.spCampaign.v3+json');
        await updateCampaignLocal(base44, action, 'enabled', now);
        break;

      case 'negative_keyword':
        result = await adsRequestV3(account, 'POST', '/sp/negativeKeywords', {
          negativeKeywords: [{
            campaignId: String(action.campaign_id),
            adGroupId: String(action.ad_group_id),
            keywordText: action.keyword,
            matchType: 'NEGATIVE_EXACT',
            state: 'ENABLED',
          }],
        }, 'application/vnd.spNegativeKeyword.v3+json');
        break;

      default:
        return Response.json({
          ok: false,
          error: `Ação '${action.action}' não mapeada para execução direta`,
        }, { status: 400 });
    }

    if (action.action === 'update_bid') {
      const keywords = await base44.asServiceRole.entities.Keyword.filter({
        amazon_account_id: action.amazon_account_id,
        keyword_id: String(action.keyword_id),
      });
      for (const keyword of keywords) {
        await base44.asServiceRole.entities.Keyword.update(keyword.id, {
          current_bid: Number(action.new_value),
          bid: Number(action.new_value),
          last_bid_change_at: now,
        });
      }
    }

    if (action.action === 'update_budget') {
      const campaigns = await base44.asServiceRole.entities.Campaign.filter({
        amazon_account_id: action.amazon_account_id,
        campaign_id: String(action.campaign_id),
      });
      for (const campaign of campaigns) {
        await base44.asServiceRole.entities.Campaign.update(campaign.id, {
          daily_budget: Number(action.new_value),
          synced_at: now,
          last_sync_at: now,
        });
      }
    }

    await base44.asServiceRole.entities.AgentAction.update(action_id, {
      status: 'executed',
      executed_at: now,
      execution_response: JSON.stringify(result.data).slice(0, 2000),
      amazon_request_id: result.requestId,
    });

    await base44.asServiceRole.entities.LearningEvent.create({
      amazon_account_id: action.amazon_account_id,
      event_type: action.action,
      entity_type: action.campaign_id ? 'campaign' : 'keyword',
      entity_id: String(action.campaign_id || action.keyword_id || action_id),
      observation: `${action.action} executada via Amazon Ads API. ${action.reason || ''}`,
      recorded_at: now,
    }).catch(() => {});

    return Response.json({
      ok: true,
      status: 'executed',
      api_result: result.data,
      request_id: result.requestId,
    });
  } catch (error) {
    console.error('[executeAgentAction]', error);
    return Response.json({
      ok: false,
      error: error?.message || 'Erro ao executar ação.',
      http_status: error?.http_status || 500,
      request_id: error?.request_id || null,
      amazon_response: error?.amazon_response || null,
    }, { status: 500 });
  }
});