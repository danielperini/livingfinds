import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function brazilHour() {
  const parts = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
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

// Mapa de content-type por rota v3
const V3_CONTENT_TYPES: Record<string, string> = {
  '/sp/keywords': 'application/vnd.spkeyword.v3+json',
  '/sp/keywords/list': 'application/vnd.spkeyword.v3+json',
  '/sp/campaigns': 'application/vnd.spcampaign.v3+json',
  '/sp/campaigns/list': 'application/vnd.spcampaign.v3+json',
  '/sp/adGroups': 'application/vnd.spadgroup.v3+json',
  '/sp/adGroups/list': 'application/vnd.spadgroup.v3+json',
  '/sp/negativeKeywords': 'application/vnd.spnegativekeyword.v3+json',
};

async function ads(base44: any, accountId: string, operation: string, method: string, path: string, payload: any) {
  const ct = V3_CONTENT_TYPES[path] || 'application/json';
  const response = await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
    amazon_account_id: accountId,
    operation,
    method,
    path,
    payload,
    content_type: ct,
    accept: ct,
    _service_role: true,
  });
  return response?.data || response || {};
}

function amazonSucceeded(response: any) {
  if (!response) return false;
  if (response.ok === false) return false;
  if (Array.isArray(response.errors) && response.errors.length > 0) return false;
  if (Array.isArray(response.results) && response.results.some((item: any) => item?.ok === false || item?.error || item?.errors?.length)) return false;
  if (Array.isArray(response.success) && response.success.length > 0) return true;
  return response.ok === true || response.status === 200 || response.status === 207;
}

function amazonError(response: any) {
  return String(
    response?.errors?.[0]?.message ||
    response?.errors?.[0]?.errorValue?.message ||
    response?.results?.find((item: any) => item?.error)?.error ||
    response?.error ||
    'Falha Amazon sem detalhe',
  ).slice(0, 500);
}

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    const body = await request.json().catch(() => ({}));
    if (!authenticated && !body._service_role) {
      return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    const ids = body.decision_ids || (body.decision_id ? [body.decision_id] : []);
    if (!ids.length) return Response.json({ ok: false, error: 'decision_id obrigatório' }, { status: 400 });

    const results: any[] = [];
    for (const id of ids) {
      const decisions = await base44.asServiceRole.entities.OptimizationDecision.filter({ id }, null, 1);
      const decision = decisions[0];
      if (!decision) {
        results.push({ id, ok: false, error: 'Decisão não encontrada' });
        continue;
      }
      if (!['approved', 'executing'].includes(decision.status)) {
        results.push({ id, ok: false, skipped: true, reason: `status ${decision.status}` });
        continue;
      }

      const immediate = ['pause_campaign', 'pause_keyword'].includes(decision.action);
      if (!immediate && !body._window_execution && !isWindow()) {
        const queueHour = nextQueueHour();
        await base44.asServiceRole.entities.OptimizationDecision.update(decision.id, {
          status: 'approved',
          queue_status: 'scheduled',
          queue_hour: queueHour,
          queue_window: queueHour === 13
            ? '13:00-14:00'
            : `${String(queueHour).padStart(2, '0')}:00-${String(queueHour + 1).padStart(2, '0')}:00`,
          queued_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
        results.push({ id, ok: true, scheduled: true, queue_hour: queueHour });
        continue;
      }

      const now = new Date().toISOString();
      await base44.asServiceRole.entities.OptimizationDecision.update(decision.id, {
        status: 'executing',
        queue_status: 'processing',
        last_attempt_at: now,
        attempt_count: Number(decision.attempt_count || 0) + 1,
        updated_at: now,
      });

      let response: any;
      if (['reduce_bid', 'increase_bid', 'update_bid', 'set_bid'].includes(decision.action)) {
        const isAdGroup = decision.entity_type === 'ad_group';
        if (isAdGroup) {
          // Ad groups: API v3
          response = await ads(base44, decision.amazon_account_id, 'updateBid', 'PUT', '/sp/adGroups', {
            adGroups: [{ adGroupId: String(decision.entity_id), defaultBid: Number(decision.value_after) }],
          });
        } else {
          // Keywords: API v3
          response = await ads(base44, decision.amazon_account_id, 'updateBid', 'PUT', '/sp/keywords', {
            keywords: [{ keywordId: String(decision.entity_id || decision.keyword_id), bid: Number(decision.value_after) }],
          });
          // Normalizar resposta v3 (payload.keywords.success)
          const v3payload = response?.payload?.keywords;
          if (v3payload) {
            const hasSuccess = v3payload.success?.length > 0;
            const hasError = v3payload.error?.length > 0;
            response = { ...response, ok: hasSuccess && !hasError, success: v3payload.success, errors: v3payload.error || [] };
          }
        }
      } else if (['update_budget', 'reduce_budget', 'increase_budget', 'set_budget'].includes(decision.action)) {
        // Budgets: API v3
        response = await ads(base44, decision.amazon_account_id, 'updateCampaignBudget', 'PUT', '/sp/campaigns', {
          campaigns: [{
            campaignId: String(decision.campaign_id || decision.entity_id),
            budget: { budgetType: 'DAILY', budget: Number(decision.value_after) },
          }],
        });
      } else if (decision.action === 'pause_campaign' || decision.action === 'enable_campaign') {
        // Campanhas: API v3
        response = await ads(base44, decision.amazon_account_id, decision.action, 'PUT', '/sp/campaigns', {
          campaigns: [{
            campaignId: String(decision.campaign_id || decision.entity_id),
            state: decision.action === 'pause_campaign' ? 'PAUSED' : 'ENABLED',
          }],
        });
      } else if (decision.action === 'pause_keyword' || decision.action === 'enable_keyword') {
        // Pausar/ativar keyword: API v3
        const kwState = decision.action === 'pause_keyword' ? 'PAUSED' : 'ENABLED';
        response = await ads(base44, decision.amazon_account_id, decision.action, 'PUT', '/sp/keywords', {
          keywords: [{ keywordId: String(decision.entity_id || decision.keyword_id), state: kwState }],
        });
        // Normalizar resposta v3 — pode vir em payload.keywords ou keywords
        const v3kw = response?.payload?.keywords || response?.keywords;
        if (v3kw) {
          const hasSuccess = (v3kw.success?.length || 0) > 0;
          response = { ...response, ok: hasSuccess, success: v3kw.success, errors: v3kw.error || [] };
        }
      } else if (['negative_exact', 'negative_keyword'].includes(decision.action)) {
        response = await ads(base44, decision.amazon_account_id, 'createNegativeKeyword', 'POST', '/v2/sp/negativeKeywords', [{
          campaignId: String(decision.campaign_id),
          keywordText: decision.keyword_text,
          matchType: 'negativeExact',
          state: 'enabled',
        }]);
      } else if (decision.action === 'apply_dayparting') {
        const delegated = await base44.asServiceRole.functions.invoke('applyDaypartingSchedule', {
          opportunity_id: decision.id,
          mode: 'hybrid',
          approve: true,
          auto_apply: true,
          _window_execution: true,
          _service_role: true,
        });
        response = delegated?.data || delegated || {};
      } else if (decision.action === 'create_keyword') {
        const delegated = await base44.asServiceRole.functions.invoke('harvestConvertedSearchTerms', {
          amazon_account_id: decision.amazon_account_id,
          single_decision_id: decision.id,
          keyword_text: decision.keyword_text,
          campaign_id: decision.campaign_id,
          ad_group_id: decision.ad_group_id,
          bid: decision.value_after,
          asin: decision.asin,
          _window_execution: true,
          _service_role: true,
        });
        response = delegated?.data || delegated || {};
      } else {
        response = { ok: false, error: `Ação não suportada: ${decision.action}` };
      }

      const success = amazonSucceeded(response);
      const errorMessage = success ? null : amazonError(response);
      await base44.asServiceRole.entities.OptimizationDecision.update(decision.id, {
        status: success ? 'executed' : 'failed',
        queue_status: success ? 'completed' : 'failed',
        queue_processed_at: now,
        executed_at: success ? now : null,
        amazon_response: JSON.stringify(response).slice(0, 4000),
        amazon_request_id: response?.request_id || response?.amazon_request_id || null,
        error_message: errorMessage,
        evaluation_due_at: success ? new Date(Date.now() + evaluationDays(decision.action) * 86400000).toISOString() : null,
        updated_at: now,
      });

      if (success && ['reduce_bid', 'increase_bid', 'update_bid', 'set_bid'].includes(decision.action)) {
        const keywordRows = await base44.asServiceRole.entities.Keyword.filter({
          amazon_account_id: decision.amazon_account_id,
          keyword_id: String(decision.entity_id || decision.keyword_id),
        }, null, 1).catch(() => []);
        if (keywordRows[0]) {
          await base44.asServiceRole.entities.Keyword.update(keywordRows[0].id, {
            current_bid: Number(decision.value_after),
            bid: Number(decision.value_after),
            synced_at: now,
          }).catch(() => {});
        }
      }

      if (success && ['reduce_bid', 'increase_bid', 'update_bid', 'set_bid', 'update_budget', 'reduce_budget', 'increase_budget'].includes(decision.action)) {
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
          amazon_request_id: response?.request_id || response?.amazon_request_id || null,
          executed_at: now,
          created_at: now,
        }).catch(() => {});
      }

      if (decision.idempotency_key) {
        const rules = await base44.asServiceRole.entities.RuleExecution.filter({
          amazon_account_id: decision.amazon_account_id,
          idempotency_key: decision.idempotency_key,
        }, null, 10).catch(() => []);
        for (const rule of rules) {
          await base44.asServiceRole.entities.RuleExecution.update(rule.id, {
            status: success ? 'completed' : 'failed',
            executed_at: success ? now : null,
            amazon_response: JSON.stringify(response).slice(0, 4000),
            error_message: errorMessage,
          }).catch(() => {});
        }
      }

      results.push({
        id,
        ok: success,
        action: decision.action,
        status: success ? 'executed' : 'failed',
        value_before: decision.value_before,
        value_after: decision.value_after,
        request_id: response?.request_id || response?.amazon_request_id || null,
        error: errorMessage,
      });
    }

    return Response.json({
      ok: results.every((item) => item.ok || item.skipped),
      executed: results.filter((item) => item.status === 'executed').length,
      scheduled: results.filter((item) => item.scheduled).length,
      failed: results.filter((item) => item.status === 'failed').length,
      results,
    });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || 'Erro ao executar decisões' }, { status: 500 });
  }
});