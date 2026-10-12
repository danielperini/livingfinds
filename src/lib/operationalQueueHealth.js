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
