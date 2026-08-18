import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

const SOURCE = 'enforceLowVolumeProductAdsStrategy';

async function invoke(base44: any, name: string, payload: Record<string, unknown>) {
  try {
    const response = await base44.asServiceRole.functions.invoke(name, payload);
    return response?.data || response || { ok: true };
  } catch (error: any) {
    return { ok: false, error: error?.response?.data?.error || error?.message || String(error) };
  }
}

Deno.serve(async (request) => {
  try {
    const base44: any = createClientFromRequest(request) as any;
    const body: any = await request.json().catch(() => ({}));

    if (body._service_role !== true) {
      const user = await base44.auth.me().catch(() => null);
      if (!user || user.role !== 'admin') {
        return Response.json({ ok: false, error: 'Admin only' }, { status: 403 });
      }
    }

    const dryRun = body.dry_run === true;
    const accounts: any[] = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, undefined, 1).catch(() => [])
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-updated_at', 100).catch(() => []);

    const results: any[] = [];
    for (const account of accounts.filter((row: any) => row?.ads_profile_id || row?.status === 'connected')) {
      const accountId = String(account.id);
      const correlationId = crypto.randomUUID();

      const cycle = await invoke(base44, 'runCanonicalDecisionCycle', {
        _service_role: true,
        amazon_account_id: accountId,
        dry_run: dryRun,
        skip_sync: false,
        trigger_type: body.trigger_type || 'legacy_low_volume_delegated_sales_recovery',
        correlation_id: correlationId,
      });

      let execution: any = { ok: true, skipped: true, reason: 'dry_run' };
      let confirmation: any = { ok: true, skipped: true, reason: 'dry_run' };

      if (!dryRun && cycle?.ok !== false) {
        execution = await invoke(base44, 'executeApprovedDecisionQueue', {
          _service_role: true,
          amazon_account_id: accountId,
          max_decisions: Number(body.max_decisions || 25),
          trigger_type: 'immediate_sales_recovery_executor',
          correlation_id: correlationId,
        });
        confirmation = await invoke(base44, 'confirmExecutedDecisions', {
          _service_role: true,
          amazon_account_id: accountId,
          trigger_type: 'immediate_sales_recovery_confirmation',
          correlation_id: correlationId,
        });
      }

      results.push({
        amazon_account_id: accountId,
        correlation_id: correlationId,
        canonical_cycle: cycle,
        canonical_execution: execution,
        amazon_confirmation: confirmation,
      });
    }

    const ok = results.every((row) =>
      row.canonical_cycle?.ok !== false &&
      row.canonical_execution?.ok !== false &&
      row.amazon_confirmation?.ok !== false
    );

    return Response.json({
      ok,
      source: SOURCE,
      mode: 'canonical_delegate_only',
      deprecated_direct_low_volume_mutations: true,
      direct_budget_reduction: false,
      direct_bid_reduction: false,
      decision_owner: 'runCanonicalDecisionCycle',
      execution_owner: 'executeApprovedDecisionQueue',
      confirmation_owner: 'confirmExecutedDecisions',
      processed: results.length,
      campaigns_enabled: 0,
      budgets_reduced: 0,
      bids_reduced: 0,
      results,
    }, { status: ok ? 200 : 207 });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || String(error) }, { status: 500 });
  }
});
