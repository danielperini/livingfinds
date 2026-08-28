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

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    const { amazon_account_id, asin, keyword_text, manual_campaign_id, triggered_by, confirmed_decision_id } = body;
    if (!amazon_account_id || !asin || !keyword_text || !confirmed_decision_id) {
      return Response.json({ ok: false, error: 'amazon_account_id, asin e keyword_text são obrigatórios' }, { status: 400 });
    }

    const now = new Date().toISOString();

    const confirmedRows = await base44.asServiceRole.entities.OptimizationDecision.filter({
      id: confirmed_decision_id,
      amazon_account_id,
      confirmation_status: 'confirmed',
    }, undefined, 1).catch(() => []);
    if (!confirmedRows[0]) return Response.json({ ok: true, skipped: true, reason: 'MANUAL_EXACT_NOT_REMOTELY_CONFIRMED' });

    // ── Buscar campanha AUTO para o mesmo ASIN ────────────────────────────────
    const allCampaigns = await base44.asServiceRole.entities.Campaign.filter({
      amazon_account_id,
      asin,
      targeting_type: 'AUTO',
    });

    const autoCampaign = allCampaigns.find(
      (c: any) => c.state !== 'archived' && c.status !== 'archived' && !c.archived
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
    const negativeIdempotencyKey = `neg-auto-${amazon_account_id}-${autoCampaignId}-${kwText}`;
    const existingDecisions = await base44.asServiceRole.entities.OptimizationDecision.filter({
      idempotency_key: negativeIdempotencyKey,
    }, null, 1);

    if (existingDecisions.length > 0) {
      return Response.json({
        ok: true,
        skipped: true,
        reason: `Keyword "${kwText}" já está negativada na campanha AUTO ${autoCampaignId}.`,
      });
    }

    // ── Criar negativa via Amazon Ads API ─────────────────────────────────────
    const command = await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
      amazon_account_id,
      operation: 'negateKeywordInAutoCampaign',
      method: 'POST',
      path: '/sp/negativeKeywords',
      payload: { negativeKeywords: [{ campaignId: autoCampaignId, keywordText: kwText, matchType: 'NEGATIVE_EXACT', state: 'ENABLED' }] },
      content_type: 'application/vnd.spNegativeKeyword.v3+json',
      accept: 'application/vnd.spNegativeKeyword.v3+json',
      _service_role: true,
    });
    const result = command?.data || command || {};
    const success = result.ok === true || [200, 201, 207].includes(Number(result.status || 0));

    // ── Registrar na OptimizationDecision (fonte canônica) ────────────────────
    await base44.asServiceRole.entities.OptimizationDecision.create({
      amazon_account_id,
      decision_type: 'negative_keyword',
      entity_type: 'keyword',
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
      amazon_response: JSON.stringify(result.payload || result),
      error_message: success ? null : JSON.stringify(result.payload || result).slice(0, 200),
      executed_at: now,
      created_at: now,
      source_function: 'negateKeywordInAutoCampaign',
      idempotency_key: negativeIdempotencyKey,
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
      amazon_response: JSON.stringify(result.payload || result),
      status: success ? 'executed' : 'failed',
      error: success ? null : JSON.stringify(result.payload || result).slice(0, 200),
      changed_at: now,
      changed_by: triggered_by || 'autopilot',
    });

    return Response.json({
      ok: success,
      auto_campaign_id: autoCampaignId,
      keyword_negated: kwText,
      asin,
      amazon_status: result.status,
      amazon_response: result.payload || result,
      message: success
        ? `Keyword "${kwText}" negativada com sucesso na campanha AUTO ${autoCampaignId} (ASIN: ${asin}).`
        : `Falha ao negativar keyword "${kwText}" via API. Decisão registrada para retry.`,
    });

  } catch (error: any) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});
