import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const authenticated = await base44.auth.isAuthenticated();
    const body = await request.json().catch(() => ({}));
    if (!authenticated && !body._service_role) {
      return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    const accountId = body.amazon_account_id || null;
    const limit = Math.max(1, Math.min(Number(body.limit || 25), 50));
    const query = accountId ? { amazon_account_id: accountId, status: 'approved' } : { status: 'approved' };
    const approved = await base44.asServiceRole.entities.OptimizationDecision.filter(query, 'created_at', limit);

    if (!approved.length) {
      return Response.json({ ok: true, queued: 0, executed: 0, failed: 0, results: [] });
    }

    const response = await base44.asServiceRole.functions.invoke('executeAutopilotDecision', {
      decision_ids: approved.map((item) => item.id),
      _service_role: true,
    });

    const data = response?.data || response || {};
    return Response.json({
      ok: data.ok !== false,
      queued: approved.length,
      executed: Number(data.executed || 0),
      failed: Number(data.failed || 0),
      results: data.results || [],
    });
  } catch (error) {
    return Response.json({ ok: false, error: error?.message || 'Erro ao processar decisões aprovadas' }, { status: 500 });
  }
});
