function normalized(value) {
  return String(value ?? '').trim().toLowerCase();
}

function alertIdentity(alert) {
  const rawType = normalized(alert?.alert_type || alert?.type || 'alert');
  const type = ({
    campaign_active_without_stock: 'campaign_active_no_stock',
    restock_detected: 'restock_event',
    out_of_stock: 'stock_unavailable',
    low_stock: 'stock_unavailable',
  })[rawType] || rawType;
  const searchable = [alert?.asin, alert?.entity_id, alert?.title, alert?.message].map(value => String(value ?? '')).join(' ');
  const asin = normalized(searchable.match(/\b[A-Z0-9]{10}\b/i)?.[0]);
  const campaign = normalized(alert?.campaign_id || alert?.entity_id);
  const entity = type === 'campaign_paused' ? campaign || asin : asin || campaign || normalized(alert?.entity_type);
  return [normalized(alert?.amazon_account_id), type, entity].join('::');
}

function freshness(alert) {
  return Date.parse(alert?.updated_at || alert?.last_detected_at || alert?.created_at || alert?.created_date || 0) || 0;
}

export function deduplicateOperationalAlerts(alerts = []) {
  const latestByIdentity = new Map();
  for (const alert of alerts) {
    // Historical writers used several incompatible keys for the same ASIN.
    // Use the normalized business identity so duplicates do not reappear just
    // because one producer used SKU/product ID and another used ASIN.
    const key = alertIdentity(alert);
    const current = latestByIdentity.get(key);
    if (!current || freshness(alert) > freshness(current)) latestByIdentity.set(key, alert);
  }
  return [...latestByIdentity.values()].sort((a, b) => freshness(b) - freshness(a));
}

export function isActionableOperationalAlert(alert) {
  const type = normalized(alert?.alert_type || alert?.type);
  const content = `${alert?.title || ''} ${alert?.message || ''}`;
  if (type === 'restock_detected' || /reabastecimento detectado|campanha pausada:/i.test(content)) return false;
  if (['out_of_stock', 'low_stock', 'critical_stock'].includes(type) && /ads pausados/i.test(content)) return false;
  return true;
}
