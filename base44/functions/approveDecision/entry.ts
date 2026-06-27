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
  if (!res.ok) throw { code: data.error, message: data.error_description, status: res.status };
  tokenCache['ads'] = { access_token: data.access_token, expires_at: Date.now() + (data.expires_in - 60) * 1000 };
  return data.access_token;
}

function getAdsBaseUrl() {
  const r = Deno.env.get('ADS_REGION') || 'NA';
  return { NA: 'https://advertising-api.amazon.com', EU: 'https://advertising-api-eu.amazon.com', FE: 'https://advertising-api-fe.amazon.com' }[r] || 'https://advertising-api.amazon.com';
}

async function executeDecision(decision, mode, base44) {
  if (mode === 'mock') return { simulated: true };
  if (mode === 'hybrid') return { simulated: true, note: 'hybrid: writes simulated' };

  const token = await getAdsToken();
  const baseUrl = getAdsBaseUrl();
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID'),
    'Amazon-Advertising-API-Scope': Deno.env.get('ADS_PROFILE_ID'),
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };

  switch (decision.decision_type) {
    case 'bid_adjust': {
      const res = await fetch(`${baseUrl}/v2/sp/keywords`, {
        method: 'PUT', headers, body: JSON.stringify([{ keywordId: decision.entity_id, bid: decision.proposed_value }]),
      });
      const data = await res.json();
      if (!res.ok) throw { code: `ads_${res.status}`, message: data.details || 'Bid update failed' };
      return data;
    }
    case 'budget_change': {
      const res = await fetch(`${baseUrl}/v2/sp/campaigns`, {
        method: 'PUT', headers, body: JSON.stringify([{ campaignId: decision.entity_id, dailyBudget: decision.proposed_value }]),
      });
      const data = await res.json();
      if (!res.ok) throw { code: `ads_${res.status}`, message: data.details || 'Budget update failed' };
      return data;
    }
    case 'pause_campaign': {
      const res = await fetch(`${baseUrl}/v2/sp/campaigns`, {
        method: 'PUT', headers, body: JSON.stringify([{ campaignId: decision.entity_id, state: 'paused' }]),
      });
      const data = await res.json();
      if (!res.ok) throw { code: `ads_${res.status}`, message: data.details || 'Pause failed' };
      return data;
    }
    case 'enable_campaign': {
      const res = await fetch(`${baseUrl}/v2/sp/campaigns`, {
        method: 'PUT', headers, body: JSON.stringify([{ campaignId: decision.entity_id, state: 'enabled' }]),
      });
      const data = await res.json();
      if (!res.ok) throw { code: `ads_${res.status}`, message: data.details || 'Enable failed' };
      return data;
    }
    default:
      return { note: `Action ${decision.decision_type} not implemented in real mode yet` };
  }
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { decision_id } = body;
    if (!decision_id) return Response.json({ error: 'decision_id required' }, { status: 400 });

    const decision = await base44.asServiceRole.entities.Decision.get(decision_id);
    if (!decision) return Response.json({ error: 'Decision not found' }, { status: 404 });
    if (decision.status !== 'pending') return Response.json({ error: `Decision is already ${decision.status}` }, { status: 409 });

    // Check account safety limits
    const account = await base44.asServiceRole.entities.AmazonAccount.filter({ amazon_account_id: decision.amazon_account_id });
    if (account.length > 0) {
      const acc = account[0];
      if (decision.proposed_value && decision.current_value) {
        const changePct = Math.abs((decision.proposed_value - decision.current_value) / decision.current_value) * 100;
        if (changePct > (acc.max_bid_change_pct || 20)) {
          return Response.json({ error: `Change ${changePct.toFixed(1)}% exceeds max allowed ${acc.max_bid_change_pct}%` }, { status: 400 });
        }
      }
      if (decision.decision_type === 'budget_change' && decision.proposed_value > (acc.max_daily_budget_limit || 1000)) {
        return Response.json({ error: `Proposed budget $${decision.proposed_value} exceeds max limit $${acc.max_daily_budget_limit}` }, { status: 400 });
      }
    }

    const mode = Deno.env.get('OPERATION_MODE') || 'mock';

    // Execute
    await base44.asServiceRole.entities.Decision.update(decision_id, {
      status: 'approved', reviewed_by: user.id, reviewed_at: new Date().toISOString(),
    });

    const result = await executeDecision(decision, mode, base44);

    await base44.asServiceRole.entities.Decision.update(decision_id, {
      status: 'executed', executed_at: new Date().toISOString(),
    });

    // Log learning event
    await base44.asServiceRole.entities.LearningEvent.create({
      amazon_account_id: decision.amazon_account_id,
      event_type: 'decision_approved',
      entity_type: decision.entity_type,
      entity_id: decision.entity_id,
      observation: `Decision approved and executed by user ${user.id}. Mode: ${mode}.`,
      decision_id,
      recorded_at: new Date().toISOString(),
    });

    return Response.json({ ok: true, mode, result });
  } catch (error) {
    const err = error || {};
    return Response.json({ ok: false, error_code: err.code || 'unknown', message: err.message || 'Execution failed' }, { status: err.status || 500 });
  }
});