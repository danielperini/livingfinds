import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

/**
 * Entrada canônica da revisão semanal por GPT.
 * A função legada já usa OpenAI/GPT; este wrapper corrige a nomenclatura,
 * normaliza a autoria das regras e publica um marcador no feed operacional.
 *
 * Não há aprovação manual: backtest + shadow + governança determinística são
 * o gate automático. A interface apenas sinaliza "Alterado pela IA".
 */
Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    if (!body._service_role) {
      const user = await base44.auth.me().catch(() => null);
      if (!user) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    const response = await base44.asServiceRole.functions.invoke('runWeeklyClaudeRuleReview', {
      ...body,
      _service_role: true,
      trigger_type: body.trigger_type || 'weekly_gpt_supervisor',
    }).catch((error: any) => ({ data: { ok: false, error: error?.message || String(error) } }));
    const result = response?.data || response || {};
    if (result.ok !== true) return Response.json({ ...result, canonical_function: 'runWeeklyGptRuleReview' }, { status: 500 });

    const aid = body.amazon_account_id || (await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-updated_at', 1).catch(() => []))[0]?.id;
    const reviewId = result.review_id;
    const changed: any[] = [];

    if (aid && reviewId) {
      const rules = await base44.asServiceRole.entities.DecisionRule.filter({ amazon_account_id: aid, review_id: reviewId }, '-created_at', 100).catch(() => []);
      for (const rule of rules) {
        await base44.asServiceRole.entities.DecisionRule.update(rule.id, {
          source: 'gpt4_weekly_review',
          updated_at: new Date().toISOString(),
        }).catch(() => {});

        const idempotencyKey = `${aid}|gpt_weekly_rule_change|${reviewId}|${rule.rule_key}`;
        const previous = await base44.asServiceRole.entities.OptimizationDecision.filter({ amazon_account_id: aid, idempotency_key: idempotencyKey }, '-created_at', 1).catch(() => []);
        if (previous.length > 0) continue;

        const marker = await base44.asServiceRole.entities.OptimizationDecision.create({
          amazon_account_id: aid,
          decision_type: 'rule_recalibration',
          entity_type: 'decision_rule',
          entity_id: String(rule.id),
          action: 'ai_rule_change',
          rationale: `Alterado pela IA · GPT semanal: ${rule.name || rule.rule_key}. ${rule.reason || 'Regra recalibrada após backtest e entrada em shadow.'}`,
          risk: 'low',
          requires_approval: false,
          approval_status: 'auto_approved',
          status: 'executed',
          queue_status: 'completed',
          idempotency_key: idempotencyKey,
          source_function: 'runWeeklyGptRuleReview',
          execution_result: 'Alterado pela IA; regra em governança automática (backtest/shadow/promoção ou rollback).',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).catch(() => null);
        changed.push({ rule_key: rule.rule_key, rule_id: rule.id, marker_id: marker?.id || null });
      }

      await base44.asServiceRole.entities.SyncExecutionLog.create({
        amazon_account_id: aid,
        operation: 'weekly_gpt_rule_review',
        trigger_type: body.trigger_type || 'scheduler',
        status: 'success',
        records_processed: changed.length,
        result_summary: `Alterado pela IA: ${changed.length} regra(s) enviada(s) para governança automática; review=${reviewId}; model=${result.model || 'GPT'}`,
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
      }).catch(() => {});
    }

    return Response.json({
      ...result,
      canonical_function: 'runWeeklyGptRuleReview',
      ai_provider: 'OpenAI',
      ai_label: 'GPT',
      manual_approval_required: false,
      ai_changes_signaled: changed.length,
      changed_rules: changed,
    });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || String(error) }, { status: 500 });
  }
});
