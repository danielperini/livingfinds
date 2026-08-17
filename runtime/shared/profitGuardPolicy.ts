export const numberValue = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

export const roundMoney = (value: number): number =>
  Math.round((numberValue(value) + Number.EPSILON) * 100) / 100;

export const normalizeSku = (value: unknown): string =>
  String(value || '').trim().toUpperCase().replace(/\s+/g, '-').replace(/-{2,}/g, '-');

export const normalizeState = (value: unknown): string =>
  String(value || '').trim().toLowerCase();

export function availableInventory(product: any): number {
  const values = [
    product?.fba_inventory,
    product?.available_quantity,
    product?.fulfillable_quantity,
    product?.inventory_quantity,
  ].map((value) => numberValue(value, -1));
  const known = values.filter((value) => value >= 0);
  return known.length ? Math.max(...known) : -1;
}

export function resolveBreakEvenAcos(economics: any): number | null {
  const candidates = [
    economics?.break_even_acos,
    economics?.contribution_margin_percent,
    economics?.amazon_fee_percent > 0 && economics?.current_price > 0
      ? ((numberValue(economics.current_price) - numberValue(economics.total_variable_cost_per_unit) - numberValue(economics.amazon_fee_amount)) / numberValue(economics.current_price)) * 100
      : null,
  ].map((value) => numberValue(value, 0)).filter((value) => value > 0 && value <= 100);
  return candidates.length ? Math.min(...candidates) : null;
}

export function resolveOperatingAcos(economics: any, accountTargetAcos = 15): {
  target_acos: number;
  break_even_acos: number | null;
  safety_acos: number | null;
  source: string;
} {
  const breakEven = resolveBreakEvenAcos(economics);
  const configured = [economics?.target_acos, accountTargetAcos]
    .map((value) => numberValue(value, 0))
    .filter((value) => value > 0 && value <= 100);
  const configuredTarget = configured.length ? Math.min(...configured) : 15;
  const safetyAcos = breakEven && breakEven > 0 ? breakEven * 0.8 : null;
  const target = clamp(
    safetyAcos ? Math.min(configuredTarget, safetyAcos) : configuredTarget,
    1,
    breakEven ? Math.max(1, breakEven - 0.5) : 100,
  );
  return {
    target_acos: roundMoney(target),
    break_even_acos: breakEven ? roundMoney(breakEven) : null,
    safety_acos: safetyAcos ? roundMoney(safetyAcos) : null,
    source: breakEven ? 'product_economics' : 'account_target_fallback',
  };
}

export function resolveSafeMaxCpc(params: {
  economics: any;
  observedCvr?: number;
  observedAov?: number;
  operatingAcos: number;
}): number | null {
  const explicit = numberValue(params.economics?.safe_max_cpc, 0);
  if (explicit > 0) return roundMoney(explicit);
  const price = numberValue(params.observedAov, 0) || numberValue(params.economics?.average_sale_price, 0) || numberValue(params.economics?.current_price, 0);
  const cvr = numberValue(params.observedCvr, 0);
  if (price <= 0 || cvr <= 0 || params.operatingAcos <= 0) return null;
  return roundMoney(price * cvr * (params.operatingAcos / 100));
}

export function economicsAreActionable(economics: any, assessment?: any): boolean {
  if (!economics) return false;
  const status = normalizeState(economics.economics_status);
  const confidence = numberValue(economics.final_economic_confidence, 0);
  const assessmentStatus = normalizeState(assessment?.economic_status);
  const assessmentDataStatus = normalizeState(assessment?.data_status);
  const assessmentIsUsable = Boolean(assessment) &&
    !['insufficient_data', 'stock_blocked', 'listing_blocked'].includes(assessmentStatus) &&
    !['failed', 'stale', 'reconciliation_pending'].includes(assessmentDataStatus);
  const assessmentConfidence = assessmentIsUsable ? numberValue(assessment?.confidence, 0) : 1;
  const hasCoreEconomics = resolveBreakEvenAcos(economics) !== null &&
    (numberValue(economics.current_price, 0) > 0 || numberValue(economics.average_sale_price, 0) > 0);
  const economicsConfidenceOk = confidence >= 0.65 || confidence >= 65 || hasCoreEconomics;
  const assessmentConfidenceOk = assessmentConfidence >= 0.65 || assessmentConfidence >= 65;
  return ['complete', 'partial'].includes(status) && economicsConfidenceOk && assessmentConfidenceOk;
}

export function isProtectedWinner(params: {
  orders: number;
  sales: number;
  spend: number;
  targetAcos: number;
  lastSaleAt?: string | null;
  protectedFlag?: boolean;
}): { protected: boolean; reason: string } {
  if (params.protectedFlag) return { protected: true, reason: 'protected_high_performance_flag' };
  const acos = params.sales > 0 ? (params.spend / params.sales) * 100 : null;
  if (params.orders > 0 && acos !== null && acos <= params.targetAcos) {
    return { protected: true, reason: `winner_acos_${roundMoney(acos)}_target_${params.targetAcos}` };
  }
  if (params.lastSaleAt && params.orders > 0 && acos !== null && acos <= params.targetAcos * 1.25) {
    const ageHours = (Date.now() - new Date(params.lastSaleAt).getTime()) / 3600000;
    if (Number.isFinite(ageHours) && ageHours <= 72) {
      return { protected: true, reason: `recent_profitable_sale_${roundMoney(ageHours)}h_acos_${roundMoney(acos)}` };
    }
  }
  return { protected: false, reason: 'not_protected' };
}

export function classifyProfitPressure(assessment: any, economics: any): 'healthy' | 'watch' | 'defensive' | 'critical' | 'unknown' {
  const assessmentStatus = normalizeState(assessment?.economic_status);
  const status = !assessmentStatus || ['insufficient_data', 'stock_blocked', 'listing_blocked'].includes(assessmentStatus)
    ? normalizeState(economics?.economic_classification)
    : assessmentStatus;
  const profit = assessment?.profit_after_ads == null || assessmentStatus === 'insufficient_data'
    ? numberValue(economics?.profit_after_ads, Number.NaN)
    : numberValue(assessment.profit_after_ads, Number.NaN);
  if (['unprofitable', 'no_sales_with_spend'].includes(status) || (Number.isFinite(profit) && profit < -0.5)) return 'critical';
  if (['break_even', 'low_margin'].includes(status) || (Number.isFinite(profit) && profit <= 0.5)) return 'defensive';
  if (['low_profit', 'vigilant'].includes(status)) return 'watch';
  if (['profitable', 'highly_profitable'].includes(status) || (Number.isFinite(profit) && profit > 0.5)) return 'healthy';
  return 'unknown';
}

export function bidAfterProfitGuard(params: {
  currentBid: number;
  minBid: number;
  maxBid: number;
  pressure: 'watch' | 'defensive' | 'critical';
  safeMaxCpc?: number | null;
}): number {
  const reduction = params.pressure === 'critical' ? 0.20 : params.pressure === 'defensive' ? 0.15 : 0.10;
  const reduced = params.currentBid * (1 - reduction);
  const capped = params.safeMaxCpc && params.safeMaxCpc > 0 ? Math.min(reduced, params.safeMaxCpc) : reduced;
  return roundMoney(clamp(capped, params.minBid, params.maxBid));
}

export function zeroSalesCircuitBreaker(params: {
  clicks: number;
  spend: number;
  orders: number;
  sales: number;
  maximumProfitableCpa?: number | null;
}) {
  const spendLimit = Math.max(5, Math.min(12,
    numberValue(params.maximumProfitableCpa, 0) > 0
      ? numberValue(params.maximumProfitableCpa) * 0.50
      : 8));
  return {
    triggered: numberValue(params.orders) === 0 && numberValue(params.sales) === 0 &&
      numberValue(params.clicks) >= 8 && numberValue(params.spend) >= spendLimit,
    spendLimit: roundMoney(spendLimit),
  };
}
