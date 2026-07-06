/**
 * campaignUtils — Utilitários de carregamento e classificação de campanhas
 */

import { base44 } from '@/api/base44Client';

const PAGE_SIZE = 500;

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
    if (!current) { byCampaignId.set(campaignId, campaign); return; }
    // Preferir o registro mais recente para estado/orçamento, mas mesclar métricas do que tiver mais spend
    const newerIsRecent = timestampOf(campaign) >= timestampOf(current);
    const candidateSpend = campaign.spend || 0;
    const currentSpend = current.spend || 0;
    if (newerIsRecent) {
      // Usar registro mais recente para estado/orçamento, mas herdar spend/sales/acos/roas do mais rico se o atual for zerado
      const merged = { ...campaign };
      if (candidateSpend === 0 && currentSpend > 0) {
        merged.spend = current.spend;
        merged.sales = current.sales;
        merged.acos = current.acos;
        merged.roas = current.roas;
        merged.clicks = current.clicks || merged.clicks;
        merged.impressions = current.impressions || merged.impressions;
        merged.orders = current.orders || merged.orders;
        merged.cpc = current.cpc || merged.cpc;
        merged.ctr = current.ctr || merged.ctr;
      }
      byCampaignId.set(campaignId, merged);
    } else if (candidateSpend > currentSpend) {
      // Registro mais antigo mas com métricas melhores — mesclar métricas no registro atual
      const merged = { ...current, spend: candidateSpend, sales: campaign.sales, acos: campaign.acos, roas: campaign.roas,
        clicks: campaign.clicks || current.clicks, impressions: campaign.impressions || current.impressions,
        orders: campaign.orders || current.orders, cpc: campaign.cpc || current.cpc, ctr: campaign.ctr || current.ctr };
      byCampaignId.set(campaignId, merged);
    }
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