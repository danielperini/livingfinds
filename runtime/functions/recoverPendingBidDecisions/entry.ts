import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    if (!authenticated && !body._service_role) {
      return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    const response = await base44.asServiceRole.functions.invoke('processBidDecisionQueue', {
      amazon_account_id: body.amazon_account_id || null,
      recovery_mode: true,
      spacing_ms: Math.max(1500, Number(body.spacing_ms || 2500)),
      max_runtime_ms: Math.min(480000, Math.max(60000, Number(body.max_runtime_ms || 240000))),
      _service_role: true,
    });

    const data = response?.data || response || {};
    return Response.json({
      ok: data?.ok !== false,
      mode: 'immediate_backlog_recovery',
      sequential: true,
      continuation_required: Boolean(data?.continuation_required),
      remaining: Number(data?.remaining || 0),
      result: data,
    });
  } catch (error) {
    return Response.json({ ok: false, error: error?.message || 'Erro ao recuperar backlog de bids' }, { status: 500 });
  }
});
