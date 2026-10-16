import { getDecisionKeywordText, getDecisionKeywordId } from '../../base44/shared/decisionKeywordText.js';

export function deriveMotorDecisionTitle(raw) {
  const text = getDecisionKeywordText(raw);
  if (text) return text;
  const id = getDecisionKeywordId(raw);
  if (id) return `Keyword ID: ${id}`;
  if (raw?.asin) return raw.asin;
  if (raw?.entity_name && raw.entity_type && raw.entity_type !== 'keyword') return raw.entity_name;
  if (raw?.campaign_name) return raw.campaign_name;
  if (raw?.campaign_id) return `Campanha ${raw.campaign_id}`;
  if (raw?.entity_id) return `${raw?.entity_type === 'campaign' ? 'Campanha' : 'Entidade'} ${raw.entity_id}`;
  return 'Decisão do motor';
}
