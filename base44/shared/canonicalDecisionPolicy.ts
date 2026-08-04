import { estimateBayesianConversion, probabilityAtLeastOneSale } from './marketplaceDecisionMath.ts';

export type CanonicalBidAction =
  | 'HOLD'
  | 'INCREASE'
  | 'DECREASE_SOFT'
  | 'DECREASE_STRONG'
  | 'RECOVER_ZERO_DELIVERY'
  | 'BLOCK'
  | 'REPLACE_TERM'
  | 'PAUSE_CANDIDATE';

export type CanonicalBidInput = {
  currentBid: number;
  safeMaxCpc: number;
  impressions: number;
  clicks: number;
  sameSkuOrders: number;
  haloOrders?: number;
  spend: number;
  maxSpendWithoutSale: number;
  spendShare: number;
  ageHours: number;
  inStock: boolean;
  structurallyComplete: boolean;
  dataFresh: boolean;
  economicsComplete: boolean;
  cooldownActive: boolean;
  pendingInsertion: boolean;
  winnerProtected: boolean;
  lowVolumeGuarded: boolean;
  defensive: boolean;
  isManualExact: boolean;
  adGroupConfirmed: boolean;
  productAdConfirmed: boolean;
  priorReductionCount: number;
  attributionComplete: boolean;
  acos: number | null;
  targetAcos: number | null;
  breakEvenAcos: number | null;
  profitAfterAds: number;
  priorAlpha?: number;
  priorBeta?: number;
};

export type CanonicalBidDecision = {
  action: CanonicalBidAction;
  proposedBid: number | null;
  changePct: number;
  reasonCode: string;
  reason: string;
  confidence: number;
  nextEvaluationHours: number;
  requiresPairedAdGroup: boolean;
  posterior: ReturnType<typeof estimateBayesianConversion>;
  probabilityOfSaleNextExpectedWindow: number;
};

export type GovernanceInput = {
  actionType: string;
  entityType: string;
  currentValue?: number | null;
  proposedValue?: number | null;
  snapshotId?: string | null;
  reasonCode?: string | null;
  reason?: string | null;
  confidence: number;
  predictionConfidence?: number | null;
  economicConfidence?: number | null;
  dataFresh: boolean;
  adsDataFresh?: boolean;
  spApiDataFresh?: boolean;
  economicsDataFresh?: boolean;
  productEligible: boolean;
  listingActive: boolean;
  offerActive: boolean;
  buyable: boolean;
  inStock: boolean;
  stockCoverageDays?: number | null;
  economicsComplete: boolean;
  profitAfterAds?: number | null;
  marginRate?: number | null;
  currentAcos?: number | null;
  targetAcos?: number | null;
  safeMaxCpc?: number | null;
  economicFloor?: number | null;
  competitionFresh?: boolean;
  winnerProtected?: boolean;
  sameSkuOrders?: number;
  haloOrders?: number;
  cooldownActive?: boolean;
  accountKillSwitch?: boolean;
  accountDailyCap?: number | null;
  accountSpend?: number | null;
  reservedPendingSpend?: number | null;
  proposedSpendImpact?: number | null;
  campaignPauseShare?: number | null;
  explicitBatchAuthorization?: boolean;
  defensive?: boolean;
  parentAsin?: boolean;
  rollbackPlan?: string | null;
  maxBidIncreasePct?: number;
  absoluteBidIncreasePct?: number;
  maxBidReductionPct?: number;
  minPredictionConfidence?: number;
  minEconomicConfidence?: number;
};

export type GovernanceResult = {
  allowed: boolean;
  blockers: Array<{ priority: string; code: string; reason: string }>;
  priority: string;
  rollbackRequired: boolean;
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const roundMoney = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const lower = (value: unknown) => String(value || '').trim().toLowerCase();

function bidResult(
  input: CanonicalBidInput,
  posterior: ReturnType<typeof estimateBayesianConversion>,
  action: CanonicalBidAction,
  changePct: number,
  reasonCode: string,
  reason: string,
  confidence: number,
  nextEvaluationHours: number,
): CanonicalBidDecision {
  const bounded = action === 'INCREASE' || action === 'RECOVER_ZERO_DELIVERY'
    ? Math.min(0.05, Math.max(0, changePct))
    : action.startsWith('DECREASE') ? -Math.min(0.20, Math.abs(changePct)) : 0;
  let proposedBid: number | null = null;
  if (bounded !== 0) {
    const raw = input.currentBid * (1 + bounded);
    proposedBid = roundMoney(bounded > 0 ? Math.min(raw, input.safeMaxCpc) : Math.max(0.02, raw));
    const actual = input.currentBid > 0 ? (proposedBid - input.currentBid) / input.currentBid : 0;
    if (bounded > 0 && actual > 0.05) proposedBid = Math.floor(input.currentBid * 1.05 * 100) / 100;
    if (bounded < 0 && -actual > 0.20) proposedBid = Math.ceil(input.currentBid * 0.80 * 100) / 100;
    if (Math.abs(proposedBid - input.currentBid) < 0.005) proposedBid = null;
  }
  const expectedClicks = posterior.mean > 0 ? Math.max(1, Math.ceil(1 / posterior.mean)) : 20;
  return {
    action: proposedBid === null && bounded !== 0 ? 'HOLD' : action,
    proposedBid,
    changePct: proposedBid === null || input.currentBid <= 0 ? 0 : (proposedBid - input.currentBid) / input.currentBid,
    reasonCode: proposedBid === null && bounded !== 0 ? `${reasonCode}_ROUNDING_HOLD` : reasonCode,
    reason,
    confidence,
    nextEvaluationHours,
    requiresPairedAdGroup: input.isManualExact && ['INCREASE', 'DECREASE_SOFT', 'DECREASE_STRONG', 'RECOVER_ZERO_DELIVERY'].includes(action),
    posterior,
    probabilityOfSaleNextExpectedWindow: probabilityAtLeastOneSale(posterior.lower, expectedClicks),
  };
}

export function buildCanonicalBidDecision(input: CanonicalBidInput): CanonicalBidDecision {
  const posterior = estimateBayesianConversion({
    clicks: input.clicks,
    orders: input.sameSkuOrders,
    priorAlpha: input.priorAlpha ?? 1,
    priorBeta: input.priorBeta ?? 19,
    sustainableThreshold: 0.05,
  });
  const block = (code: string, reason: string) => bidResult(input, posterior, 'BLOCK', 0, code, reason, 99, 12);
  if (input.currentBid <= 0) return block('CURRENT_BID_MISSING', 'Bid atual não confirmado; nenhuma escrita é segura.');
  if (input.pendingInsertion) return block('PENDING_INSERTION', 'Entidade ainda está em inserção na Amazon.');
  if (!input.dataFresh) return block('STALE_DATA', 'Métricas vencidas bloqueiam alteração de bid.');
  if (!input.structurallyComplete || !input.adGroupConfirmed || !input.productAdConfirmed) return block('STRUCTURE_INCOMPLETE', 'Campanha, Ad Group e Product Ad precisam estar confirmados.');
  if (!input.inStock) return block('OUT_OF_STOCK', 'Produto sem estoque vendável confirmado.');
  if (!input.economicsComplete || input.safeMaxCpc <= 0) return block('ECONOMICS_INCOMPLETE', 'Economia ou CPC seguro indisponível.');
  if (input.cooldownActive) return block('COOLDOWN_ACTIVE', 'Já houve alteração na janela de cooldown.');
  if (input.winnerProtected) return bidResult(input, posterior, 'HOLD', 0, 'WINNER_PROTECTED', 'Venda same-SKU e lucro protegem a entidade até a próxima janela.', 99, 12);
  if (input.ageHours < 48) return bidResult(input, posterior, 'HOLD', 0, 'INITIAL_OBSERVATION_48H', 'Primeiras 48 horas reservadas para observação; somente risco financeiro crítico pode usar rota defensiva separada.', 98, 48);

  if (input.impressions <= 0 && input.clicks <= 0) {
    if (input.currentBid >= input.safeMaxCpc) return block('SAFE_CPC_CEILING', 'Sem impressões, mas o bid já alcançou o CPC seguro.');
    const pct = input.ageHours >= 24 && !input.lowVolumeGuarded ? 0.05 : 0.03;
    return bidResult(input, posterior, 'RECOVER_ZERO_DELIVERY', pct, 'ZERO_IMPRESSIONS_SAFE_RECOVERY', `Zero impressão com estrutura, estoque e economia válidos: teste controlado de ${Math.round(pct * 100)}%.`, 91, input.lowVolumeGuarded ? 24 : 12);
  }

  if (input.impressions > 0 && input.clicks <= 0) {
    if (input.impressions >= 500) return bidResult(input, posterior, 'DECREASE_SOFT', -0.05, 'MATURE_IMPRESSIONS_NO_CLICK', 'Amostra madura de impressões sem clique; reduzir exposição, nunca aumentar.', 88, 24);
    return bidResult(input, posterior, 'HOLD', 0, 'IMPRESSIONS_NO_CLICK_HOLD', 'Há entrega sem clique, mas a amostra ainda não permite intervenção.', 82, 12);
  }

  if (input.sameSkuOrders <= 0) {
    const spentLimit = input.maxSpendWithoutSale > 0 && input.spend >= input.maxSpendWithoutSale;
    const sustainableProbabilityLow = posterior.probabilityAboveThreshold < 0.20;
    const mature = input.clicks >= 8 && input.attributionComplete;
    if (!mature || (!spentLimit && !sustainableProbabilityLow)) return bidResult(input, posterior, 'HOLD', 0, 'NO_SALE_WAIT_ATTRIBUTION', 'Cliques sem venda ainda preservados pela atribuição ou probabilidade posterior.', 86, 12);
    if (input.priorReductionCount >= 3 && input.clicks >= 30) {
      return bidResult(input, posterior, 'PAUSE_CANDIDATE', 0, 'TERM_REPLACEMENT_REVIEW', 'Após reduções graduais e nova evidência, o termo pode ser substituído ou revisado; a campanha não é pausada.', 92, 24);
    }
    const concentrationPct = input.spendShare >= 0.45 ? 0.15 : input.spendShare >= 0.35 ? 0.10 : input.spendShare >= 0.25 ? 0.05 : 0;
    const progressionPct = input.priorReductionCount >= 2 ? 0.20 : input.priorReductionCount >= 1 ? 0.10 : 0.05;
    const pct = Math.max(concentrationPct, progressionPct);
    return bidResult(input, posterior, pct >= 0.10 ? 'DECREASE_STRONG' : 'DECREASE_SOFT', -pct,
      'CLICKS_NO_SAME_SKU_SALE', `Posterior Bayesiano e gasto de teste indicam redução gradual de ${Math.round(pct * 100)}%; halo não conta como venda do SKU.`,
      pct >= 0.10 ? 94 : 88, input.lowVolumeGuarded ? 48 : 24);
  }

  if (input.profitAfterAds < 0 || (input.acos !== null && input.breakEvenAcos !== null && input.acos > input.breakEvenAcos)) {
    return bidResult(input, posterior, 'DECREASE_STRONG', -0.20, 'CONFIRMED_ECONOMIC_LOSS', 'Venda same-SKU existe, mas ACoS acima do break-even ou lucro pós-Ads negativo exige defesa.', 97, 24);
  }
  if (input.acos !== null && input.targetAcos !== null && input.acos > input.targetAcos) {
    return bidResult(input, posterior, 'DECREASE_SOFT', -0.05, 'ABOVE_TARGET_BELOW_BREAK_EVEN', 'Resultado acima da meta e abaixo do break-even: redução suave.', 92, 24);
  }
  if (input.defensive) return bidResult(input, posterior, 'HOLD', 0, 'DEFENSIVE_HOLD', 'Estado defensivo bloqueia crescimento.', 98, 24);
  if (input.currentBid >= input.safeMaxCpc) return bidResult(input, posterior, 'HOLD', 0, 'SAFE_CPC_HOLD', 'Bid já alcançou o CPC seguro.', 97, 24);
  return bidResult(input, posterior, 'INCREASE', 0.03, 'PROFITABLE_GROWTH_TEST', 'Venda same-SKU lucrativa permite teste de crescimento de 3% dentro do CPC seguro.', 90, 24);
}

export function evaluateDecisionGovernance(input: GovernanceInput): GovernanceResult {
  const blockers: GovernanceResult['blockers'] = [];
  const add = (priority: string, code: string, reason: string) => blockers.push({ priority, code, reason });
  const action = lower(input.actionType);
  const isBid = action.includes('bid');
  const isBudget = action.includes('budget');
  const isPause = action.includes('pause');
  const isPrice = action.includes('price') || input.entityType === 'product_price';
  const isIncrease = action.includes('increase') || (Number(input.proposedValue) > Number(input.currentValue));
  const isDecrease = action.includes('decrease') || (Number(input.proposedValue) < Number(input.currentValue));

  if (input.accountKillSwitch) add('P1', 'ACCOUNT_KILL_SWITCH', 'Kill switch da conta está ativo.');
  const cap = Number(input.accountDailyCap || 0);
  const committed = Number(input.accountSpend || 0) + Number(input.reservedPendingSpend || 0) + Number(input.proposedSpendImpact || 0);
  if ((isIncrease || isBudget) && cap > 0 && committed > cap) add('P1', 'ACCOUNT_DAILY_CAP', 'Gasto real, pendente e proposto ultrapassa o teto diário.');
  if (!input.snapshotId) add('P2', 'SNAPSHOT_REQUIRED', 'Toda decisão deve referenciar o snapshot canônico.');
  if (!input.dataFresh || input.adsDataFresh === false || input.spApiDataFresh === false || input.economicsDataFresh === false) add('P2', 'STALE_DATA', 'Uma ou mais fontes obrigatórias estão vencidas.');
  if (!input.productEligible || !input.listingActive || !input.offerActive || !input.buyable || !input.inStock) add('P3', 'PRODUCT_NOT_ELIGIBLE', 'Produto, listing, oferta, Buy Box ou estoque bloqueiam a ação.');
  if (!input.economicsComplete) add('P4', 'ECONOMICS_INCOMPLETE', 'Custos, taxas ou margem não estão confirmados.');
  if (Number(input.economicConfidence || 0) < Number(input.minEconomicConfidence ?? 0.90)) add('P4', 'LOW_ECONOMIC_CONFIDENCE', 'Confiança econômica abaixo do mínimo.');
  if (input.winnerProtected && input.sameSkuOrders && (isPause || (isBid && isDecrease))) add('P5', 'WINNER_PROTECTED', 'Winner confirmado por venda same-SKU está protegido.');
  if (input.winnerProtected && !input.sameSkuOrders && Number(input.haloOrders || 0) > 0) add('P5', 'HALO_NOT_WINNER_PROOF', 'Venda halo não protege o SKU anunciado.');
  if (input.cooldownActive) add('P6', 'COOLDOWN_ACTIVE', 'Entidade já foi alterada na janela de cooldown.');
  if (isPause && Number(input.campaignPauseShare || 0) > 0.50) add('P1', 'BATCH_PAUSE_BLOCKED_50', 'Mais de 50% das campanhas nunca pode ser pausado em lote.');
  else if (isPause && Number(input.campaignPauseShare || 0) > 0.30 && !input.explicitBatchAuthorization) add('P1', 'BATCH_PAUSE_REQUIRES_AUTH', 'Mais de 30% de pausas exige autorização explícita.');
  const reason = lower(`${input.reasonCode || ''} ${input.reason || ''}`);
  if (isPause && /zero.*(sale|venda|conversion|convers)|sem venda|no.?conversion/.test(reason) && !/structural|estrutural|out.?of.?stock|sem estoque|invalid|duplic/.test(reason)) add('P7', 'NO_SALE_PAUSE_BLOCKED', 'Ausência de venda isolada nunca pausa campanha.');

  if (isBid && input.currentValue && input.proposedValue) {
    const change = (Number(input.proposedValue) - Number(input.currentValue)) / Number(input.currentValue);
    const standardIncrease = Number(input.maxBidIncreasePct ?? 0.10);
    const absoluteIncrease = Number(input.absoluteBidIncreasePct ?? 0.20);
    const maxReduction = Number(input.maxBidReductionPct ?? 0.20);
    if (change > absoluteIncrease + 1e-9) add('P1', 'BID_ABSOLUTE_INCREASE_LIMIT', 'Aumento ultrapassa o limite absoluto de bid.');
    else if (change > standardIncrease + 1e-9 && input.confidence < 0.95) add('P8', 'BID_STANDARD_INCREASE_LIMIT', 'Aumento acima do padrão exige confiança alta.');
    if (change < -maxReduction - 1e-9) add('P7', 'BID_REDUCTION_LIMIT', 'Redução ultrapassa o limite por ciclo.');
    if (isIncrease && Number(input.safeMaxCpc || 0) > 0 && Number(input.proposedValue) > Number(input.safeMaxCpc)) add('P4', 'SAFE_CPC_EXCEEDED', 'Bid proposto ultrapassa o CPC seguro.');
    if (isIncrease && (input.defensive || Number(input.profitAfterAds || 0) < 0)) add('P8', 'DEFENSIVE_GROWTH_BLOCKED', 'Perda confirmada ou estado defensivo bloqueia aumento.');
  }
  if (isBudget && isIncrease && Number(input.stockCoverageDays ?? 999) < 14) add('P6', 'LOW_STOCK_BUDGET_INCREASE', 'Estoque baixo bloqueia aumento de budget.');

  if (isPrice) {
    if (input.parentAsin) add('P3', 'PARENT_ASIN_BLOCKED', 'Repricing opera somente em SKU e ASIN-filho.');
    if (input.competitionFresh === false) add('P2', 'STALE_COMPETITION', 'Dados oficiais de competição estão vencidos.');
    if (Number(input.predictionConfidence || 0) < Number(input.minPredictionConfidence ?? 0.90)) add('P9', 'LOW_PREDICTION_CONFIDENCE', 'Confiança de previsão abaixo de 90%.');
    if (isDecrease && Number(input.proposedValue || 0) < Number(input.economicFloor || 0)) add('P4', 'PRICE_BELOW_FLOOR', 'Preço proposto fica abaixo do piso econômico.');
    if (isDecrease && (Number(input.stockCoverageDays ?? 999) < 14 || Number(input.profitAfterAds || 0) < 0 || (input.currentAcos !== null && input.targetAcos !== null && Number(input.currentAcos) > Number(input.targetAcos)))) add('P4', 'PRICE_DECREASE_WORSENS_MARGIN', 'Estoque baixo, perda pós-Ads ou ACoS alto bloqueiam redução de preço.');
  }
  if (input.confidence < 0.50) add('P10', 'LOW_DECISION_CONFIDENCE', 'Confiança geral insuficiente.');
  if (!input.rollbackPlan) add('P10', 'ROLLBACK_PLAN_REQUIRED', 'Toda ação executável precisa de rollback lógico.');

  blockers.sort((a, b) => Number(a.priority.slice(1)) - Number(b.priority.slice(1)));
  return { allowed: blockers.length === 0, blockers, priority: blockers[0]?.priority || (isPrice ? 'P8' : isIncrease ? 'P8' : 'P7'), rollbackRequired: true };
}

export function canonicalDecisionIdempotencyKey(input: {
  accountId: string;
  profileId: string;
  marketplaceId: string;
  entityType: string;
  entityId: string;
  actionType: string;
  decisionWindow: string;
}) {
  return [input.accountId, input.profileId, input.marketplaceId, input.entityType, input.entityId, input.actionType, input.decisionWindow]
    .map((value) => String(value || 'unknown').trim().toLowerCase()).join('|');
}

export function canonicalEntityLockKey(input: {
  accountId: string;
  sku?: string | null;
  campaignId?: string | null;
  entityId?: string | null;
  decisionWindow: string;
}) {
  return ['marketplace-decision', input.accountId, input.sku || '-', input.campaignId || '-', input.entityId || '-', input.decisionWindow]
    .map((value) => String(value).trim().toLowerCase()).join('|');
}
