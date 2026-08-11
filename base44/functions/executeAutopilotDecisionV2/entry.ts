import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { clampBidToConfiguredPolicy, loadConfiguredBidPolicy } from '../../shared/configuredBidPolicy.ts';

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
  '/sp/targets':         'application/vnd.spTargetingClause.v3+json',
  '/sp/targets/list':    'application/vnd.spTargetingClause.v3+json',
  '/sp/negativeKeywords':'application/vnd.spNegativeKeyword.v3+json',
};

// Gateway centralizado com retry (max 3 tentativas em 502/503)
async function ads(base44: any, accountId: string, operation: string, method: string, path: string, payload: any) {
  const ct = V3_CONTENT_TYPES[path] || 'application/json';
  try {
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
  } catch (error: any) {
    const remote = error?.response?.data || {};
    return {
      ...remote,
      ok: false,
      status: error?.response?.status || remote?.status || 500,
      headers: error?.response?.headers || remote?.headers || {},
      errors: remote?.errors || [{ message: remote?.error || error?.message || 'Falha Amazon Ads' }],
    };
  }
}

// Normaliza resposta v3 de qualquer entidade (keywords, campaigns, adGroups)
type NormalizedResponse = {
  ok: boolean;
  success: any[];
  errors: any[];
  request_id: string | null;
  status_code?: number | null;
  retry_after_seconds?: number | null;
};

function normalizeV3Response(raw: any, entityKey: string): NormalizedResponse {
  const request_id = raw?.headers?.request_id || raw?.amazon_request_id || raw?.request_id || null;
  const status_code = Number(raw?.status || raw?.status_code || raw?.http_status || 0) || null;
  const retryAfterRaw = raw?.headers?.['retry-after'] || raw?.headers?.retry_after || raw?.retry_after;
  const retry_after_seconds = Number(retryAfterRaw) > 0 ? Number(retryAfterRaw) : null;

  const v3block = raw?.payload?.[entityKey] || raw?.[entityKey] || null;
  if (v3block) {
    const success: any[] = v3block.success || [];
    const errors: any[]  = v3block.error   || v3block.errors || [];
    return { ok: success.length > 0 && errors.length === 0, success, errors, request_id, status_code, retry_after_seconds };
  }

  if (raw?.ok === false) return { ok: false, success: [], errors: raw?.errors || [{ message: raw?.error || 'Erro desconhecido' }], request_id, status_code, retry_after_seconds };
  if (raw?.ok === true || raw?.status === 200) return { ok: true, success: [], errors: [], request_id, status_code, retry_after_seconds };

  if (raw?.status === 207) {
    const hasError = Array.isArray(raw?.errors) && raw.errors.length > 0;
    return { ok: !hasError, success: [], errors: raw?.errors || [], request_id, status_code, retry_after_seconds };
  }

  return { ok: false, success: [], errors: [{ message: 'Resposta Amazon não reconhecida' }], request_id, status_code, retry_after_seconds };
}

function extractErrorMessage(errors: any[]): string {
  if (!errors || errors.length === 0) return '';
  const e = errors[0];
  return String(e?.message || e?.errorValue?.message || e?.description || JSON.stringify(e)).slice(0, 500);
}

function isSaleAbsenceOnlyCampaignPause(decision: any): boolean {
  if (decision.action !== 'pause_campaign') return false;
  const evidence = [decision.rule_key, decision.rationale, decision.reason]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  const mentionsSaleAbsence = /zero[\s._-]*(sales?|vendas?|conversions?|convers[oõ]es)|sem vendas?|no[\s._-]*conversion|aus[eê]ncia de venda/.test(evidence);
  const hasIndependentBlockingCause = decision.extreme_loss === true
    || decision.metadata?.extreme_loss === true
    || decision.metrics_before?.extreme_loss === true
    || /out[\s._-]*of[\s._-]*stock|sem estoque|structural|estrutural|duplicate|duplicad|dedup|invalid|inv[aá]lid|compliance|policy|negative[\s._-]*margin|margem negativa/.test(evidence);
  return mentionsSaleAbsence && !hasIndependentBlockingCause;
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

      if (['reduce_bid', 'increase_bid', 'update_bid', 'set_bid'].includes(decision.action)) {
        const requestedTargetBid = Number(decision.value_after ?? decision.proposed_value);
        if (Number.isFinite(requestedTargetBid) && requestedTargetBid > 0) {
          const bidPolicy = await loadConfiguredBidPolicy(base44, decision.amazon_account_id);
          const targetBid = Number(clampBidToConfiguredPolicy(requestedTargetBid, bidPolicy));
          if (targetBid !== requestedTargetBid) {
            await base44.asServiceRole.entities.OptimizationDecision.update(decision.id, {
              value_after: targetBid,
              proposed_value: targetBid,
              settings_source: bidPolicy.source,
              settings_snapshot: JSON.stringify({
                configured_bid_ceiling: bidPolicy.ceiling,
                configured_max_bid: bidPolicy.maxBid,
                configured_max_cpc: bidPolicy.maxCpc,
              }),
              updated_at: new Date().toISOString(),
            });
            decision.value_after = targetBid;
            decision.proposed_value = targetBid;
          }
        }
      }

      if (isSaleAbsenceOnlyCampaignPause(decision)) {
        const blockedAt = new Date().toISOString();
        await base44.asServiceRole.entities.OptimizationDecision.update(decision.id, {
          status: 'superseded',
          queue_status: 'completed',
          error_message: 'Pausa bloqueada: ausência de venda isolada exige redução gradual e nova avaliação.',
          updated_at: blockedAt,
        });
        results.push({
          id,
          ok: true,
          skipped: true,
          reason: 'campaign_pause_blocked_sale_absence_only',
        });
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

      let normalized: NormalizedResponse = {
        ok: false, success: [], errors: [{ message: 'Ação não executada' }], request_id: null,
      };

      if (['reduce_bid', 'increase_bid', 'update_bid', 'set_bid'].includes(decision.action)) {
        const isAdGroup = decision.entity_type === 'ad_group';
        const isProductTarget = decision.entity_type === 'product_target';
        if (isProductTarget) {
          const raw = await ads(base44, decision.amazon_account_id, 'updateTargetBid', 'PUT', '/sp/targets', {
            targetingClauses: [{ targetId: String(decision.entity_id || decision.target_id), bid: Number(decision.value_after) }],
          });
          normalized = normalizeV3Response(raw, 'targetingClauses');
        } else if (isAdGroup) {
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
      const statusCode = Number(normalized.status_code || 0);
      const ambiguous = !success && ([409, 504, 524].includes(statusCode) || (statusCode === 207 && normalized.success.length > 0));
      const retryable = !success && [429, 500, 502, 503].includes(statusCode);
      const attempts = Number(decision.attempt_count || 0) + 1;
      const retrySeconds = normalized.retry_after_seconds || Math.min(3600, 60 * (2 ** Math.max(0, attempts - 1)));
      const failureStatus = statusCode === 409 ? 'conflict_reconciling' : ambiguous ? 'confirming' : retryable ? 'waiting_retry' : 'failed';
      const failureQueueStatus = ambiguous ? 'scheduled' : retryable ? 'scheduled' : 'failed';

      await base44.asServiceRole.entities.OptimizationDecision.update(decision.id, {
        status: success ? 'executed' : failureStatus,
        queue_status: success ? 'completed' : failureQueueStatus,
        queue_processed_at: now,
        executed_at: success ? now : null,
        amazon_response: JSON.stringify(normalized).slice(0, 4000),
        amazon_request_id: normalized.request_id,
        error_message: errorMessage,
        next_retry_at: success ? null : (ambiguous || retryable ? new Date(Date.now() + retrySeconds * 1000).toISOString() : null),
        confirmation_status: ambiguous ? 'pending' : decision.confirmation_status,
        evaluation_due_at: success ? new Date(Date.now() + evaluationDays(decision.action) * 86400000).toISOString() : null,
        updated_at: now,
      });

      // Sincroniza a entidade de bid local somente depois do aceite Amazon.
      if (success && ['reduce_bid', 'increase_bid', 'update_bid', 'set_bid'].includes(decision.action)) {
        const bidEntityId = String(decision.entity_id || decision.keyword_id || decision.target_id || '');
        if (decision.entity_type === 'product_target' && bidEntityId) {
          const rows = await base44.asServiceRole.entities.ProductTarget.filter({
            amazon_account_id: decision.amazon_account_id,
            target_id: bidEntityId,
          }, null, 1).catch(() => []);
          if (rows[0]) {
            await base44.asServiceRole.entities.ProductTarget.update(rows[0].id, {
              bid: Number(decision.value_after),
              synced_at: now,
            }).catch(() => {});
          }
        } else if (decision.entity_type === 'ad_group' && bidEntityId) {
          const rows = await base44.asServiceRole.entities.AdGroup.filter({
            amazon_account_id: decision.amazon_account_id,
            ad_group_id: bidEntityId,
          }, null, 1).catch(() => []);
          if (rows[0]) {
            await base44.asServiceRole.entities.AdGroup.update(rows[0].id, {
              default_bid: Number(decision.value_after),
              synced_at: now,
            }).catch(() => {});
          }
        } else if (bidEntityId) {
          const rows = await base44.asServiceRole.entities.Keyword.filter({
            amazon_account_id: decision.amazon_account_id,
            keyword_id: bidEntityId,
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

        let evidence: any = {};
        try { evidence = JSON.parse(String(decision.data_used || '{}')); } catch { evidence = {}; }
        await base44.asServiceRole.entities.AdsBidChangeLog.create({
          amazon_account_id: decision.amazon_account_id,
          date: now.slice(0, 10),
          execution_run_id: decision.run_id || null,
          campaign_id: decision.campaign_id || null,
          campaign_name: decision.campaign_name || null,
          ad_group_id: decision.ad_group_id || null,
          entity_type: decision.entity_type,
          entity_id: decision.entity_id || decision.keyword_id || decision.target_id,
          keyword_id: decision.entity_type === 'keyword' ? decision.entity_id : null,
          keyword_text: decision.keyword_text || decision.entity_name || null,
          target_id: decision.entity_type === 'product_target' ? decision.entity_id : null,
          asin: decision.asin || null,
          old_bid: decision.action.includes('bid') ? Number(decision.value_before) : null,
          new_bid: decision.action.includes('bid') ? Number(decision.value_after) : null,
          bid_before: decision.action.includes('bid') ? Number(decision.value_before) : null,
          bid_after: decision.action.includes('bid') ? Number(decision.value_after) : null,
          change_amount: Number(decision.value_after || 0) - Number(decision.value_before || 0),
          change_percent: Number(decision.change_pct || 0),
          change_pct: Number(decision.change_pct || 0),
          direction: Number(decision.value_after || 0) > Number(decision.value_before || 0) ? 'increase' : 'decrease',
          action: decision.action,
          reason: decision.rationale,
          evidence: decision.data_used,
          classification: decision.campaign_classification || decision.economic_state || evidence.classification || null,
          account_daily_spend: evidence.account_daily_spend ?? null,
          remaining_account_budget: evidence.remaining_account_budget ?? null,
          campaign_virtual_budget: evidence.campaign_virtual_budget ?? null,
          campaign_spend_share: evidence.campaign_spend_share ?? null,
          campaign_target_share: evidence.campaign_target_share ?? null,
          spend_share_deviation: evidence.spend_share_deviation ?? null,
          impressions: evidence.impressions ?? null,
          clicks: evidence.clicks ?? null,
          orders: evidence.orders ?? null,
          sales: evidence.sales ?? null,
          spend: evidence.daily_spend ?? null,
          cpc: evidence.cpc ?? null,
          acos: evidence.acos ?? null,
          profit_after_ads: evidence.profit_after_ads ?? null,
          margin_percent: evidence.margin_percent ?? null,
          maximum_economic_cpc: evidence.maximum_economic_cpc ?? null,
          max_spend_without_sale: evidence.max_spend_without_sale ?? null,
          stock_qty: evidence.stock_qty ?? null,
          stock_coverage_days: evidence.stock_coverage_days ?? null,
          next_evaluation_at: evidence.next_evaluation_at || decision.evaluation_due_at || null,
          source: decision.source_function || 'executeAutopilotDecisionV2',
          ai_confidence: Number(decision.confidence || 0) <= 1 ? Number(decision.confidence || 0) * 100 : Number(decision.confidence || 0),
          risk_level: decision.risk || 'low',
          status: 'executed',
          amazon_response: JSON.stringify(normalized).slice(0, 4000),
          decision_id: decision.id,
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
            status: success ? 'completed' : (ambiguous || retryable ? 'pending' : 'failed'),
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
        status: success ? 'executed' : failureStatus,
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
      scheduled: results.filter((item) => ['waiting_retry', 'confirming'].includes(item.status)).length,
      results,
    });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || 'Erro ao executar decisões' }, { status: 500 });
  }
});
