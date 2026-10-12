export type V6SIADecisionLike = {
  id?: string;
  status?: string;
  confirmation_status?: string;
  action?: string;
  entity_type?: string;
  entity_id?: string;
  amazon_response_code?: number;
  error_message?: string;
};

const CONFIRMED = new Set(['executed', 'completed']);
const FAILED = new Set(['blocked', 'failed', 'failed_final', 'cancelled', 'expired']);

export function v6siaImplementationStatus(
  decisions: V6SIADecisionLike[],
): 'implemented' | 'partial' | 'not_implemented' | 'pending_confirmation' | 'not_applicable' {
  if (!decisions.length) return 'not_applicable';
  const confirmed = decisions.filter((item) =>
    CONFIRMED.has(String(item.status || '').toLowerCase()) &&
    String(item.confirmation_status || '').toLowerCase() === 'confirmed'
  ).length;
  if (confirmed === decisions.length) return 'implemented';
  if (confirmed > 0) return 'partial';
  const pending = decisions.some((item) =>
    ['proposed', 'pending', 'approved', 'scheduled', 'executing', 'confirming', 'waiting_retry', 'conflict_reconciling', 'pending_approval'].includes(
      String(item.status || '').toLowerCase()
    ) || ['pending', 'pending_probe'].includes(String(item.confirmation_status || '').toLowerCase())
  );
  if (pending) return 'pending_confirmation';
  return 'not_implemented';
}

export function latestRowsByKey<T extends Record<string, unknown>>(
  rows: T[],
  keyOf: (row: T) => string,
  timestampOf: (row: T) => string | null | undefined,
): T[] {
  const latest = new Map<string, T>();
  for (const row of rows) {
    const key = keyOf(row);
    if (!key) continue;
    const current = latest.get(key);
    const nextTime = Date.parse(String(timestampOf(row) || ''));
    const currentTime = Date.parse(String(current ? timestampOf(current) || '' : ''));
    if (!current || (Number.isFinite(nextTime) && (!Number.isFinite(currentTime) || nextTime >= currentTime))) {
      latest.set(key, row);
    }
  }
  return [...latest.values()];
}

export function v6siaDecisionOutcome(decision: V6SIADecisionLike) {
  const status = String(decision.status || 'unknown').toLowerCase();
  const confirmation = String(decision.confirmation_status || 'not_recorded').toLowerCase();
  return {
    decision_id: String(decision.id || ''),
    action: String(decision.action || ''),
    entity_type: String(decision.entity_type || ''),
    entity_id: String(decision.entity_id || ''),
    decision_status: status,
    confirmation_status: confirmation,
    implementation_status: CONFIRMED.has(status) && confirmation === 'confirmed'
      ? 'implemented'
      : FAILED.has(status) ? 'not_implemented'
      : 'pending_confirmation',
    amazon_response_code: Number.isFinite(Number(decision.amazon_response_code))
      ? Number(decision.amazon_response_code) : null,
    error: decision.error_message ? String(decision.error_message).slice(0, 500) : null,
  };
}
