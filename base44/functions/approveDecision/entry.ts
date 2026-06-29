/**
 * approveDecision — Aprova, rejeita ou aplica regras automáticas em decisões do Learner Engine.
 * Quando aprovada com action='approve' e execute=true, também tenta aplicar via Amazon Ads API.
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

async function applyToAmazon(decision) {
  const token = await getAdsToken();
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID'),
    'Amazon-Advertising-API-Scope': String(Deno.env.get('ADS_PROFILE_ID')),
    'Content-Type': 'application/json',
  };

  const base = getAdsBaseUrl();
  let endpoint, payload;

  switch (decision.decision_type) {
    case 'bid_adjust':
      endpoint = `${base}/v2/sp/keywords`;
      payload = [{ keywordId: decision.entity_id, bid: decision.proposed_value }];
      break;
    case 'budget_change':
      endpoint = `${base}/v2/sp/campaigns`;
      payload = [{ campaignId: decision.entity_id, dailyBudget: decision.proposed_value }];
      break;
    case 'pause_campaign':
      endpoint = `${base}/v2/sp/campaigns`;
      payload = [{ campaignId: decision.entity_id, state: 'paused' }];
      break;
    case 'enable_campaign':
      endpoint = `${base}/v2/sp/campaigns`;
      payload = [{ campaignId: decision.entity_id, state: 'enabled' }];
      break;
    case 'negate_keyword':
      endpoint = `${base}/v2/sp/negativeKeywords`;
      payload = [{ campaignId: decision.entity_id, keywordText: decision.entity_name?.split(' (')[0], matchType: 'negativeExact', state: 'enabled' }];
      break;
    default:
      return { ok: false, skipped: true, reason: `action ${decision.decision_type} not mapped` };
  }

  const res = await fetch(endpoint, { method: 'PUT', headers, body: JSON.stringify(payload) });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

function matchesRule(rule, decision) {
  if (!rule.is_active || rule.action !== 'auto_approve') return false;
  if (rule.confidence_threshold != null && (decision.confidence ?? 0) < rule.confidence_threshold) return false;
  const acos = decision.current_value ?? null;
  if (rule.acos_min != null && acos != null && acos < rule.acos_min) return false;
  if (rule.acos_max != null && acos != null && acos > rule.acos_max) return false;
  if (rule.scope === 'specific_campaign' && rule.campaign_id_filter && decision.entity_id !== rule.campaign_id_filter) return false;
  return true;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { decision_id, action, apply_rules, amazon_account_id, proposed_value } = body;

    // ── Modo: aplicar regras automáticas a decisões pendentes ──
    if (apply_rules && amazon_account_id) {
      const [pendingDecisions, rules] = await Promise.all([
        base44.asServiceRole.entities.Decision.filter({ amazon_account_id, status: 'pending' }, '-created_date', 500),
        base44.asServiceRole.entities.BiddingRule.filter({ amazon_account_id, is_active: true }, '-created_date', 50),
      ]);

      let autoApproved = 0;
      const now = new Date().toISOString();

      for (const decision of pendingDecisions) {
        for (const rule of rules) {
          if (matchesRule(rule, decision)) {
            await base44.asServiceRole.entities.Decision.update(decision.id, {
              status: 'approved',
              reviewed_by: `auto:rule:${rule.id}`,
              reviewed_at: now,
            });
            await base44.asServiceRole.entities.BiddingRule.update(rule.id, {
              last_applied_at: now,
              applied_count: (rule.applied_count || 0) + 1,
            });
            await base44.asServiceRole.entities.LearningEvent.create({
              amazon_account_id,
              event_type: 'auto_rule_applied',
              entity_type: decision.entity_type,
              entity_id: decision.entity_id,
              observation: `Regra "${rule.name}" aprovou automaticamente (ACoS: ${rule.acos_min ?? '?'}–${rule.acos_max ?? '?'}%, confiança mín: ${(rule.confidence_threshold * 100).toFixed(0)}%)`,
              decision_id: decision.id,
              recorded_at: now,
            });
            autoApproved++;
            break;
          }
        }
      }
      return Response.json({ ok: true, auto_approved: autoApproved, total_checked: pendingDecisions.length });
    }

    // ── Modo: aprovação/rejeição manual ──
    if (!decision_id) return Response.json({ error: 'decision_id required' }, { status: 400 });

    const decision = await base44.asServiceRole.entities.Decision.get(decision_id);
    if (!decision) return Response.json({ error: 'Decision not found' }, { status: 404 });
    if (decision.status !== 'pending') return Response.json({ error: `Already ${decision.status}` }, { status: 409 });

    const isApprove = action !== 'reject';
    const newStatus = isApprove ? 'approved' : 'rejected';
    const now = new Date().toISOString();

    // Se foi passado um proposed_value editado pelo usuário, usar ele
    const finalProposedValue = proposed_value ?? decision.proposed_value;

    await base44.asServiceRole.entities.Decision.update(decision_id, {
      status: newStatus,
      proposed_value: finalProposedValue,
      reviewed_by: user.id,
      reviewed_at: now,
    });

    // Se aprovado, tentar executar via Amazon Ads API
    let executionResult = null;
    if (isApprove) {
      try {
        const decisionToApply = { ...decision, proposed_value: finalProposedValue };
        executionResult = await applyToAmazon(decisionToApply);
        if (executionResult.ok) {
          await base44.asServiceRole.entities.Decision.update(decision_id, {
            status: 'executed',
            executed_at: now,
          });
        }
      } catch (e) {
        // Execução falhou mas aprovação foi registada — não bloqueia
        executionResult = { ok: false, error: e.message };
      }
    }

    await base44.asServiceRole.entities.LearningEvent.create({
      amazon_account_id: decision.amazon_account_id,
      event_type: `decision_${newStatus}`,
      entity_type: decision.entity_type,
      entity_id: decision.entity_id,
      observation: `Decisão ${newStatus} por ${user.full_name || user.email}${executionResult?.ok ? ' — aplicada na Amazon' : executionResult?.skipped ? '' : (executionResult?.error ? ` — erro API: ${executionResult.error}` : '')}`,
      decision_id,
      recorded_at: now,
    });

    return Response.json({
      ok: true,
      status: executionResult?.ok ? 'executed' : newStatus,
      executed: executionResult?.ok || false,
      execution_result: executionResult,
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});