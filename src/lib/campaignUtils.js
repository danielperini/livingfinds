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

/**
 * Classifica campanhas em grupos operacionais.
 * archived = estado Amazon 'archived' OU campo archived=true.
 * total_current = active + paused (NÃO inclui archived).
 */
export function classifyCampaigns(campaigns) {
  const active = campaigns.filter(c =>
    (c.state === 'enabled' || c.status === 'enabled') &&
    !c.archived && c.state !== 'archived' && c.status !== 'archived'
  );
  const paused = campaigns.filter(c =>
    (c.state === 'paused' || c.status === 'paused') &&
    !c.archived && c.state !== 'archived' && c.status !== 'archived'
  );
  const archived = campaigns.filter(c =>
    c.archived || c.state === 'archived' || c.status === 'archived'
  );

  return {
    active,
    paused,
    archived,
    total_current: active.length + paused.length, // operacional — sem archived
    active_count: active.length,
    paused_count: paused.length,
    archived_count: archived.length,
    total_all: campaigns.length,
  };
}

/**
 * Filtra campanhas elegíveis para Autopilot (nunca arquivadas).
 */
export function getAutopilotEligible(campaigns) {
  return campaigns.filter(c =>
    c.state !== 'archived' && c.status !== 'archived' && !c.archived
  );
}

/**
 * Normaliza o estado Amazon para padrão interno.
 * ENABLED → enabled | PAUSED → paused | ARCHIVED → archived
 */
export function normalizeState(rawState = '') {
  const s = rawState.toLowerCase();
  if (s === 'enabled' || s === 'active') return 'enabled';
  if (s === 'paused') return 'paused';
  if (s === 'archived') return 'archived';
  return s;
}