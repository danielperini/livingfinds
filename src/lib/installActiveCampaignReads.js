import { base44 } from '@/api/base44Client';

const ARCHIVED_STATES = new Set(['archived', 'archive', 'arquivada', 'arquivado']);

function isArchivedCampaign(campaign) {
  const candidates = [
    campaign?.state,
    campaign?.status,
    campaign?.amazon_state,
    campaign?.campaign_state,
    campaign?.serving_status,
  ];

  return candidates.some((value) => ARCHIVED_STATES.has(String(value || '').trim().toLowerCase())) ||
    campaign?.archived === true ||
    campaign?.is_archived === true ||
    Boolean(campaign?.archived_at);
}

function onlyActiveCampaigns(rows) {
  return Array.isArray(rows) ? rows.filter((campaign) => !isArchivedCampaign(campaign)) : rows;
}

/**
 * Remove campanhas arquivadas de todas as leituras visuais do frontend.
 * Não apaga nem altera registros persistidos e não interfere nas rotinas de auditoria/backend.
 */
export function installActiveCampaignReads() {
  if (typeof window === 'undefined' || window.__livingfindsActiveCampaignReadsInstalled) return;

  const entity = base44?.entities?.Campaign;
  if (!entity) return;

  window.__livingfindsActiveCampaignReadsInstalled = true;

  if (typeof entity.filter === 'function') {
    const originalFilter = entity.filter.bind(entity);
    entity.filter = async (...args) => onlyActiveCampaigns(await originalFilter(...args));
  }

  if (typeof entity.list === 'function') {
    const originalList = entity.list.bind(entity);
    entity.list = async (...args) => onlyActiveCampaigns(await originalList(...args));
  }
}
