import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';

const BID_ACTIONS = new Set(['set_bid', 'increase_bid', 'reduce_bid', 'update_bid']);
const RECOVERABLE_STATUSES = ['approved', 'executing', 'executed'];
const OBSERVED_STATUSES = [
  'approved', 'executing', 'pending', 'queued', 'ready', 'proposed', 'created',
  'confirming', 'executed', 'completed', 'failed', 'blocked', 'cancelled',
  'skipped', 'superseded', 'expired', 'rejected',
];

function rowTs(row: any): number {
  const raw = row?.created_at || row?.created_date || row?.evaluated_at || row?.updated_at || 0;
  const value = Date.parse(String(raw));
  return Number.isFinite(value) ? value : 0;
}

function hasAmazonExecutionEvidence(row: any): boolean {
  // Nunca considere apenas status/last_attempt_at/attempt_count como prova de envio.
  // O bug que gerou a fila atual marcou centenas de decisões como "executed"
  // sem request/response/executed_at da Amazon.
  return Boolean(row?.amazon_request_id || row?.amazon_response || row?.executed_at);
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

function isRecoverableNow(row: any): boolean {
  const status = String(row?.status || '').toLowerCase();
  if (!RECOVERABLE_STATUSES.includes(status)) return false;
  if (hasAmazonExecutionEvidence(row)) return false;
  if (status !== 'executing') return true;
  const attemptTs = Date.parse(String(row?.last_attempt_at || row?.updated_at || row?.created_at || 0));
  return !Number.isFinite(attemptTs) || attemptTs < Date.now() - 20 * 60_000;
}

async function loadStatus(base44: any, status: string, accountId: string, limit: number) {
  return base44.asServiceRole.entities.OptimizationDecision.filter(
    accountId ? { amazon_account_id: accountId, status } : { status },
    '-created_at',
    limit,
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
    const perStatusLimit = Math.max(50, Math.min(1000, Number(body.scan_limit || 500)));
    const cutoff = Date.now() - lookbackHours * 3600_000;

    const observedBatches = await Promise.all(
      OBSERVED_STATUSES.map(async (status) => [status, await loadStatus(base44, status, accountId, perStatusLimit)] as const),
    );
    const statusCounts: Record<string, number> = {};
    const phantomCounts: Record<string, number> = {};
    for (const [status, rows] of observedBatches) {
      const recentBidRows = rows.filter((row: any) =>
        BID_ACTIONS.has(String(row?.action || '')) && rowTs(row) >= cutoff
      );
      statusCounts[status] = recentBidRows.length;
      phantomCounts[status] = recentBidRows.filter((row: any) => !hasAmazonExecutionEvidence(row)).length;
    }

    // Recupera inclusive o estado "executed" fantasma: decisão marcada como executada
    // internamente, porém sem qualquer evidência de request/response/executed_at na Amazon.
    const candidates = observedBatches
      .filter(([status]) => RECOVERABLE_STATUSES.includes(status))
      .flatMap(([, rows]) => rows)
      .filter((row: any) => BID_ACTIONS.has(String(row?.action || '')))
      .filter((row: any) => rowTs(row) >= cutoff)
      .filter((row: any) => isRecoverableNow(row));

    // Nunca reproduz centenas de decisões repetidas. Para cada alvo real, só a decisão
    // mais recente sobrevive; as anteriores viram superseded antes de qualquer mutação.
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
          status: 'superseded',
          queue_status: 'completed',
          confirmation_required: false,
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
    let recoveredPhantomExecuted = 0;

    for (const decision of selected) {
      const previousStatus = String(decision.status || '').toLowerCase();

      // O executor canônico só aceita approved/executing. Uma decisão "executed"
      // sem evidência Amazon é reaberta de forma explícita e auditável antes do envio.
      if (previousStatus === 'executed') {
        await base44.asServiceRole.entities.OptimizationDecision.update(decision.id, {
          status: 'approved',
          queue_status: 'pending',
          queue_processed_at: null,
          confirmation_required: false,
          confirmation_status: 'not_applicable',
          confirmation_error: 'RECOVERED_PHANTOM_EXECUTED_WITHOUT_AMAZON_EVIDENCE',
          error_message: null,
          updated_at: new Date().toISOString(),
        });
        recoveredPhantomExecuted++;
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
        previous_status: previousStatus,
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
      status_counts: statusCounts,
      phantom_counts: phantomCounts,
      scanned_recoverable: candidates.length,
      canonical_targets: canonical.length,
      recovered_phantom_executed: recoveredPhantomExecuted,
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
