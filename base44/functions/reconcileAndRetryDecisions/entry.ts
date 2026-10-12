/**
 * Legacy compatibility endpoint.
 *
 * This function previously wrote directly to Amazon during reconciliation,
 * bypassing the canonical queue, current governance, inventory/economics
 * validation and idempotency checks. V6SIA intentionally disables that path.
 * Reconciliation is read/confirm only; safe retries return through
 * confirmExecutedDecisions -> executeApprovedDecisionQueue.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

Deno.serve(async (request) => {
  const now = new Date().toISOString();
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    if (!authenticated && !body._service_role) {
      return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    const accounts = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, undefined, 1).catch(() => [])
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-updated_at', 1).catch(() => []);
    const account = accounts[0] || null;
    if (account) {
      await base44.asServiceRole.entities.SyncExecutionLog.create({
        amazon_account_id: account.id,
        operation: 'legacy_reconcile_retry_disabled',
        trigger_type: body._service_role ? 'automatic_legacy' : 'manual',
        status: 'warning',
        started_at: now,
        completed_at: now,
        records_processed: 0,
        result_summary: 'V6SIA desativou reaplicações diretas. A confirmação e os retries passam pelo confirmExecutedDecisions e executeApprovedDecisionQueue.',
      }).catch(() => {});
    }
    return Response.json({
      ok: true,
      engine_version: 'V6SIA',
      deprecated: true,
      remote_mutations: 0,
      confirmation_owner: 'confirmExecutedDecisions',
      retry_owner: 'executeApprovedDecisionQueue',
      reason: 'A reaplicação direta foi removida para impedir duplicidade e contorno dos gates de segurança.',
    });
  } catch (error: any) {
    return Response.json({ ok: false, engine_version: 'V6SIA', error: error?.message || String(error) }, { status: 500 });
  }
});
