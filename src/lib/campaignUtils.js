/**
 * campaignUtils — Utilitários de carregamento e classificação de campanhas
 * Regra: nunca usar um número fixo como contagem esperada de campanhas.
 * Paginação real — busca até não existirem mais resultados.
 */

import { base44 } from '@/api/base44Client';

const PAGE_SIZE = 200;

/**
 * Carrega TODAS as campanhas de uma conta com paginação.
 * @param {string} amazonAccountId
 * @param {object} extraFilter - filtros adicionais opcionais
 * @returns {Promise<Array>}
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

  return allCampaigns;
}

function booleanTrue(value) {
  if (value === true || value === 1) return true;
  return ['true', '1', 'yes', 'sim'].includes(String(value ?? '').trim().toLowerCase());
}

/**
 * Normaliza todos os campos de estado usados pelas diferentes rotas de sync.
 * Prioridade: state → status → campaign_status → serving_status.
 */
export function campaignState(campaign = {}) {
  const rawState =
    campaign.state ??
    campaign.status ??
    campaign.campaign_status ??
    campaign.serving_status ??
    '';

  return normalizeState(String(rawState));
}

export function campaignIsArchived(campaign = {}) {
  return booleanTrue(campaign.archived) || campaignState(campaign) === 'archived';
}

/**
 * Classifica campanhas em grupos operacionais.
 * archived = estado Amazon 'archived' OU campo archived=true.
 * total_current = active + paused (NÃO inclui archived).
 */
export function classifyCampaigns(campaigns = []) {
  const active = [];
  const paused = [];
  const archived = [];
  const other = [];

  campaigns.forEach((campaign) => {
    const state = campaignState(campaign);

    if (campaignIsArchived(campaign)) {
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

/**
 * Filtra campanhas elegíveis para Autopilot (nunca arquivadas).
 */
export function getAutopilotEligible(campaigns = []) {
  return campaigns.filter((campaign) => !campaignIsArchived(campaign));
}

/**
 * Normaliza o estado Amazon para padrão interno.
 * ENABLED/ACTIVE/ATIVA → enabled | PAUSED/PAUSADA → paused | ARCHIVED → archived
 */
export function normalizeState(rawState = '') {
  const state = String(rawState ?? '').trim().toLowerCase();

  if (['enabled', 'active', 'ativa', 'ativada', 'running', 'live'].includes(state)) return 'enabled';
  if (['paused', 'pausada', 'inactive', 'inativa'].includes(state)) return 'paused';
  if (['archived', 'ended', 'deleted', 'encerrada'].includes(state)) return 'archived';

  return state;
}
