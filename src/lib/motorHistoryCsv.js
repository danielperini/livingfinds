import { deriveMotorDecisionTitle as deriveTitle } from './motorDecisionTitle.js';
import { getDecisionKeywordId, getDecisionKeywordText } from '../../base44/shared/decisionKeywordText.js';

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return `"${text.replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
}

export function buildHistoryCsv(items) {
  /** @type {Array<[string, (item: any) => any]>} */
  const columns = [
    ['data_hora', item => item.timestamp],
    ['fonte', item => item.source],
    ['titulo', item => deriveTitle(item.raw)],
    ['asin', item => item.raw?.asin],
    ['sku', item => item.raw?.sku],
    ['campaign_id', item => item.raw?.campaign_id || item.raw?.amazon_campaign_id],
    ['campaign_name', item => item.raw?.campaign_name],
    ['keyword_id', item => getDecisionKeywordId(item.raw)],
    ['keyword_text', item => getDecisionKeywordText(item.raw)],
    ['decision_type', item => item.raw?.decision_type],
    ['action', item => item.raw?.action],
    ['status', item => item.raw?.status],
    ['queue_status', item => item.raw?.queue_status],
    ['confirmation_status', item => item.raw?.amazon_confirmation_status || item.raw?.confirmation_status],
    ['risk', item => item.raw?.risk],
    ['confidence', item => item.raw?.confidence],
    ['value_before', item => item.raw?.value_before],
    ['value_after', item => item.raw?.value_after],
    ['change_pct', item => item.raw?.change_pct ?? item.raw?.bid_change_pct],
    ['reason_code', item => item.raw?.reason_code],
    ['rule_key', item => item.raw?.rule_key],
    ['rationale', item => item.raw?.rationale || item.raw?.reason],
    ['id', item => item.raw?.id || item.id],
  ];
  const header = columns.map(([name]) => csvCell(name)).join(';');
  const rows = items.map(item => columns.map(([, getter]) => csvCell(getter(item))).join(';'));
  return `\uFEFF${[header, ...rows].join('\n')}`;
}
