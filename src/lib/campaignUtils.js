/**
 * campaignUtils — Utilitários de carregamento, reconciliação e classificação
 * de campanhas Amazon Ads.
 *
 * Regras centrais:
 * - carregar todas as páginas da entidade Campaign;
 * - não ocultar campanhas por flags locais durante reconciliação explícita;
 * - deduplicar apenas representações locais do mesmo campaignId Amazon;
 * - priorizar o estado operacional mais recentemente persistido pelo app
 *   (`state`/`status`) antes de campos legados que podem ficar obsoletos;
 * - nunca transformar ausência de estado em arquivamento.
 */

import { base44 } from '@/api/base44Client';

const PAGE_SIZE = 500;
const MAX_PAGES = 200;

function timestampOf(campaign = {}) {
  const values = [
    campaign.last_api_sync_at,
    campaign.last_sync_at,
    campaign.synced_at,
    campaign.updated_at,
    campaign.updated_date,
    campaign.created_at,
    campaign.created_date,
  ];
  for (const value of values) {
    const timestamp = new Date(value || 0).getTime();
    if (Number.isFinite(timestamp) && timestamp > 0) return timestamp;
  }
  return 0;
}

function campaignIdentity(campaign = {}) {
  const amazonId = String(
    campaign.campaign_id || campaign.amazon_campaign_id || ''
  ).trim();
  if (amazonId) return `amazon:${amazonId}`;

  const localId = String(campaign.id || '').trim();
  return localId ? `local:${localId}` : '';
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function mergeCampaignRecords(current, candidate) {
  const currentTs = timestampOf(current);
  const candidateTs = timestampOf(candidate);
  const newer = candidateTs >= currentTs ? candidate : current;
  const older = newer === candidate ? current : candidate;

  const merged = { ...older, ...newer };

  // Estado e identificadores: usar o registro mais recente, mas preencher lacunas.
  merged.state = firstDefined(newer.state, newer.status, older.state, older.status);
  merged.status = firstDefined(newer.status, newer.state, older.status, older.state);
  merged.amazon_status = firstDefined(
    newer.amazon_status,
    older.amazon_status,
    newer.campaign_status,
    older.campaign_status
  );
  merged.campaign_id = firstDefined(newer.campaign_id, older.campaign_id);
  merged.amazon_campaign_id = firstDefined(
    newer.amazon_campaign_id,
    older.amazon_campaign_id,
    merged.campaign_id
  );

  // Preservar métricas do registro mais rico. Sincronização de estado não deve
  // zerar dados históricos válidos do Dashboard.
  const metricFields = [
    'spend', 'sales', 'acos', 'roas', 'clicks', 'impressions', 'orders',
    'units', 'cpc', 'ctr', 'conversion_rate', 'daily_budget',
  ];
  for (const field of metricFields) {
    const newerValue = Number(newer[field]);
    const olderValue = Number(older[field]);
    const newerValid = Number.isFinite(newerValue) && newerValue !== 0;
    const olderValid = Number.isFinite(olderValue) && olderValue !== 0;
    if (!newerValid && olderValid) merged[field] = older[field];
  }

  return merged;
}

export async function loadAllCampaigns(amazonAccountId, extraFilter = {}, options = {}) {
  const { includeExcluded = false } = options;
  const allCampaigns = [];
  let offset = 0;
  let pageNumber = 0;
  let previousPageSignature = '';

  while (pageNumber < MAX_PAGES) {
    const page = await base44.entities.Campaign.filter(
      { amazon_account_id: amazonAccountId, ...extraFilter },
      '-created_date',
      PAGE_SIZE,
      offset
    );

    if (!Array.isArray(page) || page.length === 0) break;

    // Proteção contra backends que ignoram offset e retornam a mesma página.
    const pageSignature = page
      .map((campaign) => campaignIdentity(campaign))
      .filter(Boolean)
      .join('|');
    if (pageNumber > 0 && pageSignature && pageSignature === previousPageSignature) break;

    allCampaigns.push(...page);
    previousPageSignature = pageSignature;
    pageNumber += 1;

    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  const byCampaignId = new Map();
  allCampaigns.forEach((campaign) => {
    if (!includeExcluded && (
      campaign.api_missing === true || campaign.excluded_from_dashboard === true
    )) return;

    const identity = campaignIdentity(campaign);
    if (!identity) return;

    const current = byCampaignId.get(identity);
    byCampaignId.set(
      identity,
      current ? mergeCampaignRecords(current, campaign) : campaign
    );
  });

  return [...byCampaignId.values()];
}

function booleanTrue(value) {
  if (value === true || value === 1) return true;
  return ['true', '1', 'yes', 'sim'].includes(String(value ?? '').trim().toLowerCase());
}

export function normalizeState(rawState = '') {
  const state = String(rawState ?? '').trim().toLowerCase();
  if (['enabled', 'active', 'ativa', 'ativada', 'running', 'live', 'serving'].includes(state)) return 'enabled';
  if (['paused', 'pausada', 'inactive', 'inativa', 'disabled'].includes(state)) return 'paused';
  if (['archived', 'ended', 'deleted', 'encerrada', 'removed'].includes(state)) return 'archived';
  if (['incomplete', 'draft', 'pending', 'pending_insertion', 'em inserção', 'em insercao', 'processing'].includes(state)) return 'incomplete';
  return state;
}

export function campaignState(campaign = {}) {
  // `state` e `status` são atualizados pelas ações e reconciliações atuais do
  // app. `amazon_status` é mantido como fallback por compatibilidade, pois
  // registros legados podem deixá-lo obsoleto após uma reativação.
  const candidates = [
    campaign.state,
    campaign.status,
    campaign.campaign_status,
    campaign.amazon_status,
    campaign.serving_status,
    campaign.original_state,
    // Legacy fallback only: freshly synchronized state/status win.
    campaign.amazon_status,
  ];

  for (const candidate of candidates) {
    const normalized = normalizeState(candidate);
    if (normalized) return normalized;
  }
  return '';
}

export function campaignIsArchived(campaign = {}) {
  if (booleanTrue(campaign.archived)) return true;
  return campaignState(campaign) === 'archived';
}

export function campaignIsVisibleOperational(campaign = {}) {
  if (campaignIsArchived(campaign)) return false;
  const state = campaignState(campaign);
  return state === 'enabled' || state === 'paused' || state === 'incomplete';
}

export function classifyCampaigns(campaigns = []) {
  const enabled = [];
  const pending = [];
  const paused = [];
  const archived = [];
  const other = [];

  campaigns.forEach((campaign) => {
    if (campaign.api_missing === true || campaign.excluded_from_dashboard === true) return;
    const state = campaignState(campaign);
    if (campaignIsArchived(campaign)) archived.push(campaign);
    else if (state === 'enabled') enabled.push(campaign);
    else if (state === 'incomplete') pending.push(campaign);
    else if (state === 'paused') paused.push(campaign);
    else other.push(campaign);
  });

  // Ativa significa efetivamente habilitada. Incompletas permanecem separadas
  // para reparo/arquivamento e não inflam o total ativo.
  const active = [...enabled];
  return {
    active,
    enabled,
    pending,
    paused,
    archived,
    other,
    total_current: enabled.length + pending.length + paused.length,
    active_count: enabled.length,
    enabled_count: enabled.length,
    pending_count: pending.length,
    paused_count: paused.length,
    archived_count: archived.length,
    other_count: other.length,
    total_all: enabled.length + pending.length + paused.length + archived.length + other.length,
  };
}

export function getAutopilotEligible(campaigns = []) {
  return campaigns.filter((campaign) =>
    !campaignIsArchived(campaign) &&
    campaign.api_missing !== true &&
    campaign.excluded_from_dashboard !== true &&
    ['enabled', 'paused'].includes(campaignState(campaign))
  );
}
