export const RECONCILIATION_CLASSES = [
  'ATIVA_COMPLETA', 'PAUSADA', 'INCOMPLETA_REPARAVEL', 'SEM_PRODUTO',
  'SEM_ESTOQUE', 'DUPLICADA', 'PROTEGIDA_ALTA_PERFORMANCE', 'ARQUIVADA',
  'DIVERGENCIA_DE_ESTADO', 'ERRO_RETRYABLE',
] as const;

export type ReconciliationClass = typeof RECONCILIATION_CLASSES[number];

export const normState = (value: unknown) => {
  const state = String(value || '').trim().toUpperCase();
  if (state === 'ENABLED') return 'enabled';
  if (state === 'PAUSED') return 'paused';
  if (state === 'ARCHIVED') return 'archived';
  return 'incomplete';
};

export function isHighPerformance(campaign: any) {
  const sales = Number(campaign?.sales || 0);
  const spend = Number(campaign?.spend || 0);
  const orders = Number(campaign?.orders || 0);
  const profit = Number(campaign?.profit_after_ads || 0);
  return orders > 0 && sales > 0 && (profit > 0 || spend / sales <= 0.25);
}

export function duplicateWinnerScore(campaign: any) {
  return [
    isHighPerformance(campaign) ? 1 : 0,
    Number(campaign?.profit_after_ads || 0),
    Number(campaign?.sales || 0),
    Number(campaign?.orders || 0),
    Number(campaign?.history_days || campaign?.days_running || 0),
    Number(campaign?.spend || 0),
  ];
}

export function chooseDuplicateWinner(campaigns: any[]) {
  return [...campaigns].sort((a, b) => {
    const aa = duplicateWinnerScore(a);
    const bb = duplicateWinnerScore(b);
    for (let i = 0; i < aa.length; i++) if (aa[i] !== bb[i]) return bb[i] - aa[i];
    return String(a.campaignId || a.campaign_id).localeCompare(String(b.campaignId || b.campaign_id));
  })[0];
}

export function classifyRemoteCampaign(input: {
  remote: any; local?: any; product?: any; adGroups?: any[]; productAds?: any[];
  keywords?: any[]; duplicate?: boolean; retryableError?: boolean;
}): ReconciliationClass {
  const { remote, local, product, adGroups = [], productAds = [], keywords = [], duplicate, retryableError } = input;
  if (retryableError) return 'ERRO_RETRYABLE';
  const state = normState(remote?.state);
  if (state === 'archived') return 'ARQUIVADA';
  if (!product) return 'SEM_PRODUTO';
  if (Number(product?.available_quantity ?? product?.stock ?? product?.quantity ?? 0) <= 0) return 'SEM_ESTOQUE';
  if (duplicate) return 'DUPLICADA';
  const enabledAdGroups = adGroups.filter((x) => normState(x.state) === 'enabled');
  const enabledProductAds = productAds.filter((x) => normState(x.state) === 'enabled');
  const manual = String(remote?.targetingType || local?.targeting_type || '').toUpperCase() === 'MANUAL';
  const enabledExact = keywords.filter((x) => normState(x.state) === 'enabled' && String(x.matchType || x.match_type).toUpperCase() === 'EXACT');
  const complete = enabledAdGroups.length === 1 && enabledProductAds.length === 1 && (!manual || enabledExact.length === 1);
  if (state === 'enabled' && !complete) return 'INCOMPLETA_REPARAVEL';
  if (isHighPerformance(local)) return 'PROTEGIDA_ALTA_PERFORMANCE';
  const localState = normState(local?.state ?? local?.status ?? local?.amazon_status);
  if (local && localState !== state) return 'DIVERGENCIA_DE_ESTADO';
  if (state === 'paused') return 'PAUSADA';
  return state === 'enabled' && complete ? 'ATIVA_COMPLETA' : 'INCOMPLETA_REPARAVEL';
}

export function proposedAction(classification: ReconciliationClass, campaign: any) {
  if (classification === 'INCOMPLETA_REPARAVEL') return 'REPAIR_STRUCTURE';
  if (classification === 'SEM_ESTOQUE') return 'PAUSE_NO_STOCK';
  if (classification === 'SEM_PRODUTO') return 'ARCHIVE_AFTER_REMOTE_CONFIRMATION';
  if (classification === 'DUPLICADA') return 'PAUSE_DUPLICATE_AFTER_WINNER_CONFIRMATION';
  if (classification === 'DIVERGENCIA_DE_ESTADO') return 'SYNC_CONFIRMED_STATE';
  if (classification === 'ERRO_RETRYABLE') return 'RETRY_ASYNC';
  if (classification === 'PROTEGIDA_ALTA_PERFORMANCE' || isHighPerformance(campaign)) return 'PROTECT';
  return 'NONE';
}
