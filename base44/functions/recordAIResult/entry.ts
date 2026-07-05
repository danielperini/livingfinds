/**
 * recordAIResult — Salva resultado de análise IA no cache e atualiza o log de uso
 *
 * Deve ser chamado SEMPRE após uma análise IA bem-sucedida para:
 *  1. Salvar no AIAnalysisCache (evitar rechamadas)
 *  2. Incrementar AIUsageLog (rastrear custo e tokens)
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const AI_CACHE_TTL: Record<string, number> = {
  keyword_relevance:    30 * 86400000,
  keyword_analysis:     14 * 86400000,
  campaign_strategy:     7 * 86400000,
  daily_summary:        24 * 3600000,
  decision_explanation:  7 * 86400000,
  risk_analysis:         3 * 86400000,
  search_term_intent:   30 * 86400000,
};

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const {
      amazon_account_id, analysis_type, entity_type = 'account', entity_id = '',
      input_hash, result, decision = '', reason = '', confidence = 0,
      model = 'auto', tokens_used = 0, cost_estimate = 0,
    } = body;

    if (!amazon_account_id || !analysis_type || !input_hash) {
      return Response.json({ ok: false, error: 'amazon_account_id, analysis_type e input_hash são obrigatórios' }, { status: 400 });
    }

    const now = new Date().toISOString();
    const today = now.slice(0, 10);
    const ttl = AI_CACHE_TTL[analysis_type] || 86400000;
    const expires_at = new Date(Date.now() + ttl).toISOString();

    // Invalidar cache anterior para esse (account, type, entity, hash)
    const prev = await base44.asServiceRole.entities.AIAnalysisCache.filter({
      amazon_account_id, analysis_type, entity_type, input_hash, status: 'valid',
    }, null, 5);
    for (const p of prev) {
      await base44.asServiceRole.entities.AIAnalysisCache.update(p.id, { status: 'invalidated' });
    }

    // Salvar novo resultado
    await base44.asServiceRole.entities.AIAnalysisCache.create({
      amazon_account_id,
      entity_type,
      entity_id,
      analysis_type,
      input_hash,
      result_json: typeof result === 'string' ? result : JSON.stringify(result),
      confidence,
      decision,
      reason,
      model,
      tokens_used,
      cost_estimate,
      expires_at,
      reuse_count: 0,
      status: 'valid',
    });

    // Atualizar AIUsageLog
    const logs = await base44.asServiceRole.entities.AIUsageLog.filter({ amazon_account_id, log_date: today }, null, 1);
    if (logs.length > 0) {
      const log = logs[0];
      await base44.asServiceRole.entities.AIUsageLog.update(log.id, {
        calls_made:     (log.calls_made || 0) + 1,
        tokens_used:    (log.tokens_used || 0) + tokens_used,
        cost_estimate:  Math.round(((log.cost_estimate || 0) + cost_estimate) * 10000) / 10000,
        api_calls_ads:  (log.api_calls_ads || 0) + 1,
      });
    } else {
      await base44.asServiceRole.entities.AIUsageLog.create({
        amazon_account_id,
        log_date: today,
        calls_made: 1,
        tokens_used,
        cost_estimate,
        budget_resets_at: new Date(Date.now() + 86400000).toISOString(),
      });
    }

    return Response.json({ ok: true, expires_at, ttl_ms: ttl });
  } catch (err) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
});