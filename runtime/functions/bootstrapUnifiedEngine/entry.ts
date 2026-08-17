import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { waitUntil } from 'base44:runtime';

const PHASES = [
  { key: 'classify', fn: 'classifyMarketplaceCampaignJourneys', payload: { _service_role: true }, background: true },
  { key: 'reactivate', fn: 'reactivatePausedWithStock', payload: { _service_role: true } },
  {
    key: 'lifecycle',
    fn: 'runUnifiedDecisionEngine',
    payload: { bootstrap: true, force_campaign_lifecycle: true, dry_run: false, _service_role: true },
    background: true,
  },
  { key: 'budget', fn: 'runEconomicBudgetBalancer', payload: { _service_role: true } },
  { key: 'orchestrator', fn: 'runDailyMasterOrchestrator', payload: { _service_role: true }, background: true },
];

export default async function (req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'admin') return Response.json({ error: 'Forbidden' }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    let accountId = body?.amazon_account_id || null;
    const promoteToFull = body?.promote_to_full === true;
    const onlyPhases = Array.isArray(body?.phases) ? body.phases : null;

    if (!accountId) {
      const accounts = await base44.asServiceRole.entities.AmazonAccount.list();
      accountId = accounts?.[0]?.id || null;
    }
    if (!accountId) return Response.json({ ok: false, error: 'Nenhuma conta Amazon encontrada.' }, { status: 400 });

    const configs = await base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: accountId }, null, 1);
    const config = configs?.[0] || null;
    if (!config) return Response.json({ ok: false, error: 'AutopilotConfig não encontrada para a conta.' }, { status: 400 });

    // FASE 1 — feature flags de operação real
    const flags = {
      unified_marketplace_decision_engine_v1: true,
      unified_engine_dry_run: false,
      unified_rollout_phase: promoteToFull ? 'full' : 'bids_only',
      economic_budget_balancer_enabled: true,
      approval_required: false,
      auto_apply_enabled: true,
      auto_apply_low_risk: true,
    };
    await base44.asServiceRole.entities.AutopilotConfig.update(config.id, flags);

    const startedAt = new Date().toISOString();
    const results = [];

    for (const phase of PHASES) {
      if (onlyPhases && !onlyPhases.includes(phase.key)) {
        results.push({ phase: phase.key, function: phase.fn, status: 'skipped' });
        continue;
      }
      const phaseStart = Date.now();
      const payload = { amazon_account_id: accountId, ...(phase.payload || {}) };

      if (phase.background) {
        waitUntil(base44.asServiceRole.functions.invoke(phase.fn, payload).catch(() => null));
        results.push({ phase: phase.key, function: phase.fn, status: 'dispatched' });
        continue;
      }

      try {
        const res = await base44.asServiceRole.functions.invoke(phase.fn, payload);
        const data = res?.data ?? res;
        results.push({
          phase: phase.key,
          function: phase.fn,
          status: data?.ok === false ? 'failed' : 'success',
          duration_ms: Date.now() - phaseStart,
          summary: typeof data?.summary === 'string' ? data.summary : undefined,
          error: data?.error || undefined,
        });
      } catch (error) {
        results.push({
          phase: phase.key,
          function: phase.fn,
          status: 'failed',
          duration_ms: Date.now() - phaseStart,
          error: error?.message || 'erro desconhecido',
        });
      }
    }

    const failures = results.filter((item) => item.status === 'failed').length;
    const executed = results.filter((item) => item.status === 'success').length;
    const finishedAt = new Date().toISOString();

    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: accountId,
      operation: 'unified_engine_cycle',
      trigger_type: 'manual',
      status: failures === 0 ? 'success' : executed > 0 ? 'partial' : 'failed',
      execution_date: finishedAt.slice(0, 10),
      started_at: startedAt,
      completed_at: finishedAt,
      duration_ms: new Date(finishedAt).getTime() - new Date(startedAt).getTime(),
      records_processed: executed,
      result_summary: JSON.stringify({ rollout_phase: flags.unified_rollout_phase, results }).slice(0, 4000),
    });

    return Response.json({
      ok: failures === 0,
      amazon_account_id: accountId,
      flags,
      executed,
      failures,
      results,
    });
  } catch (error) {
    return Response.json({ ok: false, error: error?.message || 'Erro inesperado' }, { status: 500 });
  }
}