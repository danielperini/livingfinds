const RETRYABLE_QUEUE_ERROR = /(\b429\b|rate.?limit|throttl|timeout|timed.?out|network|temporar|\b502\b|\b503\b|\b504\b|\b524\b|connection reset|circuit.?open)/i;

export function isWithinHours(value, hours, now = Date.now()) {
  const timestamp = new Date(value || 0).getTime();
  return Number.isFinite(timestamp) && timestamp >= now - hours * 60 * 60 * 1000;
}

export function queueTimestamp(item) {
  return item?.updated_at || item?.updated_date || item?.completed_at || item?.started_at || item?.scheduled_at || item?.created_at || item?.created_date || null;
}

export function isRetryableQueueFailure(item) {
  const attempts = Number(item?.attempt_count || 0);
  const maxAttempts = Math.max(1, Number(item?.max_attempts || 5));
  const error = `${item?.last_error || ''} ${item?.error_code || ''} ${item?.error_message || ''}`;
  return attempts < maxAttempts && (item?.retryable === true || RETRYABLE_QUEUE_ERROR.test(error));
}

export function isSafetyBlockedQueue(item, product) {
  const status = String(item?.status || '').toLowerCase();
  if (status === 'waiting_stock') return true;
  if (status === 'cancelled' && /waiting_stock|out_of_stock|ads_scope_not_authorized|ads_product_not_eligible|campaign_inactive_queue_cleaned|product_missing_queue_cleaned/i.test(`${item?.error_code || ''} ${item?.last_error || ''}`)) return true;
  const scope = String(product?.ads_scope_status || '').toLowerCase();
  if (['not_authorized', 'manual_block', 'mapping_conflict'].includes(scope)) return true;
  if (!product) return false;
  const stock = Number(product.fulfillable_quantity ?? product.available_quantity ?? product.inventory_quantity ?? product.stock ?? product.fba_inventory);
  return Number.isFinite(stock) && stock <= 0;
}

export function summarizeOperationalQueue(items, productForItem, now = Date.now()) {
  const retryingQueue = items.filter(item => item.status === 'failed' && isRetryableQueueFailure(item));
  const failedQueue = items.filter(item => item.status === 'failed' && isWithinHours(queueTimestamp(item), 24, now)
    && !isSafetyBlockedQueue(item, productForItem(item)) && !isRetryableQueueFailure(item));
  const pendingQueue = items.filter(item =>
    (['scheduled', 'processing'].includes(item.status) && isWithinHours(queueTimestamp(item), 2, now)) || retryingQueue.includes(item)
  );
  const safetyBlockedQueue = items.filter(item => isSafetyBlockedQueue(item, productForItem(item)));
  const historicalQueue = items.filter(item =>
    (['scheduled', 'processing'].includes(item.status) && !isWithinHours(queueTimestamp(item), 2, now)) ||
    (item.status === 'failed' && !isWithinHours(queueTimestamp(item), 24, now) && !retryingQueue.includes(item)) ||
    ['completed', 'cancelled', 'waiting_stock'].includes(String(item.status || '').toLowerCase())
  ).filter(item => !safetyBlockedQueue.includes(item));
  return { failedQueue, pendingQueue, retryingQueue, safetyBlockedQueue, historicalQueue };
}

export function safeQueueError(item) {
  const raw = String(item?.last_error || item?.error_message || item?.error_code || 'Erro sem detalhe registrado');
  return raw
    .replace(/Atzr\|[A-Za-z0-9._-]+/g, '[token ocultado]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [token ocultado]')
    .replace(/(client_secret|refresh_token|access_token|authorization)(\s*[:=]\s*)[^\s,;]+/gi, '$1$2[ocultado]')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 240);
}


const TERMINAL_DECISION_STATES = new Set([
  'confirmed', 'executed', 'completed', 'cancelled', 'canceled', 'rejected',
  'expired', 'skipped', 'blocked', 'failed', 'failed_final', 'superseded', 'rolled_back',
]);
const EXECUTABLE_DECISION_STATES = new Set([
  'approved', 'waiting_retry', 'scheduled', 'executing',
]);
const ACTIVE_DECISION_QUEUE_STATES = new Set([
  'pending', 'scheduled', 'queued', 'processing', 'retrying',
]);

/** Alert only on work that can be sent/retried and is actually past due. */
export function isDecisionQueueOverdue(decision, now = Date.now(), graceMinutes = 15) {
  const status = String(decision?.status || '').trim().toLowerCase();
  const queueStatus = String(decision?.queue_status || '').trim().toLowerCase();
  const approval = String(decision?.approval_status || '').trim().toLowerCase();

  if (TERMINAL_DECISION_STATES.has(status) || TERMINAL_DECISION_STATES.has(queueStatus)) return false;
  if (status === 'pending_approval' || decision?.execution_mode === 'MANUAL_REVIEW') return false;
  if (decision?.requires_approval === true && !['approved', 'auto_approved', 'approved_by_user'].includes(approval)) return false;

  const executable = EXECUTABLE_DECISION_STATES.has(status);
  if (!executable) return false;
  if (queueStatus && !ACTIVE_DECISION_QUEUE_STATES.has(queueStatus)) return false;

  const dueValue = decision?.next_retry_at || decision?.scheduled_for || decision?.not_before;
  const dueAt = dueValue ? new Date(dueValue).getTime() : NaN;
  if (Number.isFinite(dueAt) && dueAt > now) return false;

  const reference = dueValue || decision?.queued_at || decision?.approved_at ||
    decision?.last_attempt_at || decision?.updated_at || decision?.updated_date ||
    decision?.created_at || decision?.created_date;
  const timestamp = new Date(reference || 0).getTime();
  return Number.isFinite(timestamp) && timestamp > 0 &&
    now - timestamp >= Math.max(0, Number(graceMinutes) || 0) * 60_000;
}
