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
  const confirmed = (row) => row.remote_outcome !== 'unknown' && row.status !== 'remote_unknown' &&
    (row.confirmation_status === 'confirmed' || row.amazon_confirmation_status === 'confirmed' || row.amazon_confirmed === true);
  // attempt_count/last_attempt_at also record local gates; they never prove sending.
  const sent = (row) => Boolean(row.amazon_request_id || row.request_id || row.sent_at || row.executed_at || row.remote_outcome === 'sent_unconfirmed' || confirmed(row));
  return { recent_24h: rows.filter(recent).length, historical_total: rows.length,
    blocked: rows.filter((row) => ['blocked', 'remote_unknown'].includes(row.status) || row.remote_outcome === 'unknown').length,
    confirmed: rows.filter(confirmed).length, sent: rows.filter(sent).length,
    unconfirmed: rows.filter((row) => sent(row) && !confirmed(row)).length,
    count_unit: 'decision', pagination_complete: true };
}
