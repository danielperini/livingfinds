import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';

const EXECUTOR_BID_ACTIONS = new Set(['set_bid', 'increase_bid', 'reduce_bid', 'update_bid']);
const OBSERVED_STATUSES = [
  'approved', 'executing', 'pending', 'queued', 'ready', 'proposed', 'created',
  'confirming', 'executed', 'completed', 'failed', 'blocked', 'cancelled',
  'skipped', 'superseded', 'expired', 'rejected', 'pending_approval', 'scheduled',
];
const HARD_TERMINAL = new Set([
  'blocked', 'cancelled', 'canceled', 'skipped', 'superseded', 'expired', 'rejected',
  'failed', 'failed_final', 'error', 'rolled_back', 'confirming', 'awaiting_confirmation',
  'conflict_reconciling', 'pending_approval',
]);

function rowTs(row: any): number {
  const raw = row?.created_at || row?.created_date || row?.evaluated_at || row?.updated_at || 0;
  const value = Date.parse(String(raw));
  return Number.isFinite(value) ? value : 0;
}

function hasAmazonExecutionEvidence(row: any): boolean {
  return Boolean(row?.amazon_request_id || row?.amazon_response || row?.executed_at);
}

function isBidDecision(row: any): boolean {
  const action = String(row?.action || '').toLowerCase();
  const type = String(row?.decision_type || '').toLowerCase();
  const reason = String(row?.change_type || row?.reason_code || '').toLowerCase();
  if (EXECUTOR_BID_ACTIONS.has(action)) return true;
  if (`${action} ${type} ${reason}`.includes('bid')) return true;
  if (`${action} ${type} ${reason}`.includes('lance')) return true;
  if (row?.new_bid !== undefined && row?.new_bid !== null) return true;
  if (row?.old_bid !== undefined && row?.old_bid !== null) return true;
  if (row?.bid_change_pct !== undefined && row?.bid_change_pct !== null) return true;
  return false;
}

function targetBidOf(row: any): number {
  return Number(row?.value_after ?? row?.proposed_value ?? row?.new_bid);
}

function hasValidTargetBid(row: any): boolean {
  const value = targetBidOf(row);
  return Number.isFinite(value) && value > 0;
}

function canonicalKey(row: any): string {
  const account = String(row?.amazon_account_id || '');
  const entity = String(
    row?.keyword_id ||
    (row?.entity_type === 'keyword' ? row?.entity_id : '') ||
    `${row?.campaign_id || ''}|${row?.ad_group_id || ''}|${row?.keyword_text || ''}|${row?.asin || ''}`
  );
  return `${account}|${entity}`;
}

function canRecover(row: any): boolean {
  const status = String(row?.status || '').toLowerCase();
  const queueStatus = String(row?.queue_status || '').toLowerCase();
  const confirmationStatus = String(row?.amazon_confirmation_status || row?.confirmation_status || '').toLowerCase();
  if (!isBidDecision(row) || !hasValidTargetBid(row)) return false;
  if (hasAmazonExecutionEvidence(row)) return false;
  if (HARD_TERMINAL.has(status)) return false;
  if (['failed', 'cancelled', 'completed'].includes(queueStatus) && status !== 'executed') return false;
  if (['confirmed', 'divergent', 'not_applicable'].includes(confirmationStatus)) return false;
  if (status === 'executing') {
    const attemptTs = Date.parse(String(row?.last_attempt_at || row?.updated_at || row?.created_at || 0));
    if (Number.isFinite(attemptTs) && attemptTs >= Date.now() - 20 * 60_000) return false;
  }
  return true;
}

async function loadStatus(base44: any, status: string, accountId: string, limit: number) {
  return base44.asServiceRole.entities.OptimizationDecision.filter(
    accountId ? { amazon_account_id: accountId, status } : { status }, '-created_at', limit,
  ).catch(() => []);
}

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    if (!body._service_role) return Response.json({ ok: false, error: 'Uso interno' }, { status: 403 });

    const accountId = body.amazon_account_id ? String(body.amazon_account_id) : '';
    const lookbackHours = Math.max(1, Math.min(168, Number(body.lookback_hours || 72)));
    const maxExecute = Math.max(1, Math.min(50, Number(body.max_execute || 20)));
    const scanLimit = Math.max(100, Math.min(1500, Number(body.scan_limit || 750)));
    const cutoff = Date.now() - lookbackHours * 3600_000;

    const observedBatches = await Promise.all(
      OBSERVED_STATUSES.map(async (status) => [status, await loadStatus(base44, status, accountId, scanLimit)] as const),
    );
    const rawRecent = await base44.asServiceRole.entities.OptimizationDecision.filter(
      accountId ? { amazon_account_id: accountId } : {}, '-created_at', scanLimit,
    ).catch(() => []);

    const statusCounts: Record<string, number> = {};
    for (const [status, rows] of observedBatches) {
      statusCounts[status] = rows.filter((row: any) => isBidDecision(row) && rowTs(row) >= cutoff).length;
    }

    const sourceRows = rawRecent.length ? rawRecent : observedBatches.flatMap(([, rows]) => rows);
    const seenIds = new Set<string>();
    const recentRows = sourceRows.filter((row: any) => {
      const id = String(row?.id || '');
      if (!id || seenIds.has(id)) return false;
      seenIds.add(id);
      return rowTs(row) >= cutoff;
    });

    const unsentBidRows = recentRows.filter((row: any) => isBidDecision(row) && !hasAmazonExecutionEvidence(row));
    const candidates = unsentBidRows.filter((row: any) => canRecover(row));
    const unsentStatusCounts: Record<string, number> = {};
    for (const row of unsentBidRows) {
      const status = String(row?.status || '(vazio)').toLowerCase();
      unsentStatusCounts[status] = (unsentStatusCounts[status] || 0) + 1;
    }

    const groups = new Map<string, any[]>();
    for (const row of candidates) {
      const key = canonicalKey(row);
      const group = groups.get(key) || [];
      group.push(row);
      groups.set(key, group);
    }

    const canonical: any[] = [];
    let superseded = 0;
    for (const group of groups.values()) {
      group.sort((a, b) => rowTs(b) - rowTs(a));
      const winner = group[0];
      canonical.push(winner);
      for (const older of group.slice(1)) {
        await base44.asServiceRole.entities.OptimizationDecision.update(older.id, {
          status: 'superseded', queue_status: 'completed', confirmation_required: false,
          confirmation_status: 'not_applicable',
          confirmation_error: `SUPERSEDED_BY_AUTOMATIC_BID_DRAIN:${winner.id}`,
          error_message: `SUPERSEDED_BY_AUTOMATIC_BID_DRAIN:${winner.id}`,
          updated_at: new Date().toISOString(),
        }).catch(() => null);
        superseded++;
      }
    }

    canonical.sort((a, b) => rowTs(a) - rowTs(b));
    const selected = canonical.slice(0, maxExecute);
    const results: any[] = [];
    let recoveredLegacy = 0;

    for (const decision of selected) {
      const previousStatus = String(decision.status || '').toLowerCase();
      const previousAction = String(decision.action || '').toLowerCase();
      const patch: any = {};
      if (!['approved', 'executing'].includes(previousStatus)) {
        patch.status = 'approved';
        patch.queue_status = 'pending';
        patch.queue_processed_at = null;
        patch.confirmation_required = false;
        patch.confirmation_status = null;
        patch.confirmation_error = `RECOVERED_UNSENT_LEGACY_DECISION:${previousStatus || 'empty'}`;
        patch.error_message = null;
        recoveredLegacy++;
      }
      if (!EXECUTOR_BID_ACTIONS.has(previousAction)) patch.action = 'update_bid';
      const targetBid = targetBidOf(decision);
      if (!(Number(decision?.value_after) > 0)) patch.value_after = targetBid;
      if (!(Number(decision?.proposed_value) > 0)) patch.proposed_value = targetBid;
      if (Object.keys(patch).length) {
        patch.updated_at = new Date().toISOString();
        await base44.asServiceRole.entities.OptimizationDecision.update(decision.id, patch);
      }

      const response = await base44.asServiceRole.functions.invoke('executePairedManualBidDecision', {
        _service_role: true,
        decision_ids: [decision.id],
        trigger_type: body.trigger_type || 'automatic_bid_decision_drain',
      }).catch((error: any) => ({ ok: false, error: error?.message || String(error) }));
      const data = response?.data || response || {};
      const item = Array.isArray(data?.results) ? data.results[0] : data;
      results.push({
        decision_id: decision.id,
        asin: decision.asin || null,
        keyword_id: decision.keyword_id || null,
        previous_status: previousStatus || null,
        previous_action: previousAction || null,
        ok: item?.ok !== false,
        skipped: Boolean(item?.skipped),
        status: item?.status || null,
        error: item?.error || item?.reason || null,
        amazon_request_ids: item?.request_ids || null,
      });
    }

    const executed = results.filter((item) => item.ok && !item.skipped && item.status === 'confirming').length;
    const failed = results.filter((item) => item.ok === false && !item.skipped).length;
    const skipped = results.filter((item) => item.skipped).length;

    return Response.json({
      ok: failed === 0,
      lookback_hours: lookbackHours,
      raw_recent: recentRows.length,
      status_counts: statusCounts,
      unsent_status_counts: unsentStatusCounts,
      unsent_bid_rows: unsentBidRows.length,
      scanned_recoverable: candidates.length,
      canonical_targets: canonical.length,
      recovered_legacy: recoveredLegacy,
      superseded_duplicates: superseded,
      selected: selected.length,
      executed,
      failed,
      skipped,
      remaining_canonical: Math.max(0, canonical.length - selected.length),
      amazon_mutations_sent: executed,
      results,
    });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || String(error) }, { status: 500 });
  }
});
