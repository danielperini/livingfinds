import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const slot = (id) => Math.abs(String(id || '').split('').reduce((a, c) => ((a << 5) - a + c.charCodeAt(0)) | 0, 0)) % 4;

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const authenticated = await base44.auth.isAuthenticated();
    const body = await request.json().catch(() => ({}));
    if (!authenticated && !body._service_role) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });

    const approvedQuery = body.amazon_account_id
      ? { amazon_account_id: body.amazon_account_id, status: 'approved' }
      : { status: 'approved' };
    const failedPauseQuery = body.amazon_account_id
      ? { amazon_account_id: body.amazon_account_id, status: 'failed', action: 'pause_campaign' }
      : { status: 'failed', action: 'pause_campaign' };

    const [approved, failedPauses] = await Promise.all([
      base44.asServiceRole.entities.OptimizationDecision.filter(approvedQuery, 'created_at', 50),
      base44.asServiceRole.entities.OptimizationDecision.filter(failedPauseQuery, '-created_at', 50).catch(() => []),
    ]);

    const pauseMap = new Map();
    for (const item of [...approved.filter((x) => x.action === 'pause_campaign'), ...failedPauses]) {
      pauseMap.set(item.id, item);
    }
    const pauses = [...pauseMap.values()];
    const queued = approved.filter((x) => x.action !== 'pause_campaign');

    for (const item of queued) {
      const isDayparting = item.action === 'apply_dayparting' || item.decision_type === 'dayparting_rule';
      const hour = isDayparting ? 13 : slot(item.id);
      await base44.asServiceRole.entities.OptimizationDecision.update(item.id, {
        queue_status: 'scheduled',
        queue_hour: hour,
        queue_window: isDayparting ? '13:00-14:00' : `${hour}:00-${hour + 1}:00`,
        queued_at: new Date().toISOString(),
        execution_channel: isDayparting ? 'amazon_api_dayparting' : 'amazon_api_queue',
      });
    }

    let result = { executed: 0, failed: 0, results: [] };
    if (pauses.length) {
      const response = await base44.asServiceRole.functions.invoke('executeAutopilotDecision', {
        decision_ids: pauses.map((x) => x.id),
        _service_role: true,
      });
      result = response?.data || response || result;
    }

    return Response.json({
      ok: true,
      queued: queued.length,
      executed: Number(result.executed || 0),
      failed: Number(result.failed || 0),
      immediate_pause_count: pauses.length,
      retried_failed_pauses: failedPauses.length,
      policy: '00:00-04:00 and 13:00-14:00; pause_campaign immediate',
      results: result.results || [],
    });
  } catch (error) {
    return Response.json({ ok: false, error: error?.message || 'Erro na fila de decisões' }, { status: 500 });
  }
});
