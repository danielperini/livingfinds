const time = value => Date.parse(value || '');
export const ACTIONABLE_ALERT_CLASSES = new Set(['action_required', 'technical_failure', 'remote_unknown']);
export function alertClassification(row, now = Date.now()) {
  const status = String(row.status || '').toLowerCase();
  if (row.remote_outcome === 'unknown' || status === 'remote_unknown' || row.reconciliation === 'pending' || /remote_unknown|remote.*unknown|automatic replay blocked/i.test(String(row.reason_code || '') + ' ' + String(row.error_message || ''))) return 'remote_unknown';
  if (status === 'resolved' || row.resolved_at) return 'resolved';
  if (status === 'stale') return 'stale_without_current_evidence';
  if (row.duplicate_of) return 'duplicate';
  if (['historical', 'suppressed', 'archived'].includes(status)) return 'historical';
  const technical = ['sync_error', 'token_expired', 'scheduler_error', 'technical_failure'].includes(row.alert_type) || row.failure_kind === 'technical';
  const evidence = time(row.evidence_at || row.last_observed_at || row.last_detected_at ||
    (technical ? row.created_at || row.created_date : ''));
  if (!Number.isFinite(evidence) || evidence > now || now - evidence > 24 * 3600000 || row.current_evidence === false ||
      (!technical && row.data_freshness && row.data_freshness !== 'fresh' && row.current_evidence !== true)) return 'stale_without_current_evidence';
  if (technical) return 'technical_failure';
  return 'action_required';
}
export function groupOperationalAlerts(rows, now = Date.now()) {
  const groups = new Map(), history = [];
  for (const row of rows) {
    const classification = alertClassification(row, now);
    if (!ACTIONABLE_ALERT_CLASSES.has(classification)) { history.push({ ...row, classification }); continue; }
    const key = [row.amazon_account_id, row.asin, row.campaign_id || row.entity_id, row.reason_code || row.alert_type || row.title, classification].map(value => String(value || '').trim().toLowerCase()).join('|');
    const group = groups.get(key);
    if (group) { group.occurrences += Number(row.occurrence_count) || 1; group.members.push(row); history.push({ ...row, classification: 'duplicate' }); }
    else groups.set(key, { ...row, classification, occurrences: Number(row.occurrence_count) || 1, members: [row] });
  }
  const active = [...groups.values()];
  return { active: active.filter(row => row.classification !== 'remote_unknown'),
    reconciliation: active.filter(row => row.classification === 'remote_unknown'), history };
}

/** Fresh evaluation alone cannot renew an old proposal or prove an unsent action. */
export function decisionRecoveryEligibility(row, now = Date.now()) {
  if (row.remote_outcome === 'unknown' || row.status === 'remote_unknown' || ['confirmed','sent_unconfirmed'].includes(row.remote_outcome) || ['confirmed','pending_probe'].includes(row.confirmation_status) || row.amazon_confirmed === true ||
      row.sent_at || row.executed_at || row.amazon_request_id || row.request_id) return { safe: false, reason: 'reconciliation_required', requirements: ['remote_state_validation'] };
  const created = time(row.created_at || row.created_date);
  const configured = Number(row.maximum_data_age_minutes || 24 * 60);
  const maxAge = Math.min(24 * 60, Number.isFinite(configured) && configured > 0 ? configured : 24 * 60) * 60000;
  if (!Number.isFinite(created) || created > now || now - created > maxAge) return { safe: false, reason: 'new_collection_and_decision_required',
    requirements: ['new_collection', 'new_evaluation', 'new_authorization', 'remote_state_validation'] };
  const expiry = row.execute_before || row.expires_at;
  if (expiry && (!Number.isFinite(time(expiry)) || time(expiry) <= now)) return { safe: false, reason: 'decision_window_expired',
    requirements: ['new_collection', 'new_evaluation', 'new_authorization', 'remote_state_validation'] };
  return { safe: true, reason: 'fresh_unsent_proposal', requirements: [] };
}

export function schedulerOperationalHealth(state, now = Date.now()) {
  const tick = time(state.last_tick_at);
  const tick_age_seconds = Number.isFinite(tick) ? Math.max(0, Math.floor((now - tick) / 1000)) : null;
  const ticking = Boolean(state.enabled && state.started && state.jobs_loaded > 0 && tick_age_seconds !== null && tick_age_seconds <= 120);
  const errors = Object.values(state.job_errors || {});
  const unresolved = errors.length > 0 || Boolean(state.last_error && (!state.last_success_at || time(state.last_error_at) >= time(state.last_success_at)));
  return { ...state, tick_age_seconds, ticking, healthy: ticking && !unresolved,
    status: !ticking ? 'unavailable' : unresolved ? 'technical_failure' : 'healthy', active_job_errors: errors };
}
