/** KPI and conservative maturity policy for MANUAL campaigns. */
export type ManualMaturityStage = 'HOLD' | 'REDUCE_BID' | 'RE_EVALUATE' | 'PAUSE';
export type CampaignClass = 'WINNER' | 'EFFICIENT' | 'NEW_EXACT' | 'OTHER';

export interface ManualCampaignSnapshot {
  id: string;
  type: string;
  maturity: string;
  status: string;
  spend: number;
  sales: number;
  profit: number;
  campaignClass?: CampaignClass;
  bid?: number;
  priorStage?: ManualMaturityStage;
  negativeEvaluations?: number;
  persistentEvidence?: boolean;
}

export interface ZeroSpendManualKpi {
  zeroSpendMatureManual: number;
  activeMatureManual: number;
  zero_spend_manual_rate: number;
  shortTermTarget: number;
  nextTarget: number;
  longTermTarget: number;
  meetsShortTerm: boolean;
  meetsNextTarget: boolean;
  meetsLongTermTarget: boolean;
}

export interface MaturityDecision {
  campaignId: string;
  previousStage: ManualMaturityStage;
  nextStage: ManualMaturityStage;
  action: 'HOLD' | 'REDUCE_BID' | 'RE_EVALUATE' | 'PAUSE' | 'PRESERVE_WINNER';
  nextBid?: number;
  reason: string;
}

export interface CapacityReallocation {
  releasedBudget: number;
  releasedCapacity: number;
  allocations: { campaignId: string; campaignClass: CampaignClass; budget: number; capacity: number }[];
}

const MANUAL = 'MANUAL';
const ACTIVE = new Set(['ACTIVE', 'ENABLED', 'RUNNING']);
const MATURE = new Set(['MATURE', 'mature']);
const round = (value: number) => Math.round(Math.max(0, value) * 100) / 100;
const amount = (value: unknown) => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
const isManual = (c: ManualCampaignSnapshot) => c.type.trim().toUpperCase() === MANUAL;
const isMature = (c: ManualCampaignSnapshot) => MATURE.has(c.maturity);
const isActive = (c: ManualCampaignSnapshot) => ACTIVE.has(c.status.trim().toUpperCase());

export function calculateZeroSpendManualRate(campaigns: readonly ManualCampaignSnapshot[]): ZeroSpendManualKpi {
  const activeMatureManual = campaigns.filter((c) => isManual(c) && isMature(c) && isActive(c));
  const zeroSpendMatureManual = activeMatureManual.filter((c) => amount(c.spend) === 0).length;
  const zero_spend_manual_rate = activeMatureManual.length ? zeroSpendMatureManual / activeMatureManual.length : 0;
  return {
    zeroSpendMatureManual, activeMatureManual: activeMatureManual.length,
    zero_spend_manual_rate: round(zero_spend_manual_rate),
    shortTermTarget: 0.30, nextTarget: 0.20, longTermTarget: 0.10,
    meetsShortTerm: zero_spend_manual_rate < 0.30,
    meetsNextTarget: zero_spend_manual_rate < 0.20,
    meetsLongTermTarget: zero_spend_manual_rate < 0.10,
  };
}

export function decideMatureCampaignAction(campaign: ManualCampaignSnapshot, reduction = 0.10): MaturityDecision {
  const previousStage = campaign.priorStage ?? 'HOLD';
  if (campaign.campaignClass === 'WINNER' && amount(campaign.profit) > 0 && amount(campaign.sales) > 0) {
    return { campaignId: campaign.id, previousStage, nextStage: 'HOLD', action: 'PRESERVE_WINNER', nextBid: campaign.bid, reason: 'Winner preserved; no maturity reduction applied.' };
  }
  const unprofitable = amount(campaign.sales) > 0 && amount(campaign.profit) <= 0;
  const noSale = amount(campaign.sales) === 0;
  if (!unprofitable && !noSale) return { campaignId: campaign.id, previousStage, nextStage: 'HOLD', action: 'HOLD', nextBid: campaign.bid, reason: 'No negative maturity evidence.' };
  if (previousStage === 'HOLD') return { campaignId: campaign.id, previousStage, nextStage: 'REDUCE_BID', action: 'REDUCE_BID', nextBid: campaign.bid === undefined ? undefined : round(campaign.bid * (1 - reduction)), reason: unprofitable ? 'Mature campaign is unprofitable; first bounded bid reduction.' : 'Mature campaign has no sale; first bounded bid reduction.' };
  if (previousStage === 'REDUCE_BID') return { campaignId: campaign.id, previousStage, nextStage: 'RE_EVALUATE', action: 'RE_EVALUATE', nextBid: campaign.bid, reason: 'Wait for a fresh evaluation after the bid reduction.' };
  const persistent = campaign.persistentEvidence === true || amount(campaign.negativeEvaluations) >= 2;
  if (previousStage === 'RE_EVALUATE' && persistent) return { campaignId: campaign.id, previousStage, nextStage: 'PAUSE', action: 'PAUSE', nextBid: 0, reason: 'Persistent negative evidence after bid reduction and re-evaluation.' };
  if (previousStage === 'RE_EVALUATE') return { campaignId: campaign.id, previousStage, nextStage: 'REDUCE_BID', action: 'REDUCE_BID', nextBid: campaign.bid === undefined ? undefined : round(campaign.bid * (1 - reduction)), reason: 'Negative result persists; second bounded bid reduction before pause.' };
  if (previousStage === 'PAUSE') return { campaignId: campaign.id, previousStage, nextStage: 'PAUSE', action: 'PAUSE', nextBid: 0, reason: 'Campaign already paused.' };
  return { campaignId: campaign.id, previousStage, nextStage: 'HOLD', action: 'HOLD', nextBid: campaign.bid, reason: 'Hold until sufficient evidence is available.' };
}

export function reallocateReleasedCapacity(campaigns: readonly ManualCampaignSnapshot[], releasedBudget: number, releasedCapacity: number): CapacityReallocation {
  const eligible = campaigns.filter((c) => c.campaignClass === 'WINNER' || c.campaignClass === 'EFFICIENT' || c.campaignClass === 'NEW_EXACT');
  const weights = eligible.map((c) => c.campaignClass === 'WINNER' ? 3 : c.campaignClass === 'EFFICIENT' ? 2 : 1);
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  if (!totalWeight) return { releasedBudget: amount(releasedBudget), releasedCapacity: amount(releasedCapacity), allocations: [] };
  return {
    releasedBudget: amount(releasedBudget), releasedCapacity: amount(releasedCapacity),
    allocations: eligible.map((c, i) => ({ campaignId: c.id, campaignClass: c.campaignClass!, budget: round(amount(releasedBudget) * weights[i] / totalWeight), capacity: round(amount(releasedCapacity) * weights[i] / totalWeight) })),
  };
}
