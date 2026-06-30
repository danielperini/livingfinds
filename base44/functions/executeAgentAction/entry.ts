/**
 * executeAgentAction — Executa uma ação aprovada do Amazon Ads Operator via Amazon Ads API v3.
 * SEGURANÇA: Só executa ações com status='approved' ou não-críticas com requires_approval=false.
 * MIGRADO PARA API v3 (endpoints /sp/*)
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
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || 'Token failed');
  tokenCache['ads'] = { access_token: data.access_token, expires_at: Date.now() + (data.expires_in - 60) * 1000 };
  return data.access_token;
}

function getAdsBaseUrl() {
  const r = (Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function adsRequestV3(method, path, body, contentType = 'application/json') {
  const token = await getAdsToken();
  const res = await fetch(`${getAdsBaseUrl()}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID'),
      'Amazon-Advertising-API-Scope': String(Deno.env.get('ADS_PROFILE_ID')),
      'Content-Type': contentType,
      'Accept': contentType,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: res.status, data, requestId: res.headers.get('x-amzn-requestid') || '' };
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { action_id, approve, reject } = body;
    if (!action_id) return Response.json({ error: 'action_id required' }, { status: 400 });

    const action = await base44.asServiceRole.entities.AgentAction.get(action_id);
    if (!action) return Response.json({ error: 'Action not found' }, { status: 404 });

    const now = new Date().toISOString();

    // Rejeitar
    if (reject) {
      await base44.asServiceRole.entities.AgentAction.update(action_id, {
        status: 'rejected',
        reviewed_by: user.id,
        reviewed_at: now,
      });
      return Response.json({ ok: true, status: 'rejected' });
    }

    // Só executa se aprovado ou não requer aprovação
    if (action.requires_approval && !approve && action.status !== 'approved') {
      return Response.json({ error: 'Ação requer aprovação antes de executar' }, { status: 403 });
    }

    if (approve) {
      await base44.asServiceRole.entities.AgentAction.update(action_id, {
        status: 'approved',
        reviewed_by: user.id,
        reviewed_at: now,
      });
    }

    let apiResult = null;
    let requestId = '';

    switch (action.action) {
      case 'update_bid': {
        // API v3: PUT /sp/keywords com content-type específico
        const result = await adsRequestV3('PUT', '/sp/keywords', [{
          keywordId: action.keyword_id,
          bid: action.new_value,
        }], 'application/vnd.spKeyword.v3+json');
        apiResult = result.data;
        requestId = result.requestId;
        
        // Salvar no BidHistory
        await base44.asServiceRole.entities.BidHistory.create({
          amazon_account_id: action.amazon_account_id,
          entity_type: 'keyword',
          entity_id: action.keyword_id,
          keyword: action.keyword,
          asin: action.asin,
          old_bid: action.current_value,
          new_bid: action.new_value,
          reason: action.reason,
          status: 'executed',
          applied_by: 'agent',
          created_at: now,
          executed_at: now,
          amazon_response: JSON.stringify(apiResult).slice(0, 500),
        });
        
        // Atualizar bid na keyword
        const kws = await base44.asServiceRole.entities.Keyword.filter({
          amazon_account_id: action.amazon_account_id,
          keyword_id: action.keyword_id,
        });
        if (kws.length > 0) {
          await base44.asServiceRole.entities.Keyword.update(kws[0].id, {
            current_bid: action.new_value,
            bid: action.new_value,
          });
        }
        break;
      }

      case 'update_budget': {
        // API v3: PUT /sp/campaigns
        const result = await adsRequestV3('PUT', '/sp/campaigns', [{
          campaignId: action.campaign_id,
          budget: { budgetType: 'DAILY', budget: action.new_value },
        }], 'application/vnd.spCampaign.v3+json');
        apiResult = result.data;
        requestId = result.requestId;
        
        await base44.asServiceRole.entities.BidHistory.create({
          amazon_account_id: action.amazon_account_id,
          entity_type: 'campaign',
          entity_id: action.campaign_id,
          asin: action.asin,
          old_bid: action.current_value,
          new_bid: action.new_value,
          budget_before: action.current_value,
          budget_after: action.new_value,
          reason: action.reason,
          status: 'executed',
          applied_by: 'agent',
          created_at: now,
          executed_at: now,
          amazon_response: JSON.stringify(apiResult).slice(0, 500),
        });
        
        const campaigns = await base44.asServiceRole.entities.Campaign.filter({
          amazon_account_id: action.amazon_account_id,
          campaign_id: action.campaign_id,
        });
        if (campaigns.length > 0) {
          await base44.asServiceRole.entities.Campaign.update(campaigns[0].id, { 
            daily_budget: action.new_value,
            synced_at: now,
          });
        }
        break;
      }

      case 'pause_campaign': {
        // API v3: PUT /sp/campaigns
        const result = await adsRequestV3('PUT', '/sp/campaigns', [{
          campaignId: action.campaign_id,
          state: 'PAUSED',
        }], 'application/vnd.spCampaign.v3+json');
        apiResult = result.data;
        requestId = result.requestId;
        
        const campsToPause = await base44.asServiceRole.entities.Campaign.filter({
          amazon_account_id: action.amazon_account_id,
          campaign_id: action.campaign_id,
        });
        if (campsToPause.length > 0) {
          await base44.asServiceRole.entities.Campaign.update(campsToPause[0].id, { 
            state: 'paused', 
            status: 'paused',
            synced_at: now,
          });
        }
        await base44.asServiceRole.entities.LearningEvent.create({
          amazon_account_id: action.amazon_account_id,
          event_type: 'campaign_paused',
          entity_type: 'campaign',
          entity_id: action.campaign_id,
          observation: `Campanha pausada: ${action.reason}`,
          recorded_at: now,
        });
        break;
      }

      case 'enable_campaign': {
        // API v3: PUT /sp/campaigns
        const result = await adsRequestV3('PUT', '/sp/campaigns', [{
          campaignId: action.campaign_id,
          state: 'ENABLED',
        }], 'application/vnd.spCampaign.v3+json');
        apiResult = result.data;
        requestId = result.requestId;
        
        const campsToEnable = await base44.asServiceRole.entities.Campaign.filter({
          amazon_account_id: action.amazon_account_id,
          campaign_id: action.campaign_id,
        });
        if (campsToEnable.length > 0) {
          await base44.asServiceRole.entities.Campaign.update(campsToEnable[0].id, { 
            state: 'enabled', 
            status: 'enabled',
            synced_at: now,
          });
        }
        break;
      }

      case 'negative_keyword': {
        // API v3: POST /sp/negativeKeywords
        const result = await adsRequestV3('POST', '/sp/negativeKeywords', {
          negativeKeywords: [{
            campaignId: action.campaign_id,
            adGroupId: action.ad_group_id,
            keywordText: action.keyword,
            matchType: 'NEGATIVE_EXACT',
            state: 'ENABLED',
          }],
        }, 'application/vnd.spNegativeKeyword.v3+json');
        apiResult = result.data;
        requestId = result.requestId;
        
        // Extrair negativeKeywordId se criado
        const negId = apiResult?.negativeKeywords?.success?.[0]?.negativeKeywordId || 
                      apiResult?.success?.[0]?.negativeKeywordId || '';
        
        await base44.asServiceRole.entities.LearningEvent.create({
          amazon_account_id: action.amazon_account_id,
          event_type: 'keyword_negativated',
          entity_type: 'keyword',
          entity_id: action.keyword_id || action.keyword,
          observation: `Keyword negativada: "${action.keyword}". Motivo: ${action.reason}${negId ? ` (ID: ${negId})` : ''}`,
          recorded_at: now,
        });
        break;
      }

      default:
        return Response.json({ error: `Ação '${action.action}' não mapeada para execução direta` }, { status: 400 });
    }

    await base44.asServiceRole.entities.AgentAction.update(action_id, {
      status: 'executed',
      executed_at: now,
      execution_response: JSON.stringify(apiResult).slice(0, 500),
    });

    return Response.json({ 
      ok: true, 
      status: 'executed', 
      api_result: apiResult,
      request_id: requestId,
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});