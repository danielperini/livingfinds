const STOCK_CAMPAIGN_ALERT_TYPES = new Set([
  'campaign_active_no_stock',
  'campaign_active_without_stock',
]);

function text(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function isStockCampaignAlert(alert) {
  const type = text(alert?.alert_type || alert?.type);
  const title = text(alert?.title);
  const message = text(alert?.message);
  return STOCK_CAMPAIGN_ALERT_TYPES.has(type)
    || (/campanha ativa sem estoque/.test(title))
    || (/campanha ativa/.test(message) && /estoque\s*=\s*0|sem estoque/.test(message));
}

export function belongsToStockCampaignAlert(alert, { asin, productId } = {}) {
  if (!isStockCampaignAlert(alert)) return false;
  const normalizedAsin = text(asin);
  const candidates = [alert?.asin, alert?.entity_id, alert?.product_id, alert?.title, alert?.message]
    .map(text)
    .filter(Boolean);
  return Boolean(
    (normalizedAsin && candidates.some(value => value.includes(normalizedAsin)))
    || (productId && candidates.some(value => value === text(productId) || value.includes(text(productId))))
  );
}

export function planStockCampaignAlertReconciliation(alerts, { asin, productId, activeCampaignCount = 0 } = {}) {
  const matches = (alerts || []).filter(alert => belongsToStockCampaignAlert(alert, { asin, productId }));
  if (activeCampaignCount <= 0) return { keep: null, resolve: matches };

  const sorted = [...matches].sort((left, right) => {
    const leftAt = Date.parse(left?.updated_at || left?.last_detected_at || left?.created_at || 0) || 0;
    const rightAt = Date.parse(right?.updated_at || right?.last_detected_at || right?.created_at || 0) || 0;
    return rightAt - leftAt;
  });
  return { keep: sorted[0] || null, resolve: sorted.slice(1) };
}
