/**
 * executeAutopilotDecision — Executa uma ou mais decisões aprovadas via Amazon Ads API
 * Payload: { decision_ids: string[] } ou { decision_id: string }
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

async function adsRequest(path, method, body) {
  const token = await getAdsToken();
  const res = await fetch(`${getAdsBaseUrl()}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID'),
      'Amazon-Advertising-API-Scope': String(Deno.env.get('ADS_PROFILE_ID')),
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function executeDecision(decision, base44) {
  const { action, entity_type, entity_id, new_value, amazon_account_id } = decision;

  let result;
  switch (action) {
    case 'update_bid':
      if (entity_type === 'keyword') {
        result = await adsRequest('/v2/sp/keywords', 'PUT', [{ keywordId: entity_id, bid: new_value }]);
      } else if (entity_type === 'ad_group') {
        result = await adsRequest('/v2/sp/adGroups', 'PUT', [{ adGroupId: entity_id, defaultBid: new_value }]);
      } else {
        result = { ok: false, data: { error: 'entity_type not supported for bid update' } };
      }
      break;

    case 'update_budget':
      result = await adsRequest('/v2/sp/campaigns', 'PUT', [{ campaignId: entity_id, dailyBudget: new_value }]);
      break;

    case 'pause_campaign':
      result = await adsRequest('/v2/sp/campaigns', 'PUT', [{ campaignId: entity_id, state: 'paused' }]);
      break;

    case 'enable_campaign':
      result = await adsRequest('/v2/sp/campaigns', 'PUT', [{ campaignId: entity_id, state: 'enabled' }]);
      break;

    case 'pause_keyword':
      result = await adsRequest('/v2/sp/keywords', 'PUT', [{ keywordId: entity_id, state: 'paused' }]);
      break;

    case 'pause_ad_group':
      result = await adsRequest('/v2/sp/adGroups', 'PUT', [{ adGroupId: entity_id, state: 'paused' }]);
      break;

    case 'negative_keyword':
      result = await adsRequest('/v2/sp/negativeKeywords', 'POST', [{
        campaignId: decision.campaign_id || entity_id,
        keywordText: decision.entity_name,
        matchType: 'negativeExact',
        state: 'enabled',
      }]);
      break;

    default:
      result = { ok: false, data: { error: `Unsupported action: ${action}` } };
  }

  // Registrar no histórico de bids
  if (result.ok && (action === 'update_bid' || action === 'update_budget')) {
    await base44.asServiceRole.entities.BidHistory.create({
      amazon_account_id,
      entity_type,
      entity_id,
      entity_name: decision.entity_name,
      bid_before: action === 'update_bid' ? decision.current_value : null,
      bid_after: action === 'update_bid' ? new_value : null,
      budget_before: action === 'update_budget' ? decision.current_value : null,
      budget_after: action === 'update_budget' ? new_value : null,
      change_pct: decision.change_pct,
      reason: decision.reason,
      applied_by: 'autopilot',
      decision_id: decision.id,
      amazon_response: JSON.stringify(result.data),
    });
  }

  return result;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const ids = body.decision_ids || (body.decision_id ? [body.decision_id] : []);
    if (!ids.length) return Response.json({ error: 'decision_ids required' }, { status: 400 });

    // Safety check: não executar sem aprovação
    const results = [];
    for (const id of ids) {
      const decision = await base44.asServiceRole.entities.AutopilotDecision.get(id);
      if (!decision) { results.push({ id, ok: false, error: 'Not found' }); continue; }
      if (decision.status !== 'approved') { results.push({ id, ok: false, error: 'Not approved' }); continue; }

      // Travas de segurança — ações críticas exigem requires_approval=false
      const isCritical = ['pause_campaign', 'enable_campaign', 'negative_keyword'].includes(decision.action);
      if (isCritical) {
        results.push({ id, ok: false, error: 'Critical action requires manual confirmation' }); continue;
      }

      const result = await executeDecision(decision, base44);
      const newStatus = result.ok ? 'executed' : 'failed';
      await base44.asServiceRole.entities.AutopilotDecision.update(id, {
        status: newStatus,
        executed_at: new Date().toISOString(),
        execution_response: JSON.stringify(result.data),
      });
      results.push({ id, ok: result.ok, status: newStatus, response: result.data });
    }

    const executed = results.filter(r => r.ok).length;
    const failed = results.filter(r => !r.ok).length;
    return Response.json({ ok: true, executed, failed, results });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});