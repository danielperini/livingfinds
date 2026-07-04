/**
 * campaignUtils — Utilitários de carregamento e classificação de campanhas
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
  allCampaigns.forEach((campaign) => {
    if (campaign.api_missing === true || campaign.excluded_from_dashboard === true) return;
    const campaignId = String(campaign?.campaign_id || campaign?.amazon_campaign_id || '').trim();
    if (!campaignId) return;
    const current = byCampaignId.get(campaignId);
    if (!current || timestampOf(campaign) >= timestampOf(current)) byCampaignId.set(campaignId, campaign);
  });

  return [...byCampaignId.values()];
}

function booleanTrue(value) {
  if (value === true || value === 1) return true;
  return ['true', '1', 'yes', 'sim'].includes(String(value ?? '').trim().toLowerCase());
}

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

  const active = [...enabled, ...pending];
  return {
    active,
    enabled,
    pending,
    paused,
    archived,
    other,
    total_current: active.length + paused.length,
    active_count: active.length,
    enabled_count: enabled.length,
    pending_count: pending.length,
    paused_count: paused.length,
    archived_count: archived.length,
    other_count: other.length,
    total_all: active.length + paused.length + archived.length + other.length,
  };
}

export function getAutopilotEligible(campaigns = []) {
  return campaigns.filter((campaign) =>
    !campaignIsArchived(campaign) &&
    campaign.api_missing !== true &&
    campaign.excluded_from_dashboard !== true
  );
}

export function normalizeState(rawState = '') {
  const state = String(rawState ?? '').trim().toLowerCase();
  if (['enabled', 'active', 'ativa', 'ativada', 'running', 'live', 'serving'].includes(state)) return 'enabled';
  if (['paused', 'pausada', 'inactive', 'inativa', 'disabled'].includes(state)) return 'paused';
  if (['archived', 'ended', 'deleted', 'encerrada', 'removed'].includes(state)) return 'archived';
  if (['incomplete', 'draft', 'pending', 'pending_insertion', 'em inserção', 'em insercao', 'processing'].includes(state)) return 'incomplete';
  return state;
}
