/**
 * campaignUtils — Utilitários de carregamento e classificação de campanhas
 * Regra: nunca usar um número fixo como contagem esperada de campanhas.
 * Paginação real — busca até não existirem mais resultados.
 */

import { base44 } from '@/api/base44Client';

const PAGE_SIZE = 200;

function timestampOf(campaign = {}) {
  const values = [
    campaign.last_api_sync_at,
    campaign.last_sync_at,
    campaign.synced_at,
    campaign.updated_at,
    campaign.created_at,
    campaign.created_date,
  ];

  for (const value of values) {
    const timestamp = new Date(value || 0).getTime();
    if (Number.isFinite(timestamp) && timestamp > 0) return timestamp;
  }
  return 0;
}

/**
 * Carrega todas as campanhas da conta e consolida duplicidades pelo ID Amazon.
 * Quando existem cópias do mesmo campaign_id, mantém o registro sincronizado mais recentemente.
 */
export async function loadAllCampaigns(amazonAccountId, extraFilter = {}) {
  const allCampaigns = [];
  let offset = 0;

  while (true) {
    const page = await base44.entities.Campaign.filter(
      { amazon_account_id: amazonAccountId, ...extraFilter },
      '-created_date',
      PAGE_SIZE,
      offset
    );
    allCampaigns.push(...page);
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  const byCampaignId = new Map();
  const withoutAmazonId = [];

  allCampaigns.forEach((campaign) => {
    const campaignId = String(campaign?.campaign_id || campaign?.amazon_campaign_id || '').trim();
    if (!campaignId) {
      withoutAmazonId.push(campaign);
      return;
    }

    const current = byCampaignId.get(campaignId);
    if (!current || timestampOf(campaign) >= timestampOf(current)) {
      byCampaignId.set(campaignId, campaign);
    }
  });

  return [...byCampaignId.values(), ...withoutAmazonId];
}

function booleanTrue(value) {
  if (value === true || value === 1) return true;
  return ['true', '1', 'yes', 'sim'].includes(String(value ?? '').trim().toLowerCase());
}

/**
 * Normaliza todos os campos de estado usados pelas diferentes rotas de sync.
 * Prioriza amazon_status, pois representa o estado devolvido pela Amazon no sync mais recente.
 */
export function campaignState(campaign = {}) {
  const candidates = [
    campaign.amazon_status,
    campaign.state,
    campaign.status,
    campaign.campaign_status,
    campaign.serving_status,
    campaign.original_state,
  ];

  for (const candidate of candidates) {
    const normalized = normalizeState(candidate);
    if (normalized) return normalized;
  }

  return '';
}

export function campaignIsArchived(campaign = {}) {
  return booleanTrue(campaign.archived) || campaignState(campaign) === 'archived';
}

/**
 * Classifica campanhas em grupos operacionais.
 * archived = estado Amazon 'archived' OU campo archived=true.
 * total_current = active + paused.
 */
export function classifyCampaigns(campaigns = []) {
  const active = [];
  const paused = [];
  const archived = [];
  const other = [];

  campaigns.forEach((campaign) => {
    const state = campaignState(campaign);

    if (campaignIsArchived(campaign) || campaign.excluded_from_dashboard === true) {
      archived.push(campaign);
    } else if (state === 'enabled') {
      active.push(campaign);
    } else if (state === 'paused') {
      paused.push(campaign);
    } else {
      other.push(campaign);
    }
  });

  return {
    active,
    paused,
    archived,
    other,
    total_current: active.length + paused.length,
    active_count: active.length,
    paused_count: paused.length,
    archived_count: archived.length,
    other_count: other.length,
    total_all: campaigns.length,
  };
}

export function getAutopilotEligible(campaigns = []) {
  return campaigns.filter((campaign) => !campaignIsArchived(campaign) && campaign.excluded_from_dashboard !== true);
}

export function normalizeState(rawState = '') {
  const state = String(rawState ?? '').trim().toLowerCase();

  if (['enabled', 'active', 'ativa', 'ativada', 'running', 'live', 'serving'].includes(state)) return 'enabled';
  if (['paused', 'pausada', 'inactive', 'inativa', 'disabled'].includes(state)) return 'paused';
  if (['archived', 'ended', 'deleted', 'encerrada', 'removed'].includes(state)) return 'archived';
  if (['incomplete', 'draft', 'pending'].includes(state)) return 'incomplete';

  return state;
}
