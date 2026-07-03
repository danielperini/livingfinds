import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function brazilHour() {
  const parts = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false }).formatToParts(new Date());
  return Number(parts.find((part) => part.type === 'hour')?.value || 0);
}

function nextQueueHour() {
  const hour = brazilHour();
  if (hour < 4) return Math.min(3, hour + 1);
  if (hour < 13) return 13;
  return 0;
}

function isWindow() {
  return [0, 1, 2, 3, 13].includes(brazilHour());
}

function evaluationDays(action: string) {
  if (['negative_exact', 'negative_keyword', 'apply_dayparting'].includes(action)) return 14;
  if (action === 'create_keyword') return 3;
  return 7;
}

async function ads(base44: any, accountId: string, operation: string, method: string, path: string, payload: any) {
  const response = await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
    amazon_account_id: accountId,
    operation,
    method,
    path,
    payload,
    _service_role: true,
  });
  return response?.data || response || {};
}

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    const body = await request.json().catch(() => ({}));
    if (!authenticated && !body._service_role) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });

    const ids = body.decision_ids || (body.decision_id ? [body.decision_id] : []);
    if (!ids.length) return Response.json({ ok: false, error: 'decision_id obrigatório' }, { status: 400 });

    const results = [];
    for (const id of ids) {
      const decisions = await base44.asServiceRole.entities.OptimizationDecision.filter({ id }, null, 1);
      const decision = decisions[0];
      if (!decision) { results.push({ id, ok: false, error: 'Decisão não encontrada' }); continue; }
      if (!['approved', 'executing'].includes(decision.status)) { results.push({ id, ok: false, skipped: true, reason: `status ${decision.status}` }); continue; }

      const pause = ['pause_campaign', 'pause_keyword'].includes(decision.action);
      if (!pause && !body._window_execution && !isWindow()) {
        const queueHour = nextQueueHour();
        await base44.asServiceRole.entities.OptimizationDecision.update(decision.id, {
          status: 'approved',
          queue_status: 'scheduled',
          queue_hour: queueHour,
          queue_window: queueHour === 13 ? '13:00-14:00' : `${String(queueHour).padStart(2, '0')}:00-${String(queueHour + 1).padStart(2, '0')}:00`,
          queued_at: new Date().toISOString(),
        });
        results.push({ id, ok: true, scheduled: true, queue_hour: queueHour, message: 'Decisão programada para a próxima janela Amazon, com intervalo de 14 segundos.' });
        continue;
      }

      const now = new Date().toISOString();
      await base44.asServiceRole.entities.OptimizationDecision.update(decision.id, { status: 'executing', last_attempt_at: now, attempt_count: Number(decision.attempt_count || 0) + 1 });

      let response: any;
      if (['reduce_bid', 'increase_bid', 'update_bid'].includes(decision.action)) {
        const path = decision.entity_type === 'ad_group' ? '/v2/sp/adGroups' : '/v2/sp/keywords';
        const payload = decision.entity_type === 'ad_group'
          ? [{ adGroupId: String(decision.entity_id), defaultBid: Number(decision.value_after) }]
          : [{ keywordId: String(decision.entity_id || decision.keyword_id), bid: Number(decision.value_after) }];
        response = await ads(base44, decision.amazon_account_id, 'updateBid', 'PUT', path, payload);
      } else if (['update_budget', 'reduce_budget', 'increase_budget'].includes(decision.action)) {
        response = await ads(base44, decision.amazon_account_id, 'updateCampaignBudget', 'PUT', '/v2/sp/campaigns', [{ campaignId: String(decision.campaign_id || decision.entity_id), dailyBudget: Number(decision.value_after) }]);
      } else if (decision.action === 'pause_campaign' || decision.action === 'enable_campaign') {
        response = await ads(base44, decision.amazon_account_id, decision.action, 'PUT', '/v2/sp/campaigns', [{ campaignId: String(decision.campaign_id || decision.entity_id), state: decision.action === 'pause_campaign' ? 'paused' : 'enabled' }]);
      } else if (decision.action === 'pause_keyword') {
        response = await ads(base44, decision.amazon_account_id, 'pauseKeyword', 'PUT', '/v2/sp/keywords', [{ keywordId: String(decision.entity_id || decision.keyword_id), state: 'paused' }]);
      } else if (['negative_exact', 'negative_keyword'].includes(decision.action)) {
        response = await ads(base44, decision.amazon_account_id, 'createNegativeKeyword', 'POST', '/v2/sp/negativeKeywords', [{ campaignId: String(decision.campaign_id), keywordText: decision.keyword_text, matchType: 'negativeExact', state: 'enabled' }]);
      } else if (decision.action === 'apply_dayparting') {
        const delegated = await base44.asServiceRole.functions.invoke('applyDaypartingSchedule', { opportunity_id: decision.id, mode: 'hybrid', approve: true, auto_apply: true, _window_execution: true, _service_role: true });
        response = delegated?.data || delegated || {};
      } else if (decision.action === 'create_keyword') {
        const delegated = await base44.asServiceRole.functions.invoke('harvestConvertedSearchTerms', { amazon_account_id: decision.amazon_account_id, single_decision_id: decision.id, keyword_text: decision.keyword_text, campaign_id: decision.campaign_id, ad_group_id: decision.ad_group_id, bid: decision.value_after, asin: decision.asin, _window_execution: true, _service_role: true });
        response = delegated?.data || delegated || {};
      } else {
        response = { ok: false, error: `Ação não suportada: ${decision.action}` };
      }

      const success = response?.ok === true || response?.status === 200 || response?.status === 207;
      await base44.asServiceRole.entities.OptimizationDecision.update(decision.id, {
        status: success ? 'executed' : 'failed',
        queue_status: success ? 'completed' : 'failed',
        executed_at: success ? now : null,
        amazon_response: JSON.stringify(response).slice(0, 4000),
        error_message: success ? null : String(response?.errors?.[0]?.message || response?.error || 'Falha Amazon').slice(0, 500),
        evaluation_due_at: success ? new Date(Date.now() + evaluationDays(decision.action) * 86400000).toISOString() : null,
      });

      if (success && ['reduce_bid', 'increase_bid', 'update_bid', 'update_budget', 'reduce_budget', 'increase_budget'].includes(decision.action)) {
        await base44.asServiceRole.entities.BidHistory.create({
          amazon_account_id: decision.amazon_account_id,
          entity_type: decision.entity_type,
          entity_id: decision.entity_id || decision.keyword_id,
          entity_name: decision.keyword_text || decision.campaign_id,
          campaign_id: decision.campaign_id || null,
          bid_before: decision.action.includes('bid') ? decision.value_before : null,
          bid_after: decision.action.includes('bid') ? decision.value_after : null,
          budget_before: decision.action.includes('budget') ? decision.value_before : null,
          budget_after: decision.action.includes('budget') ? decision.value_after : null,
          change_pct: decision.change_pct,
          reason: decision.rationale?.slice(0, 500),
          applied_by: 'autopilot_v2',
          decision_id: decision.id,
          amazon_request_id: response?.request_id || null,
          executed_at: now,
          created_at: now,
        }).catch(() => {});
      }

      results.push({ id, ok: success, action: decision.action, status: success ? 'executed' : 'failed', request_id: response?.request_id || null, error: success ? null : response?.errors?.[0]?.message || response?.error || null });
    }

    return Response.json({ ok: results.every((item) => item.ok), executed: results.filter((item) => item.status === 'executed').length, scheduled: results.filter((item) => item.scheduled).length, results });
  } catch (error) {
    return Response.json({ ok: false, error: error?.message || 'Erro ao executar decisões' }, { status: 500 });
  }
});
