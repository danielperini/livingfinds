import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function evaluationDays(action: string) {
  if (['negative_exact', 'negative_keyword', 'apply_dayparting'].includes(action)) return 14;
  if (action === 'create_keyword') return 3;
  return 7;
}

// Content-types corretos v3 (capitalização exata exigida pela Amazon)
const V3_CONTENT_TYPES: Record<string, string> = {
  '/sp/keywords':        'application/vnd.spKeyword.v3+json',
  '/sp/keywords/list':   'application/vnd.spKeyword.v3+json',
  '/sp/campaigns':       'application/vnd.spCampaign.v3+json',
  '/sp/campaigns/list':  'application/vnd.spCampaign.v3+json',
  '/sp/adGroups':        'application/vnd.spAdGroup.v3+json',
  '/sp/adGroups/list':   'application/vnd.spAdGroup.v3+json',
  '/sp/negativeKeywords':'application/vnd.spNegativeKeyword.v3+json',
};

// Gateway centralizado com retry (max 3 tentativas em 502/503)
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
    max_attempts: 3,
    _service_role: true,
  });
  return response?.data || response || {};
}

// Normaliza resposta v3 de qualquer entidade (keywords, campaigns, adGroups)
function normalizeV3Response(raw: any, entityKey: string): { ok: boolean; success: any[]; errors: any[]; request_id: string | null } {
  const request_id = raw?.headers?.request_id || raw?.amazon_request_id || raw?.request_id || null;

  const v3block = raw?.payload?.[entityKey] || raw?.[entityKey] || null;
  if (v3block) {
    const success: any[] = v3block.success || [];
    const errors: any[]  = v3block.error   || v3block.errors || [];
    return { ok: success.length > 0 && errors.length === 0, success, errors, request_id };
  }

  if (raw?.ok === false) return { ok: false, success: [], errors: raw?.errors || [{ message: raw?.error || 'Erro desconhecido' }], request_id };
  if (raw?.ok === true || raw?.status === 200) return { ok: true, success: [], errors: [], request_id };

  if (raw?.status === 207) {
    const hasError = Array.isArray(raw?.errors) && raw.errors.length > 0;
    return { ok: !hasError, success: [], errors: raw?.errors || [], request_id };
  }

  return { ok: false, success: [], errors: [{ message: 'Resposta Amazon não reconhecida' }], request_id };
}

function extractErrorMessage(errors: any[]): string {
  if (!errors || errors.length === 0) return '';
  const e = errors[0];
  return String(e?.message || e?.errorValue?.message || e?.description || JSON.stringify(e)).slice(0, 500);
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

      const now = new Date().toISOString();
      await base44.asServiceRole.entities.OptimizationDecision.update(decision.id, {
        status: 'executing',
        queue_status: 'processing',
        last_attempt_at: now,
        attempt_count: Number(decision.attempt_count || 0) + 1,
        updated_at: now,
      });

      let normalized: { ok: boolean; success: any[]; errors: any[]; request_id: string | null } = {
        ok: false, success: [], errors: [{ message: 'Ação não executada' }], request_id: null,
      };

      if (['reduce_bid', 'increase_bid', 'update_bid', 'set_bid'].includes(decision.action)) {
        const isAdGroup = decision.entity_type === 'ad_group';
        if (isAdGroup) {
          const raw = await ads(base44, decision.amazon_account_id, 'updateBid', 'PUT', '/sp/adGroups', {
            adGroups: [{ adGroupId: String(decision.entity_id), defaultBid: Number(decision.value_after) }],
          });
          normalized = normalizeV3Response(raw, 'adGroups');
        } else {
          const raw = await ads(base44, decision.amazon_account_id, 'updateBid', 'PUT', '/sp/keywords', {
            keywords: [{ keywordId: String(decision.entity_id || decision.keyword_id), bid: Number(decision.value_after) }],
          });
          normalized = normalizeV3Response(raw, 'keywords');
        }

      } else if (['update_budget', 'reduce_budget', 'increase_budget', 'set_budget'].includes(decision.action)) {
        const raw = await ads(base44, decision.amazon_account_id, 'updateCampaignBudget', 'PUT', '/sp/campaigns', {
          campaigns: [{
            campaignId: String(decision.campaign_id || decision.entity_id),
            budget: { budgetType: 'DAILY', budget: Number(decision.value_after) },
          }],
        });
        normalized = normalizeV3Response(raw, 'campaigns');

      } else if (['pause_campaign', 'enable_campaign'].includes(decision.action)) {
        const raw = await ads(base44, decision.amazon_account_id, decision.action, 'PUT', '/sp/campaigns', {
          campaigns: [{
            campaignId: String(decision.campaign_id || decision.entity_id),
            state: decision.action === 'pause_campaign' ? 'PAUSED' : 'ENABLED',
          }],
        });
        normalized = normalizeV3Response(raw, 'campaigns');

      } else if (['pause_keyword', 'enable_keyword'].includes(decision.action)) {
        const kwState = decision.action === 'pause_keyword' ? 'PAUSED' : 'ENABLED';
        const raw = await ads(base44, decision.amazon_account_id, decision.action, 'PUT', '/sp/keywords', {
          keywords: [{ keywordId: String(decision.entity_id || decision.keyword_id), state: kwState }],
        });
        normalized = normalizeV3Response(raw, 'keywords');

      } else if (['negative_exact', 'negative_keyword'].includes(decision.action)) {
        const raw = await ads(base44, decision.amazon_account_id, 'createNegativeKeyword', 'POST', '/sp/negativeKeywords', {
          negativeKeywords: [{
            campaignId: String(decision.campaign_id),
            keywordText: decision.keyword_text,
            matchType: 'NEGATIVE_EXACT',
            state: 'ENABLED',
          }],
        });
        normalized = normalizeV3Response(raw, 'negativeKeywords');

      } else if (decision.action === 'apply_dayparting') {
        const delegated = await base44.asServiceRole.functions.invoke('applyDaypartingSchedule', {
          opportunity_id: decision.id,
          mode: 'hybrid',
          approve: true,
          auto_apply: true,
          _service_role: true,
        });
        const d = delegated?.data || delegated || {};
        normalized = { ok: d.ok === true, success: [], errors: d.ok ? [] : [{ message: d.error || 'Falha dayparting' }], request_id: null };

      } else if (decision.action === 'create_keyword') {
        const delegated = await base44.asServiceRole.functions.invoke('harvestConvertedSearchTerms', {
          amazon_account_id: decision.amazon_account_id,
          single_decision_id: decision.id,
          keyword_text: decision.keyword_text,
          campaign_id: decision.campaign_id,
          ad_group_id: decision.ad_group_id,
          bid: decision.value_after,
          asin: decision.asin,
          _service_role: true,
        });
        const d = delegated?.data || delegated || {};
        normalized = { ok: d.ok === true, success: [], errors: d.ok ? [] : [{ message: d.error || 'Falha create_keyword' }], request_id: null };

      } else {
        normalized = { ok: false, success: [], errors: [{ message: `Ação não suportada: ${decision.action}` }], request_id: null };
      }

      const success = normalized.ok;
      const errorMessage = success ? null : extractErrorMessage(normalized.errors);

      await base44.asServiceRole.entities.OptimizationDecision.update(decision.id, {
        status: success ? 'executed' : 'failed',
        queue_status: success ? 'completed' : 'failed',
        queue_processed_at: now,
        executed_at: success ? now : null,
        amazon_response: JSON.stringify(normalized).slice(0, 4000),
        amazon_request_id: normalized.request_id,
        error_message: errorMessage,
        evaluation_due_at: success ? new Date(Date.now() + evaluationDays(decision.action) * 86400000).toISOString() : null,
        updated_at: now,
      });

      // Sincroniza Keyword local
      if (success && ['reduce_bid', 'increase_bid', 'update_bid', 'set_bid'].includes(decision.action)) {
        const keywordId = String(decision.entity_id || decision.keyword_id || '');
        if (keywordId) {
          const rows = await base44.asServiceRole.entities.Keyword.filter({
            amazon_account_id: decision.amazon_account_id,
            keyword_id: keywordId,
          }, null, 1).catch(() => []);
          if (rows[0]) {
            await base44.asServiceRole.entities.Keyword.update(rows[0].id, {
              current_bid: Number(decision.value_after),
              bid: Number(decision.value_after),
              synced_at: now,
            }).catch(() => {});
          }
        }
      }

      // Sincroniza Campaign local
      if (success && ['pause_campaign', 'enable_campaign', 'update_budget', 'reduce_budget', 'increase_budget', 'set_budget'].includes(decision.action)) {
        const campId = String(decision.campaign_id || decision.entity_id || '');
        if (campId) {
          const campRows = await base44.asServiceRole.entities.Campaign.filter({
            amazon_account_id: decision.amazon_account_id,
            $or: [{ campaign_id: campId }, { amazon_campaign_id: campId }],
          }, null, 1).catch(() => []);
          if (campRows[0]) {
            const campUpdate: any = { updated_at: now };
            if (['pause_campaign', 'enable_campaign'].includes(decision.action)) {
              const newState = decision.action === 'pause_campaign' ? 'paused' : 'enabled';
              campUpdate.state = newState;
              campUpdate.status = newState;
            }
            if (['update_budget', 'reduce_budget', 'increase_budget', 'set_budget'].includes(decision.action)) {
              campUpdate.daily_budget = Number(decision.value_after);
              campUpdate.budget = Number(decision.value_after);
            }
            await base44.asServiceRole.entities.Campaign.update(campRows[0].id, campUpdate).catch(() => {});
          }
        }
      }

      // Grava BidHistory
      if (success && ['reduce_bid', 'increase_bid', 'update_bid', 'set_bid', 'update_budget', 'reduce_budget', 'increase_budget', 'set_budget'].includes(decision.action)) {
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
          amazon_request_id: normalized.request_id,
          executed_at: now,
          created_at: now,
        }).catch(() => {});
      }

      // Atualiza RuleExecution
      if (decision.idempotency_key) {
        const rules = await base44.asServiceRole.entities.RuleExecution.filter({
          amazon_account_id: decision.amazon_account_id,
          idempotency_key: decision.idempotency_key,
        }, null, 10).catch(() => []);
        for (const rule of rules) {
          await base44.asServiceRole.entities.RuleExecution.update(rule.id, {
            status: success ? 'completed' : 'failed',
            executed_at: success ? now : null,
            amazon_response: JSON.stringify(normalized).slice(0, 4000),
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
        request_id: normalized.request_id,
        error: errorMessage,
      });
    }

    return Response.json({
      ok: results.every((item) => item.ok || item.skipped),
      executed: results.filter((item) => item.status === 'executed').length,
      failed: results.filter((item) => item.status === 'failed').length,
      results,
    });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || 'Erro ao executar decisões' }, { status: 500 });
  }
});