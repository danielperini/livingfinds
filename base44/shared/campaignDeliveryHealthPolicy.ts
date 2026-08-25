export type DeliveryAction =
  | 'WAIT'
  | 'REPAIR_STRUCTURE'
  | 'ARCHIVE_NO_PRODUCT'
  | 'ARCHIVE_OUT_OF_STOCK'
  | 'INCREASE_BID'
  | 'PAUSE_AND_REPLACE'
  | 'PROTECT_WINNER';

export type DeliveryHealthInput = {
  ageHours: number;
  impressions: number;
  clicks: number;
  orders: number;
  sales: number;
  spend: number;
  complete: boolean;
  hasProduct: boolean;
  inStock: boolean;
  protectedWinner: boolean;
  accountOutOfBudget: boolean;
  priorBidEscalations: number;
  operationalState?: string;
};

const STALE_TRANSITIONAL_STATES = new Set([
  'INSERTING',
  'INCOMPLETE',
  'CREATING',
  'PENDING',
  'DRAFT',
  'PENDING_REVIEW',
]);

export const ZERO_DELIVERY_TEST_HOURS = 72;
export const MAX_ZERO_DELIVERY_BID_ESCALATIONS = 2;

const finite = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const positive = (value: unknown): number => Math.max(0, finite(value));
const money = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;
const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

const TRUSTED_BOOTSTRAP_COST_SOURCES = new Set([
  'manual_confirmed_import',
  'manual_confirmed',
  'manual',
]);

export type ZeroDeliveryBootstrapInput = {
  actionableEconomics: boolean;
  safeMaxCpc: unknown;
  breakEvenAcos: unknown;
  currentPrice: unknown;
  unitCost: unknown;
  costSource?: unknown;
  assessmentStatus?: unknown;
  asinSpend: unknown;
  asinSales: unknown;
  asinOrders: unknown;
  spendCap?: unknown;
  inStock: boolean;
  accountOutOfBudget: boolean;
  hardStop?: boolean;
};

export type ZeroDeliveryBootstrapDecision = {
  eligible: boolean;
  reason: string;
  safe_max_cpc: number;
  asin_spend: number;
  spend_cap: number;
  remaining_spend_headroom: number;
  economics_source: 'canonical' | 'trusted_bootstrap' | 'unavailable';
};

/**
 * Permite destravar uma estrutura ZERO_DELIVERY quando os campos canônicos
 * ainda estão marcados como incompletos, mas preço, custo confirmado, break-even
 * e safe_max_cpc existem. O envelope é por ASIN e nunca libera aumento de
 * orçamento nem ignora perda já observada.
 */
export function evaluateZeroDeliveryBootstrap(
  input: ZeroDeliveryBootstrapInput,
): ZeroDeliveryBootstrapDecision {
  const safeMaxCpc = money(positive(input.safeMaxCpc));
  const asinSpend = money(positive(input.asinSpend));
  const configuredCap = positive(input.spendCap);
  const spendCap = money(configuredCap > 0
    ? configuredCap
    : clamp(safeMaxCpc * 4, 2.50, 5));
  const remaining = money(Math.max(0, spendCap - asinSpend));
  const assessmentStatus = String(input.assessmentStatus || '').trim().toLowerCase();
  const costSource = String(input.costSource || '').trim().toLowerCase();
  const trustedBootstrap = TRUSTED_BOOTSTRAP_COST_SOURCES.has(costSource) &&
    positive(input.currentPrice) > 0 && positive(input.unitCost) > 0 &&
    positive(input.breakEvenAcos) > 0 && safeMaxCpc > 0;
  const source = input.actionableEconomics
    ? 'canonical' as const
    : trustedBootstrap
      ? 'trusted_bootstrap' as const
      : 'unavailable' as const;
  const result = (eligible: boolean, reason: string): ZeroDeliveryBootstrapDecision => ({
    eligible,
    reason,
    safe_max_cpc: safeMaxCpc,
    asin_spend: asinSpend,
    spend_cap: spendCap,
    remaining_spend_headroom: remaining,
    economics_source: source,
  });

  if (!input.inStock) return result(false, 'OUT_OF_STOCK');
  if (input.hardStop === true || input.accountOutOfBudget) return result(false, 'ACCOUNT_SPEND_GUARD');
  if (['stock_blocked', 'listing_blocked'].includes(assessmentStatus)) {
    return result(false, 'PRODUCT_DELIVERY_BLOCKED');
  }
  if (source === 'unavailable') return result(false, 'ECONOMICS_NOT_ACTIONABLE');
  if (safeMaxCpc <= 0) return result(false, 'MISSING_SAFE_MAX_CPC');
  if (positive(input.asinOrders) <= 0 && positive(input.asinSales) <= 0 && remaining <= 0) {
    return result(false, 'ASIN_ZERO_SALE_SPEND_CAP_EXHAUSTED');
  }
  return result(true, source === 'canonical'
    ? 'ZERO_DELIVERY_CANONICAL_ECONOMICS'
    : 'ZERO_DELIVERY_TRUSTED_BOOTSTRAP_ECONOMICS');
}

export function classifyCampaignDeliveryHealth(input: DeliveryHealthInput): DeliveryAction {
  if (input.orders > 0 || input.sales > 0 || (input.protectedWinner && (input.impressions > 0 || input.clicks > 0 || input.spend > 0))) {
    return 'PROTECT_WINNER';
  }
  if (!input.hasProduct) return 'ARCHIVE_NO_PRODUCT';
  if (!input.inStock) return 'ARCHIVE_OUT_OF_STOCK';

  // Entrega real prova que a estrutura remota está operacional. Divergências
  // do espelho local devem ser reconciliadas sem reativar/criar componentes.
  if (input.impressions > 0 || input.clicks > 0 || input.spend > 0) return 'WAIT';

  const state = String(input.operationalState || '').trim().toUpperCase();
  const staleTransition = STALE_TRANSITIONAL_STATES.has(state) && input.ageHours >= 6;
  if (!input.complete || staleTransition) return 'REPAIR_STRUCTURE';

  if (input.ageHours < ZERO_DELIVERY_TEST_HOURS) return 'WAIT';
  if (input.accountOutOfBudget) return 'WAIT';
  if (input.priorBidEscalations < MAX_ZERO_DELIVERY_BID_ESCALATIONS) return 'INCREASE_BID';
  return 'PAUSE_AND_REPLACE';
}

export function nextConservativeBid(
  currentBid: number,
  maxBid: number,
  _configuredIncrement = 0.1,
  minBid = 0.02,
): number {
  const safeMin = Math.max(0.02, Number(minBid) || 0.02);
  const safeCurrent = Math.max(safeMin, Number(currentBid) || safeMin);
  const cappedMax = Math.max(safeCurrent, Number(maxBid) || safeCurrent);
  const percentageStep = Math.round(safeCurrent * 1.05 * 100) / 100;
  return Math.min(cappedMax, Math.max(safeMin, percentageStep));
}
