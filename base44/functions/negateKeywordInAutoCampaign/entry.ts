/**
 * negateKeywordInAutoCampaign — Quando uma campanha MANUAL é criada para um ASIN,
 * negativaExact a mesma keyword na campanha AUTO vinculada ao mesmo produto.
 *
 * Regras:
 * - Busca campanha AUTO ativa para o mesmo ASIN/amazon_account_id
 * - Cria negative keyword via Amazon Ads API na campanha AUTO
 * - Registra no OptimizationDecision e CampaignChangeHistory
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const tokenCache = {};

async function getAdsToken(refreshToken) {
  const cached = tokenCache['neg'];
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
  tokenCache['neg'] = { access_token: data.access_token, expires_at: Date.now() + (data.expires_in - 60) * 1000 };
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

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    const { amazon_account_id, asin, keyword_text, manual_campaign_id, triggered_by } = body;
    if (!amazon_account_id || !asin || !keyword_text) {
      return Response.json({ ok: false, error: 'amazon_account_id, asin e keyword_text são obrigatórios' }, { status: 400 });
    }

    const now = new Date().toISOString();

    const account = await base44.asServiceRole.entities.AmazonAccount.get(amazon_account_id).catch(() => null);
    if (!account) return Response.json({ ok: false, error: 'AmazonAccount não encontrada' });

    // ── Buscar campanha AUTO para o mesmo ASIN ────────────────────────────────
    const allCampaigns = await base44.asServiceRole.entities.Campaign.filter({
      amazon_account_id,
      asin,
      targeting_type: 'AUTO',
    });

    const autoCampaign = allCampaigns.find(
      c => c.state !== 'archived' && c.status !== 'archived' && !c.archived
    );

    if (!autoCampaign) {
      return Response.json({
        ok: true,
        skipped: true,
        reason: `Nenhuma campanha AUTO ativa encontrada para ASIN ${asin}. Nenhuma negativação necessária.`,
      });
    }

    const kwText = keyword_text.toLowerCase().trim();
    const autoCampaignId = autoCampaign.campaign_id;

    // ── Verificar se já existe essa negativa ──────────────────────────────────
    const existingDecisions = await base44.asServiceRole.entities.OptimizationDecision.filter({
      amazon_account_id,
      campaign_id: autoCampaignId,
      keyword_text: kwText,
      decision_type: 'negative_keyword',
      status: 'executed',
    }, null, 1);

    if (existingDecisions.length > 0) {
      return Response.json({
        ok: true,
        skipped: true,
        reason: `Keyword "${kwText}" já está negativada na campanha AUTO ${autoCampaignId}.`,
      });
    }

    // ── Criar negativa via Amazon Ads API ─────────────────────────────────────
    const result = await adsCall(account, 'POST', '/v2/sp/negativeKeywords', [{
      campaignId: autoCampaignId,
      keywordText: kwText,
      matchType: 'negativeExact',
      state: 'enabled',
    }]);

    const success = result.ok && [200, 201, 207].includes(result.status);

    // ── Registrar na OptimizationDecision (fonte canônica) ────────────────────
    await base44.asServiceRole.entities.OptimizationDecision.create({
      amazon_account_id,
      decision_type: 'negative_keyword',
      entity_type: 'search_term',
      entity_id: autoCampaignId,
      campaign_id: autoCampaignId,
      keyword_text: kwText,
      asin,
      action: 'negative_exact',
      rationale: `Negativação automática: keyword "${kwText}" foi criada como MANUAL na campanha ${manual_campaign_id || 'nova'}. Regra: a mesma palavra deve ser negativada na campanha AUTO vinculada ao mesmo produto (ASIN: ${asin}).`,
      data_used: JSON.stringify({ triggered_by: triggered_by || 'manual_campaign_creation', manual_campaign_id, auto_campaign_id: autoCampaignId }),
      risk: 'low',
      requires_approval: false,
      status: success ? 'executed' : 'failed',
      confidence: 99,
      objective: 'profitability',
      reversible: true,
      amazon_response: JSON.stringify(result.data),
      error_message: success ? null : JSON.stringify(result.data).slice(0, 200),
      executed_at: now,
      created_at: now,
      source_function: 'negateKeywordInAutoCampaign',
      idempotency_key: `neg-auto-${amazon_account_id}-${autoCampaignId}-${kwText}-${now.slice(0, 10)}`,
    });

    // ── Registrar no CampaignChangeHistory (auditoria centralizada) ───────────
    await base44.asServiceRole.entities.CampaignChangeHistory.create({
      amazon_account_id,
      campaign_id: autoCampaignId,
      change_type: 'NEGATIVE_CREATED',
      entity_type: 'keyword',
      entity_id: autoCampaignId,
      field_name: 'negative_keyword',
      old_value: null,
      new_value: kwText,
      source: 'AUTOPILOT',
      source_function: 'negateKeywordInAutoCampaign',
      reason: `Keyword "${kwText}" negativada automaticamente na campanha AUTO ao ser criada como MANUAL. Produto: ${asin}.`,
      amazon_response: JSON.stringify(result.data),
      status: success ? 'executed' : 'failed',
      error: success ? null : JSON.stringify(result.data).slice(0, 200),
      changed_at: now,
      changed_by: triggered_by || 'autopilot',
    });

    return Response.json({
      ok: success,
      auto_campaign_id: autoCampaignId,
      keyword_negated: kwText,
      asin,
      amazon_status: result.status,
      amazon_response: result.data,
      message: success
        ? `Keyword "${kwText}" negativada com sucesso na campanha AUTO ${autoCampaignId} (ASIN: ${asin}).`
        : `Falha ao negativar keyword "${kwText}" via API. Decisão registrada para retry.`,
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});