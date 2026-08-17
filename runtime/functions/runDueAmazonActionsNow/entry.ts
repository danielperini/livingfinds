import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function brazilHour() {
  const parts = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  return Number(parts.find((part) => part.type === 'hour')?.value || 0);
}

Deno.serve(async (request) => {
  const startedAt = new Date().toISOString();
  try {
    const base44 = createClientFromRequest(request);
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    const body = await request.json().catch(() => ({}));
    if (!authenticated && !body._service_role) {
      return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    const accountId = body.amazon_account_id;
    if (!accountId) {
      return Response.json({ ok: false, error: 'amazon_account_id obrigatório' }, { status: 400 });
    }

    const hour = brazilHour();
    const inWindow = [0, 1, 2, 3, 13].includes(hour);
    const steps: any[] = [];

    const invoke = async (name: string, payload: any = {}) => {
      const started = Date.now();
      try {
        const response = await base44.asServiceRole.functions.invoke(name, {
          amazon_account_id: accountId,
          hour,
          _window_execution: inWindow,
          _service_role: true,
          ...payload,
        });
        const data = response?.data || response || {};
        steps.push({ function: name, ok: data?.ok !== false, duration_ms: Date.now() - started, result: data });
        return data;
      } catch (error) {
        const failure = { ok: false, error: error?.message || String(error) };
        steps.push({ function: name, ok: false, duration_ms: Date.now() - started, result: failure });
        return failure;
      }
    };

    await invoke('syncAds', { trigger_type: 'manual_api_verification' });
    await invoke('fixProductCampaignLinks');
    await invoke('prepareAllCampaignRepairs');
    await invoke('repairIncompleteAutoCampaigns');
    await invoke('scanExactKeywordIntegrity');

    if (inWindow) {
      await invoke('processProductKickoffQueueV2');
      await invoke('processAutoCampaignRepairQueue');
      await invoke('processKeywordRepairQueue');
      await invoke('executeApprovedDecisionQueue');
      await invoke('syncAds', { trigger_type: 'post_actions_verification' });
      await invoke('fixProductCampaignLinks');
    }

    const completedAt = new Date().toISOString();
    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: accountId,
      operation: 'run_due_amazon_actions_now',
      status: steps.every((step) => step.ok) ? 'success' : 'error',
      trigger_type: body.trigger_type || 'manual',
      started_at: startedAt,
      completed_at: completedAt,
      records_processed: steps.filter((step) => step.ok).length,
      result_summary: JSON.stringify({ hour, in_window: inWindow, steps }).slice(0, 4000),
      error_message: steps.every((step) => step.ok)
        ? null
        : steps.filter((step) => !step.ok).map((step) => `${step.function}: ${step.result?.error || 'falha'}`).join(' | ').slice(0, 1000),
    }).catch(() => {});

    return Response.json({
      ok: steps.every((step) => step.ok),
      amazon_api_verified: steps[0]?.ok === true,
      hour_brt: hour,
      in_amazon_window: inWindow,
      execution_policy: inWindow ? 'executed_due_actions' : 'verified_and_queued_for_next_window',
      steps,
      started_at: startedAt,
      completed_at: completedAt,
    });
  } catch (error) {
    return Response.json({ ok: false, error: error?.message || 'Erro ao verificar e executar chamadas Amazon' }, { status: 500 });
  }
});