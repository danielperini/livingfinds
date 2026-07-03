import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    const ids = body.decision_ids || (body.decision_id ? [body.decision_id] : []);

    if (!ids.length) return Response.json({ ok: false, error: 'decision_id obrigatório' }, { status: 400 });

    const pauseIds = [];
    const otherIds = [];
    for (const id of ids) {
      const rows = await base44.asServiceRole.entities.OptimizationDecision.filter({ id }, null, 1).catch(() => []);
      if (rows[0]?.action === 'pause_campaign') pauseIds.push(id);
      else otherIds.push(id);
    }

    const results = [];
    if (pauseIds.length) {
      const response = await base44.asServiceRole.functions.invoke('executePauseDecisionSafe', {
        ...body,
        decision_ids: pauseIds,
        _service_role: true,
      });
      results.push(...(response?.data?.results || response?.results || []));
    }

    if (otherIds.length) {
      const response = await base44.asServiceRole.functions.invoke('executeAutopilotDecisionV2', {
        ...body,
        decision_ids: otherIds,
        _service_role: true,
      });
      results.push(...(response?.data?.results || response?.results || []));
    }

    return Response.json({
      ok: results.every((item) => item.ok || item.skipped),
      executed: results.filter((item) => item.status === 'executed' || item.ok).length,
      scheduled: results.filter((item) => item.scheduled).length,
      results,
    });
  } catch (error) {
    return Response.json({ ok: false, error: error?.message || 'Erro ao executar decisão' }, { status: 500 });
  }
});
