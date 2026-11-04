import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { aiTaskPolicy, selectAiModel } from '../../shared/aiModelPolicy.ts';

/**
 * Revisão contextual do ciclo canônico. A IA somente propõe; não possui
 * caminho para chamar a Amazon, aprovar decisões ou alterar filas.
 */
Deno.serve(async (request) => {
  const startedAt = new Date().toISOString();
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    const accountId = body.amazon_account_id || null;
    const correlationId = body.correlation_id || crypto.randomUUID();
    const enabled = Deno.env.get('CANONICAL_AI_REVIEW_ENABLED') !== 'false' && body.ai_review_enabled !== false;
    if (!enabled) return Response.json({ ok: true, skipped: true, reason: 'ai_review_disabled', correlation_id: correlationId });
    if (!accountId) return Response.json({ ok: false, error: 'amazon_account_id_required', correlation_id: correlationId }, { status: 400 });

    const policy = aiTaskPolicy('complex_decision');
    const model = selectAiModel('complex_decision', Deno.env.get('OPENAI_COMPLEX_MODEL') || Deno.env.get('OPENAI_MODEL'));
    const input = {
      correlation_id: correlationId,
      effective_settings: body.effective_settings || null,
      economic_evidence: body.economic_evidence || null,
      unified_engine: body.unified_engine || null,
      data_freshness: body.data_freshness || null,
      dry_run: body.dry_run === true,
      ai_policy: policy,
    };
    const result = await base44.asServiceRole.integrations.Core.InvokeLLM({
      provider: 'openai',
      model,
      temperature: 0.1,
      max_tokens: 1800,
      prompt: `Você é o revisor de decisões complexas do LivingFinds. Use somente as evidências fornecidas. Não invente dados, não execute chamadas Amazon e não transforme sua sugestão em aprovação. Oportunidades exigem confiança >= 0.85; prevenção de prejuízo exige confiança >= 0.80. Se houver qualquer dado ausente, antigo ou inconsistente, marque blocked=true e explique o motivo. Retorne somente propostas explicáveis.\n${JSON.stringify(input)}`,
      response_json_schema: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          recommendations: { type: 'array', items: { type: 'object', properties: {
            action: { type: 'string', enum: ['keep', 'increase', 'decrease', 'pause', 'review'] },
            entity_type: { type: 'string' }, entity_id: { type: 'string' }, reason: { type: 'string' },
            confidence: { type: 'number' }, blocked: { type: 'boolean' }, block_reason: { type: 'string' },
          }, required: ['action', 'reason', 'confidence', 'blocked'] } },
        },
        required: ['summary', 'recommendations'],
      },
    });
    const audit = {
      provider: result?.provider || 'unknown', model: result?.model || model, task_policy: policy, request_id: result?.request_id || null,
      correlation_id: correlationId, status: result?.ok === false ? 'error' : 'success',
      recommendations: Array.isArray(result?.recommendations) ? result.recommendations.slice(0, 50) : [],
      summary: String(result?.summary || result?.error || '').slice(0, 900),
    };
    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: accountId, operation: 'canonical_ai_decision_review', trigger_type: body.trigger_type || 'canonical_decision_cycle',
      status: result?.ok === false ? 'error' : 'success', started_at: startedAt, completed_at: new Date().toISOString(),
      duration_ms: Date.now() - new Date(startedAt).getTime(), records_processed: audit.recommendations.length,
      result_summary: JSON.stringify(audit).slice(0, 1400), error_message: result?.ok === false ? String(result?.error || 'llm_error').slice(0, 900) : null,
    }).catch(() => {});
    console.info(`[canonical-ai] provider=${audit.provider} model=${audit.model || 'unknown'} request_id=${audit.request_id || 'none'} status=${audit.status} correlation_id=${correlationId}`);
    return Response.json({ ok: result?.ok !== false, proposal_only: true, ...audit });
  } catch (error) {
    return Response.json({ ok: false, proposal_only: true, error: error?.message || String(error) }, { status: 500 });
  }
});
