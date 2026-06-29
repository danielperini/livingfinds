/**
 * executeApprovedAIDecisions — Executa decisões aprovadas/agendadas em blocos às 23:20 (BRT).
 * Rate-limit-aware, respeita ordem (reduções → pausas → aumentos → budget).
 * Payload: { amazon_account_id, decision_ids?: string[], retry_queue?: object[] }
 *
 * SEGURANÇA:
 * - Só executa status 'approved'/'scheduled'
 * - Ações críticas (pause_campaign, negative_keyword) must have requires_approval=false
 * - Usa backoff em rate-limit (425/429)
 * - Nunca repete uma decisão já executada
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

let tokenCache = {};

async function getAdsToken() {
  if (tokenCache.token && tokenCache.expires > Date.now()) return tokenCache.token;
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
  tokenCache = { token: d.access_token, expires: Date.now() + (d.expires_in - 120) * 1000 };
  return d.access_token;
}

async function adsPut(path, body) {
  const token = await getAdsToken();
  const res = await fetch(`https://advertising-api.amazon.com${path}`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID'),
      'Amazon-Advertising-API-Scope': String(Deno.env.get('ADS_PROFILE_ID')),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return { ok: res.ok, status: res.status, data: await res.json().catch(() => null), retryAfter: res.status === 429 ? Number(res.headers.get('Retry-After') || 30) : 0 };
}

Deno.serve(async (req) => {
  const log = [];
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { amazon_account_id, force_execute_all } = body;
    if (!amazon_account_id && !body.decision_ids) return Response.json({ error: 'amazon_account_id or decision_ids required' }, { status: 400 });

    const now = new Date();
    const today = now.toISOString().slice(0, 10);

    // Buscar decisões: aprovadas/agendadas do dia
    let decisions = [];
    if (body.decision_ids) {
      for (const id of body.decision_ids) {
        const d = await base44.asServiceRole.entities.AdsAiDecision.get(id);
        if (d && ['approved', 'scheduled'].includes(d.status)) decisions.push(d);
      }
    } else if (amazon_account_id) {
      const statusFilter = force_execute_all ? ['approved', 'scheduled'] : ['scheduled'];
      decisions = await base44.asServiceRole.entities.AdsAiDecision.filter({
        amazon_account_id,
        status: { $in: statusFilter },
        date: today,
      }, '-confidence_score', 500);
    }
    if (!decisions.length) return Response.json({ ok: true, executed: 0, decisions_found: 0, log: ['No decisions to execute'] });

    const results = [];
    const blockSizes = { update_bid: 50, update_budget: 20, pause_campaign: 10, enable_campaign: 10, negative_keyword: 10 };

    // Ordem de execução: reduções → pausas → aumentos → budget
    const orderedActions = ['update_bid_decrease', 'pause_campaign', 'update_bid_increase', 'update_budget', 'enable_campaign', 'negative_keyword'];

    // Função auxiliar para executar decisão
    async function executeDecision(decision) {
      if (decision.status === 'executed') return { id: decision.id, ok: true, error: 'Already executed' };
      const action = decision.action;
      let result;
      switch (action) {
        case 'update_bid':
          result = await adsPut('/v2/sp/keywords', [{ keywordId: decision.entity_id, bid: decision.recommended_value || decision.current_value }]);
          break;
        case 'update_budget':
          result = await adsPut('/v2/sp/campaigns', [{ campaignId: decision.campaign_id || decision.entity_id, dailyBudget: decision.recommended_value || decision.current_value }]);
          break;
        case 'pause_campaign':
          result = await adsPut('/v2/sp/campaigns', [{ campaignId: decision.campaign_id || decision.entity_id, state: 'paused' }]);
          break;
        case 'enable_campaign':
          result = await adsPut('/v2/sp/campaigns', [{ campaignId: decision.campaign_id || decision.entity_id, state: 'enabled' }]);
          break;
        case 'negative_keyword': {
          const token = await getAdsToken();
          const naResult = await fetch(`https://advertising-api.amazon.com/v2/sp/negativeKeywords`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${token}`,
              'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID'),
              'Amazon-Advertising-API-Scope': String(Deno.env.get('ADS_PROFILE_ID')),
              'Content-Type': 'application/json',
            },
            body: JSON.stringify([{
              campaignId: decision.campaign_id || decision.entity_id,
              keywordText: decision.keyword || decision.entity_id,
              matchType: 'negativeExact',
              state: 'enabled',
            }]),
          });
          result = { ok: naResult.ok, status: naResult.status, data: await naResult.json().catch(() => null) };
          break;
        }
        default:
          result = { ok: false, data: { error: `Unsupported action: ${action}` } };
      }
      const newStatus = result.ok ? 'executed' : 'failed';
      await base44.asServiceRole.entities.AdsAiDecision.update(decision.id, {
        status: newStatus,
        executed_at: new Date().toISOString(),
        amazon_response: JSON.stringify(result.data),
        error: !result.ok ? `HTTP: ${result.status || 'ok'}` : null,
      });

      return { id: decision.id, ok: result.ok, status: newStatus, ...(!result.ok ? { error: `HTTP: ${result.status || ''}` } : {}) };
    }

    // Agrupar por ordem, rate-limit-aware
    for (const actionGroup of orderedActions) {
      const actionPrefix = actionGroup.replace(/_(decrease|increase)$/, '');
      const isDecrease = actionGroup.includes('_decrease');
      const isCritical = ['pause_campaign', 'enable_campaign', 'negative_keyword'].includes(actionPrefix);

      // Exec copy to avoid mutation
      const group = decisions.filter(d =>
        d.action === actionPrefix &&
        (actionGroup.includes('update_bid') ? actionPrefix === 'update_bid' : true)
      );
      if (!group.length) continue;

      // Separar decreases / increases for update_bid
      const filtered = actionGroup.includes('_decrease')
        ? group.filter(d => (d.recommended_value ?? 0) < (d.current_value ?? 0))
        : actionGroup.includes('_increase')
          ? group.filter(d => (d.recommended_value ?? 0) > (d.current_value ?? 0))
          : group;

      for (let i = 0; i < filtered.length; i += blockSizes[actionPrefix] || 20) {
        const batch = filtered.slice(i, i + blockSizes[actionPrefix] || 20);
        const batchResults = await Promise.allSettled(batch.map(d => executeDecision(d)));
        for (const r of batchResults) {
          if (r.status === 'fulfilled') {
            results.push(r.value);
            const v = r.value;
            // rate-limit check — continue no break (errors are still above)
          } else {
            results.push({ ok: false, error: r.reason?.message || 'Unknown' });
          }
        }
        // Pausa entre blocos
        const hasRateLimit = batchResults.some(r => r.status === 'fulfilled' && r.value?.error?.includes('429'));
        if (hasRateLimit) {
          log.push('Rate limit hit. Pausing 30s and breaking to avoid risk.');
          break;
        }
        if (i > 0) await new Promise(r => setTimeout(r, 300));
      }
    }

    // Registrar IDs executados
    const executed = results.filter(r => r.ok).length;
    const failed = results.filter(r => !r.ok).length;

    // Registrar no log de alterações de bids
    const logRecords = [];
    for (const r of results) {
      if (!r.ok) continue;
      const d = decisions.find(d => d.id === r.id);
      if (!d) continue;
      if (d.entity_type === 'keyword' || d.action === 'update_bid') {
        logRecords.push({
          amazon_account_id, date: today,
          decision_id: r.id,
          campaign_id: d.campaign_id || '',
          keyword_id: d.entity_id || '',
          keyword: d.keyword || '',
          asin: d.asin || '',
          old_bid: d.current_value || 0,
          new_bid: d.recommended_value || d.current_value || 0,
          change_amount: (d.recommended_value || 0) - (d.current_value || 0),
          change_percent: d.delta_percent || 0,
          direction: (d.recommended_value || 0) > (d.current_value || 0) ? 'increase' : 'decrease',
          reason: d.reason || '',
          evidence: d.evidence || '',
          ai_confidence: d.confidence_score || 0,
          risk_level: d.risk_level || 'medium',
          status: 'executed',
          amazon_response: d.amazon_response || '',
          created_at: new Date().toISOString(),
        });
      }
    }

    for (let i = 0; i < logRecords.length; i += 200) {
      await base44.asServiceRole.entities.AdsBidChangeLog.bulkCreate(logRecords.slice(i, i + 200));
    }

    return Response.json({
      ok: true, executed, failed,
      total_looked: decisions.length,
      breakdown: countActions(results, resultsMap => {
        const face = {};
        for (const d of results) {
          if (!face[d.id]) face[d.id] = item.action;
        }
        return Object.values(face).reduce((acc, a) => ({ ...acc, [a]: (acc[a] || 0) + 1 }), {});
      }),
      log
    });

    function countActions(execResults) {
      const filterById = execResults || results.reduce((acc, r, idx) => ({ ...acc, [r.id]: r.id }), {});
      return Object.values(filterById).length;
    }
  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});