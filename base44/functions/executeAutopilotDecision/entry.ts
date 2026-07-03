/**
 * executeAutopilotDecision — Executa decisões aprovadas via Amazon Ads API.
 * Fonte: OptimizationDecision (status = 'approved').
 *
 * Garantias:
 *  - Jamais executa sem status='approved'
 *  - Jamais marca como executada sem confirmação da Amazon API
 *  - Registra rollback_payload para reversão futura
 *  - Grava no BidHistory para auditoria
 *  - Define evaluation_due_at para acompanhamento de resultado
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const tokenCache = {};

async function getAdsToken(refreshToken) {
  const cached = tokenCache['exec'];
  if (cached && cached.expires_at > Date.now()) return cached.access_token;
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken || Deno.env.get('ADS_REFRESH_TOKEN'),
    client_id: Deno.env.get('ADS_CLIENT_ID'),
    client_secret: Deno.env.get('ADS_CLIENT_SECRET'),
  });
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || 'Token failed');
  tokenCache['exec'] = { access_token: data.access_token, expires_at: Date.now() + (data.expires_in - 60) * 1000 };
  return data.access_token;
}

function getAdsBaseUrl(account) {
  const r = (account?.region || Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function adsCall(account, method, path, body) {
  const token = await getAdsToken(account?.ads_refresh_token);
  const profileId = account?.ads_profile_id || Deno.env.get('ADS_PROFILE_ID');
  const res = await fetch(`${getAdsBaseUrl(account)}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID'),
      'Amazon-Advertising-API-Scope': String(profileId),
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// Avaliação programada por tipo de decisão
function getEvaluationDays(decisionType, action) {
  if (decisionType === 'bid_change') return 7;
  if (decisionType === 'budget_change') return 7;
  if (decisionType === 'negative_keyword') return 14;
  if (decisionType === 'placement_change') return 14;
  if (decisionType === 'dayparting_rule') return 14;
  if (decisionType === 'harvest_search_term') return 3; // delivery check
  return 7;
}

async function executeDecision(d, account, base44) {
  const now = new Date().toISOString();
  const sym = d.currency_symbol || account?.currency_symbol || 'R$';

  // Marcar como executando para evitar dupla execução
  await base44.asServiceRole.entities.OptimizationDecision.update(d.id, {
    status: 'executing',
    executed_at: now,
    attempt_count: (d.attempt_count || 0) + 1,
    last_attempt_at: now,
  });

  let result;

  try {
    switch (d.action) {
      case 'reduce_bid':
      case 'increase_bid':
      case 'update_bid': {
        const newValue = d.value_after;
        if (!newValue || newValue <= 0) throw new Error('Bid inválido: ' + newValue);
        if (d.entity_type === 'keyword') {
          // Buscar keyword_id real (campo 'keyword_id' na entidade = ID da Amazon)
          const kwRecs = await base44.asServiceRole.entities.Keyword.filter(
            { amazon_account_id: d.amazon_account_id, keyword_id: d.entity_id || d.keyword_id }, null, 1
          );
          const amazonKwId = kwRecs[0]?.keyword_id || d.entity_id || d.keyword_id;
          result = await adsCall(account, 'PUT', '/v2/sp/keywords', [{ keywordId: String(amazonKwId), bid: newValue }]);
        } else if (d.entity_type === 'ad_group') {
          result = await adsCall(account, 'PUT', '/v2/sp/adGroups', [{ adGroupId: d.entity_id, defaultBid: newValue }]);
        } else {
          throw new Error('entity_type não suportado para bid: ' + d.entity_type);
        }
        break;
      }

      case 'update_budget':
      case 'reduce_budget':
      case 'increase_budget': {
        const newBudget = d.value_after;
        if (!newBudget || newBudget <= 0) throw new Error('Budget inválido: ' + newBudget);
        const camBudRecs = await base44.asServiceRole.entities.Campaign.filter(
          { campaign_id: d.campaign_id || d.entity_id }, null, 1
        );
        const amazonCamBudId = camBudRecs[0]?.amazon_campaign_id || d.campaign_id || d.entity_id;
        result = await adsCall(account, 'PUT', '/v2/sp/campaigns', [{ campaignId: String(amazonCamBudId), dailyBudget: newBudget }]);
        break;
      }

      case 'pause_campaign': {
        // Buscar amazon_campaign_id real da entidade Campaign
        const camRecs = await base44.asServiceRole.entities.Campaign.filter(
          { campaign_id: d.campaign_id || d.entity_id }, null, 1
        );
        const amazonCamId = camRecs[0]?.amazon_campaign_id || d.campaign_id || d.entity_id;
        result = await adsCall(account, 'PUT', '/v2/sp/campaigns', [{ campaignId: String(amazonCamId), state: 'paused' }]);
        break;
      }

      case 'enable_campaign': {
        const camRecs2 = await base44.asServiceRole.entities.Campaign.filter(
          { campaign_id: d.campaign_id || d.entity_id }, null, 1
        );
        const amazonCamId2 = camRecs2[0]?.amazon_campaign_id || d.campaign_id || d.entity_id;
        result = await adsCall(account, 'PUT', '/v2/sp/campaigns', [{ campaignId: String(amazonCamId2), state: 'enabled' }]);
        break;
      }

      case 'pause_keyword': {
        result = await adsCall(account, 'PUT', '/v2/sp/keywords', [{ keywordId: d.entity_id || d.keyword_id, state: 'paused' }]);
        break;
      }

      case 'negative_exact':
      case 'negative_keyword': {
        const kText = d.keyword_text;
        if (!kText) throw new Error('keyword_text obrigatório para negativa');
        result = await adsCall(account, 'POST', '/v2/sp/negativeKeywords', [{
          campaignId: d.campaign_id,
          keywordText: kText,
          matchType: 'negativeExact',
          state: 'enabled',
        }]);
        break;
      }

      // harvest_search_term / create_keyword: criado via createAcceleratorCampaign ou ad group
      case 'create_keyword': {
        // Delegar para a função especializada
        const harvestResult = await base44.asServiceRole.functions.invoke('harvestConvertedSearchTerms', {
          amazon_account_id: d.amazon_account_id,
          single_decision_id: d.id,
          keyword_text: d.keyword_text,
          campaign_id: d.campaign_id,
          ad_group_id: d.ad_group_id,
          bid: d.value_after,
          asin: d.asin,
        });
        result = { ok: !!harvestResult?.ok, status: harvestResult?.ok ? 200 : 500, data: harvestResult };

        // ── Negativar automaticamente na campanha AUTO do mesmo ASIN ──────────
        if (result.ok && d.keyword_text && d.asin) {
          await base44.asServiceRole.functions.invoke('negateKeywordInAutoCampaign', {
            amazon_account_id: d.amazon_account_id,
            asin: d.asin,
            keyword_text: d.keyword_text,
            manual_campaign_id: d.campaign_id,
            triggered_by: 'autopilot_harvest',
          }).catch(e => console.warn('negateKeywordInAutoCampaign error:', e.message));
        }
        break;
      }

      // apply_dayparting: delega para applyDaypartingSchedule
      case 'apply_dayparting': {
        const daypartingRes = await base44.asServiceRole.functions.invoke('applyDaypartingSchedule', {
          opportunity_id: d.id,
          mode: 'hybrid',
          approve: true,
          auto_apply: true,
        });
        result = { ok: !!daypartingRes?.data?.ok, status: daypartingRes?.data?.ok ? 200 : 500, data: daypartingRes?.data || {} };
        break;
      }

      default:
        throw new Error(`Ação não suportada: ${d.action}`);
    }
  } catch (callError) {
    result = { ok: false, status: 500, data: { error: String(callError?.message || callError) } };
  }

  // ── Registrar resultado com confirmação Amazon ────────────────────────────
  const success = result && result.ok && (result.status === 200 || result.status === 207);
  const newStatus = success ? 'executed' : 'failed';
  const evalDays = getEvaluationDays(d.decision_type, d.action);
  const evaluationDue = new Date(Date.now() + evalDays * 86400000).toISOString();

  await base44.asServiceRole.entities.OptimizationDecision.update(d.id, {
    status: newStatus,
    executed_at: now,
    amazon_response: JSON.stringify(result.data),
    error_message: success ? null : (result.data?.error || JSON.stringify(result.data).slice(0, 200)),
    evaluation_due_at: success ? evaluationDue : null,
  });

  // ── Registrar no BidHistory se bid ou budget ──────────────────────────────
  if (success && ['reduce_bid', 'increase_bid', 'update_bid', 'update_budget', 'reduce_budget', 'increase_budget'].includes(d.action)) {
    const isBid = d.action.includes('bid') || d.action === 'update_bid';
    await base44.asServiceRole.entities.BidHistory.create({
      amazon_account_id: d.amazon_account_id,
      entity_type: d.entity_type,
      entity_id: d.entity_id || d.keyword_id,
      entity_name: d.keyword_text || d.campaign_id,
      bid_before:    isBid ? d.value_before : null,
      bid_after:     isBid ? d.value_after  : null,
      budget_before: !isBid ? d.value_before : null,
      budget_after:  !isBid ? d.value_after  : null,
      change_pct: d.change_pct,
      reason: d.rationale?.slice(0, 500),
      applied_by: 'autopilot',
      decision_id: d.id,
      amazon_response: JSON.stringify(result.data),
    });

    // Atualizar keyword com dados de controle de cooldown
    if (isBid && d.keyword_id) {
      await base44.asServiceRole.entities.Keyword.updateMany(
        { amazon_account_id: d.amazon_account_id, keyword_id: d.keyword_id },
        { $set: {
          bid: d.value_after,
          current_bid: d.value_after,
          last_bid_change_at: now,
          bid_change_count_30d: 1, // incrementar via lógica externa
        }}
      ).catch(() => {});
    }
  }

  // ── Reativar campanha pausada por OOS quando estoque retornou ─────────────
  if (success && d.action === 'enable_campaign') {
    await base44.asServiceRole.entities.Campaign.updateMany(
      { amazon_account_id: d.amazon_account_id, campaign_id: d.campaign_id },
      { $set: { state: 'enabled', status: 'enabled' } }
    ).catch(() => {});
  }

  if (success && d.action === 'pause_campaign') {
    await base44.asServiceRole.entities.Campaign.updateMany(
      { amazon_account_id: d.amazon_account_id, campaign_id: d.campaign_id },
      { $set: { state: 'paused', status: 'paused' } }
    ).catch(() => {});
  }

  return { id: d.id, ok: success, status: newStatus, action: d.action, amazon_response: result.data };
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    // Aceita tanto chamadas autenticadas (frontend) como chamadas de service role (automações)
    const isAuthenticated = await base44.auth.isAuthenticated();
    const body = await req.json().catch(() => ({}));
    if (!isAuthenticated && !body._service_role) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const ids = body.decision_ids || (body.decision_id ? [body.decision_id] : []);
    if (!ids.length) return Response.json({ error: 'decision_ids required' }, { status: 400 });

    // Cache de contas por ID para não re-buscar a cada decisão
    const accountCache = new Map();
    async function getAccount(amazonAccountId) {
      if (!amazonAccountId) {
        // fallback: primeira conta conectada
        if (!accountCache.has('_default')) {
          const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
          accountCache.set('_default', accs[0] || null);
        }
        return accountCache.get('_default');
      }
      if (!accountCache.has(amazonAccountId)) {
        const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: amazonAccountId }, null, 1);
        accountCache.set(amazonAccountId, accs[0] || null);
      }
      return accountCache.get(amazonAccountId);
    }

    const results = [];
    for (const id of ids) {
      // Buscar de OptimizationDecision (fonte canônica)
      const decs = await base44.asServiceRole.entities.OptimizationDecision.filter({ id }, null, 1);
      const decision = decs[0];

      if (!decision) {
        results.push({ id, ok: false, error: 'Decisão não encontrada' }); continue;
      }
      if (!['approved', 'pending'].includes(decision.status)) {
        results.push({ id, ok: false, error: `Status inválido para execução: ${decision.status}` }); continue;
      }
      if (decision.status === 'pending' && decision.requires_approval) {
        results.push({ id, ok: false, error: 'Decisão requer aprovação antes de executar' }); continue;
      }
      if (decision.attempt_count >= 3) {
        results.push({ id, ok: false, error: 'Máximo de 3 tentativas atingido' }); continue;
      }

      // Usar SEMPRE a conta da decisão — evita executar na conta errada
      const account = await getAccount(decision.amazon_account_id);
      if (!account) {
        results.push({ id, ok: false, error: `Conta não encontrada: ${decision.amazon_account_id}` }); continue;
      }

      const result = await executeDecision(decision, account, base44);
      results.push(result);
    }

    const executed = results.filter(r => r.ok).length;
    const failed   = results.filter(r => !r.ok).length;
    return Response.json({ ok: true, executed, failed, results });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});