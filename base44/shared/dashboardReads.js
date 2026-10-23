/** The Hostinger adapter uses filter(queryObject, sortString, limit, offset). */
export async function readAllDashboardPages(repo, { filter = {}, sort = 'id', pageSize = 250, maxPages = 1000 } = {}) {
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) throw new TypeError('Dashboard filter must be an object');
  if (typeof sort !== 'string') throw new TypeError('Dashboard sort must be a string');
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 250) throw new TypeError('Invalid dashboard page size');
  const rows = [], seen = new Set();
  for (let page = 0; page < maxPages; page++) {
    const batch = await repo.filter(filter, sort, pageSize, page * pageSize);
    if (!Array.isArray(batch)) throw new Error('Dashboard returned an invalid page');
    for (const row of batch) {
      if (!row?.id || seen.has(String(row.id))) throw new Error('Dashboard pagination incomplete: repeated or missing ID');
      seen.add(String(row.id)); rows.push(row);
    }
    if (batch.length < pageSize) return rows;
  }
  throw new Error('Dashboard pagination incomplete: page limit reached');
}

export function dashboardDecisionCounts(decisions, now = Date.now()) {
  const rows = [...new Map(decisions.filter((row) => row?.id).map((row) => [row.id, row])).values()];
  const recent = (row) => {
    const at = Date.parse(row.created_at || row.created_date || row.evaluated_at || '');
    return Number.isFinite(at) && at <= now && at >= now - 86400000;
  };
  // attempt_count/last_attempt_at also record local gates; they never prove sending.
  const outcomes = rows.map(row => classifyDecisionEvidence(row));
  const recentCount = rows.filter(recent).length;
  const staleUnsent = rows.filter((row, index) => !recent(row) && ['not_sent', 'insufficient_evidence'].includes(outcomes[index]));
  const hasSendEvidence = (row, outcome) => ['sent_and_confirmed', 'partially_confirmed', 'rejected', 'sent_without_confirmation'].includes(outcome) ||
    (outcome === 'remote_unknown' && Boolean(row.amazon_request_id || row.request_id || row.sent_at || row.executed_at));
  return { recent_24h: recentCount, historical_total: rows.length,
    last_decision_at: rows.map(row => row.created_at || row.created_date).filter(value => Number.isFinite(Date.parse(value))).sort((a,b) => Date.parse(b)-Date.parse(a))[0] || null,
    stale: rows.length - recentCount, historical: rows.length - recentCount,
    requires_new_collection: staleUnsent.length,
    not_sent: outcomes.filter(outcome => outcome === 'not_sent').length,
    insufficient_evidence: outcomes.filter(outcome => outcome === 'insufficient_evidence').length,
    confirmed_not_sent: outcomes.filter(outcome => outcome === 'not_sent').length,
    blocked: rows.filter((row) => ['blocked', 'remote_unknown'].includes(row.status) || row.remote_outcome === 'unknown').length,
    confirmed: outcomes.filter(outcome => outcome === 'sent_and_confirmed').length,
    partially_confirmed: outcomes.filter(outcome => outcome === 'partially_confirmed').length,
    rejected: outcomes.filter(outcome => outcome === 'rejected').length,
    remote_unknown: outcomes.filter(outcome => outcome === 'remote_unknown').length,
    sent: rows.filter((row, index) => hasSendEvidence(row, outcomes[index])).length,
    sent_without_confirmation: outcomes.filter(outcome => outcome === 'sent_without_confirmation').length,
    unconfirmed: outcomes.filter(outcome => outcome === 'sent_without_confirmation').length,
    count_unit: 'decision', pagination_complete: true };
}

export function classifyDecisionEvidence(row = {}) {
  const remoteUnknown = row.remote_outcome === 'unknown' || row.status === 'remote_unknown' || row.confirmation_status === 'pending_probe';
  if (remoteUnknown) return 'remote_unknown';
  if (row.confirmation_status === 'confirmed' || row.amazon_confirmation_status === 'confirmed' || row.amazon_confirmed === true || row.remote_outcome === 'confirmed') return 'sent_and_confirmed';
  if (row.remote_outcome === 'partially_confirmed' || row.confirmation_status === 'partial') return 'partially_confirmed';
  if (row.remote_outcome === 'rejected' || row.status === 'rejected' || row.execution_status === 'rejected' || row.confirmation_status === 'rejected') return 'rejected';
  if (row.amazon_request_id || row.request_id || row.sent_at || row.executed_at || row.remote_outcome === 'sent_unconfirmed') return 'sent_without_confirmation';
  if (row.remote_outcome === 'not_attempted' || row.execution_status === 'not_sent' || row.status === 'not_sent') return 'not_sent';
  return 'insufficient_evidence';
}
