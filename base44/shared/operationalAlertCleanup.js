const STOCK_TYPES = new Set(['out_of_stock', 'low_stock', 'critical_stock']);
const STOCK_CAMPAIGN_TYPES = new Set(['campaign_active_no_stock', 'campaign_active_without_stock']);

const value = input => String(input ?? '').trim();
const upper = input => value(input).toUpperCase();

export function getAlertAsin(alert) {
  const explicit = upper(alert?.asin);
  if (/^[A-Z0-9]{10}$/.test(explicit)) return explicit;
  const text = [alert?.entity_id, alert?.title, alert?.message].map(value).join(' ');
  return upper(text.match(/\b[A-Z0-9]{10}\b/i)?.[0]);
}

export function getAlertSku(alert) {
  return upper(alert?.sku || alert?.seller_sku || alert?.m_sku);
}

export function operationalAlertIdentity(alert) {
  const rawType = value(alert?.alert_type || alert?.type).toLowerCase();
  const type = STOCK_TYPES.has(rawType) ? 'stock_unavailable'
    : STOCK_CAMPAIGN_TYPES.has(rawType) ? 'campaign_active_no_stock'
      : rawType;
  const asin = getAlertAsin(alert);
  const sku = getAlertSku(alert);
  const campaign = value(alert?.campaign_id || alert?.entity_id);
  const entity = type === 'campaign_paused' ? campaign || asin : sku || asin || campaign || value(alert?.entity_type);
  return [value(alert?.amazon_account_id), type, entity].join('::').toLowerCase();
}

/** @param {any} alert
 *  @param {{ product?: any, availableFbaQuantity?: number, linkedCampaignStates?: string[] }} [options]
 */
export function planOperationalAlertCleanup(alert, { product, availableFbaQuantity, linkedCampaignStates = [] } = {}) {
  const type = value(alert?.alert_type || alert?.type).toLowerCase();
  const states = linkedCampaignStates.map(state => value(state).toLowerCase());
  const allCampaignsPaused = states.length > 0 && states.every(state => state === 'paused' || state === 'archived');

  if (type === 'restock_detected') return { resolve: true, reason: 'informational_event_archived' };
  if (type === 'campaign_paused' && states.length === 1 && states[0] === 'paused') {
    return { resolve: true, reason: 'amazon_pause_confirmed' };
  }
  if (STOCK_TYPES.has(type) || STOCK_CAMPAIGN_TYPES.has(type)) {
    const available = Number(availableFbaQuantity ?? product?.fba_inventory);
    if (Number.isFinite(available) && available > 0) return { resolve: true, reason: 'stock_restored' };
    if (Number.isFinite(available) && available === 0 && allCampaignsPaused) {
      return { resolve: true, reason: 'amazon_pause_confirmed' };
    }
  }
  return { resolve: false, reason: null };
}

export function deduplicateActiveAlerts(alerts = []) {
  const latest = new Map();
  for (const alert of alerts) {
    const key = operationalAlertIdentity(alert);
    const current = latest.get(key);
    const timestamp = row => Date.parse(row?.updated_at || row?.last_detected_at || row?.created_at || row?.created_date || 0) || 0;
    if (!current || timestamp(alert) > timestamp(current)) latest.set(key, alert);
  }
  return [...latest.values()];
}
