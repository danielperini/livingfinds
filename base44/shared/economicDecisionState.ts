export type SkuEconomicState =
  | 'NORMAL'
  | 'VIGILANT'
  | 'DEFENSIVE'
  | 'LOSS_CONFIRMED'
  | 'NOT_BUYABLE';

const finite = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const validNumber = (value: unknown): boolean =>
  value !== null && value !== undefined && value !== '' &&
  Number.isFinite(Number(value));

const ageHours = (value: unknown, now = Date.now()): number => {
  if (!value) return Number.POSITIVE_INFINITY;
  const time = new Date(String(value)).getTime();
  return Number.isFinite(time) ? (now - time) / 3600000 : Number.POSITIVE_INFINITY;
};

export type UnifiedEconomicStatus = {
  status: 'complete' | 'partial' | 'missing_cost' | 'missing_price' | 'negative_margin' | 'unknown';
  economic_data_incomplete: boolean;
  block_expansion: boolean;
  allow_conservative_growth: boolean;
  economic_confidence: 'complete' | 'partial' | 'none';
  block_reason: string;
};

/**
 * Guardrail compartilhado por preço e Ads. A ausência de qualquer componente
 * econômico bloqueia crescimento; nunca converte null, vazio ou dado antigo em
 * autorização para aumentar bid.
 */
export function classifyUnifiedEconomicStatus(
  economics: any | null,
  now = Date.now(),
): UnifiedEconomicStatus {
  const blocked = (
    status: UnifiedEconomicStatus['status'],
    reason: string,
    incomplete = true,
  ): UnifiedEconomicStatus => ({
    status,
    economic_data_incomplete: incomplete,
    block_expansion: true,
    allow_conservative_growth: false,
    economic_confidence: incomplete ? 'none' : 'complete',
    block_reason: reason,
  });

  if (!economics) return blocked('missing_cost', 'economia_do_sku_ausente');
  if (
    economics.costs_confirmed_by_user !== true ||
    !validNumber(economics.unit_cost) || Number(economics.unit_cost) <= 0
  ) return blocked('missing_cost', 'custo_unitario_ausente_ou_nao_confirmado');
  if (
    !validNumber(economics.current_price) || Number(economics.current_price) <= 0 ||
    !String(economics.price_source || '').startsWith('sp_api')
  ) return blocked('missing_price', 'preco_atual_nao_confirmado_pela_sp_api');

  const feesComplete = economics.fees_verified_at &&
    ageHours(economics.fees_verified_at, now) <= 24 &&
    String(economics.fees_source || '').startsWith('sp_api') &&
    validNumber(economics.fba_fee) && Number(economics.fba_fee) >= 0 &&
    validNumber(economics.amazon_fixed_fee) && Number(economics.amazon_fixed_fee) >= 0 &&
    validNumber(economics.amazon_fee_percent) && Number(economics.amazon_fee_percent) >= 0;
  if (!feesComplete) return blocked('partial', 'tarifas_amazon_ausentes_ou_desatualizadas');

  const adsComplete = economics.ads_cost_verified_at &&
    ageHours(economics.ads_cost_verified_at, now) <= 24 * 30 &&
    economics.ads_cost_source && economics.ads_cost_source !== 'missing' &&
    validNumber(economics.estimated_ads_cost_per_order) &&
    Number(economics.estimated_ads_cost_per_order) >= 0;
  if (!adsComplete) return blocked('partial', 'ads_sem_historico_economico_confiavel');
  if (
    economics.economic_data_complete !== true ||
    String(economics.economics_status || '') !== 'complete'
  ) return blocked('partial', 'economia_unificada_ainda_incompleta');

  const margin = Number(economics.current_margin_pct);
  const minimumMargin = Math.max(15, Number(economics.minimum_margin_pct || 15));
  const contribution = Number(economics.contribution_margin_amount);
  const profitMode = String(economics.profit_protection_mode || 'normal');
  if (
    !Number.isFinite(margin) || margin < minimumMargin ||
    !Number.isFinite(contribution) || contribution <= 0 ||
    economics.economic_conflict === true ||
    ['vigilant', 'defensive', 'paused'].includes(profitMode)
  ) {
    return blocked(
      'negative_margin',
      `margem_ou_lucro_em_risco:${Number.isFinite(margin) ? margin : 'ausente'}`,
      false,
    );
  }

  return {
    status: 'complete',
    economic_data_incomplete: false,
    block_expansion: false,
    allow_conservative_growth: false,
    economic_confidence: 'complete',
    block_reason: '',
  };
}

export function classifySkuEconomicState(input: {
  realRevenue?: number | null;
  adSpend?: number | null;
  contributionBeforeAds?: number | null;
  targetAcosPercent?: number | null;
  breakEvenAcosPercent?: number | null;
  buyable?: boolean;
  offerActive?: boolean;
  listingSuppressed?: boolean;
  adsEligible?: boolean;
}) {
  if (
    input.buyable === false
    || input.offerActive === false
    || input.listingSuppressed === true
    || input.adsEligible === false
  ) {
    return { state: 'NOT_BUYABLE' as SkuEconomicState, block_growth: true, pause_all_campaigns: true };
  }

  const revenue = Math.max(0, finite(input.realRevenue));
  const spend = Math.max(0, finite(input.adSpend));
  const contribution = finite(input.contributionBeforeAds);
  const targetAcos = Math.max(0, finite(input.targetAcosPercent));
  const breakEvenAcos = Math.max(0, finite(input.breakEvenAcosPercent));
  const finalProfit = contribution - spend;
  const realAcos = revenue > 0 ? (spend / revenue) * 100 : null;

  if (spend > 0 && finalProfit <= 0) {
    return { state: 'LOSS_CONFIRMED' as SkuEconomicState, block_growth: true, pause_all_campaigns: false, final_profit: finalProfit, real_acos: realAcos };
  }
  if (finalProfit < 0 || (realAcos != null && breakEvenAcos > 0 && realAcos > breakEvenAcos)) {
    return { state: 'DEFENSIVE' as SkuEconomicState, block_growth: true, pause_all_campaigns: false, final_profit: finalProfit, real_acos: realAcos };
  }
  if (realAcos != null && targetAcos > 0 && realAcos > targetAcos) {
    return { state: 'VIGILANT' as SkuEconomicState, block_growth: true, pause_all_campaigns: false, final_profit: finalProfit, real_acos: realAcos };
  }
  return { state: 'NORMAL' as SkuEconomicState, block_growth: false, pause_all_campaigns: false, final_profit: finalProfit, real_acos: realAcos };
}
