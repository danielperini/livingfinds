export const ECONOMIC_BALANCER_VERSION = 'economic-budget-balancer-v1';

export type CampaignEconomicState =
  | 'NEW_PENDING_INSERTION'
  | 'NEW_NO_IMPRESSIONS'
  | 'NEW_IMPRESSIONS_NO_CLICKS'
  | 'LEARNING_LOW_TRAFFIC'
  | 'LEARNING_BALANCED'
  | 'OVERSHARE_NO_CONVERSION'
  | 'OVERSHARE_WITH_CONVERSION'
  | 'LOW_VOLUME_GUARDED'
  | 'PROTECTED_WINNER'
  | 'ECONOMICALLY_UNSAFE'
  | 'OUT_OF_STOCK'
  | 'DATA_STALE'
  | 'INCOMPLETE'
  | 'NOT_ELIGIBLE';

export type EconomicBalancerConfig = {
  accountDailyBudgetLimit: number;
  maxCampaignSpendShare: number;
  maxAutoDiscoveryShare: number;
  autoDiscoveryTargetShare: number;
  manualLearningTargetShare: number;
  winnerTargetShare: number;
  guardedTargetShare: number;
  overshareWarningThreshold: number;
  overshareReductionThreshold: number;
  maxBidIncreasePct: number;
  maxBidDecreasePct: number;
  zeroImpressionIncreasePct: number;
  noClickIncreasePct: number;
  noClickReductionPct: number;
  clickReductionSoftPct: number;
  clickReductionMediumPct: number;
  clickReductionStrongPct: number;
  clickSoftStart: number;
  clickMediumStart: number;
  clickStrongStart: number;
  maxSpendWithoutSale: number;
  testToleranceFactor: number;
  minBid: number;
  maxBid: number;
  maximumCampaignBudget: number;
  maxBudgetIncreasePct: number;
  maximumImpressionsWithoutClick: number;
  learningObserveHours: number;
  learningWindowHours: number;
  metricsFreshMinutes: number;
  decisionWindowMinutes: number;
  cooldownHours: number;
  lowVolumeCooldownHours: number;
  maxChangesPerCycle: number;
  maxChangesPerHour: number;
};

export type CampaignClassificationInput = {
  campaignType: unknown;
  isAuto: boolean;
  state: unknown;
  amazonStatus?: unknown;
  ageHours: number;
  dataFresh: boolean;
  structurallyComplete: boolean;
  economicsAvailable: boolean;
  inStock: boolean;
  impressions: number;
  clicks: number;
  orders: number;
  sales: number;
  spendShare: number;
  targetShare: number;
  lowVolume: boolean;
  profitAfterAds: number;
  acos: number | null;
  targetAcos: number | null;
};

export type VirtualBudgetCandidate = {
  campaignId: string;
  isAuto: boolean;
  ageHours: number;
  classification: CampaignEconomicState;
  marginPercent: number;
  economicConfidence: number;
  stockCoverageDays: number | null;
  profitAfterAds: number;
};

export type VirtualBudgetAllocation = {
  campaignId: string;
  targetShare: number;
  virtualBudget: number;
  segment: 'auto_discovery' | 'manual_learning' | 'winner' | 'guarded';
  weight: number;
};

export type AdjustmentInput = {
  classification: CampaignEconomicState;
  ageHours: number;
  isAuto: boolean;
  highlyRelevant: boolean;
  economicsAvailable: boolean;
  currentBid: number;
  currentBudget: number;
  safeMaxCpc: number;
  impressions: number;
  clicks: number;
  orders: number;
  sales: number;
  spend: number;
  spendShare: number;
  targetShare: number;
  maxSpendWithoutSale: number;
  budgetExhausted: boolean;
  remainingAccountBudget: number;
  budgetOptimizationEnabled: boolean;
};

export type EconomicAdjustment = {
  action: 'observe' | 'increase_bid' | 'reduce_bid' | 'increase_budget';
  valueAfter: number | null;
  changePct: number;
  rule: string;
  reason: string;
  confidence: number;
  nextReviewHours: number;
  blockedBy?: string;
};

const finite = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const roundMoney = (value: number): number => Math.round(value * 100) / 100;

const fraction = (value: unknown, fallback: number): number => {
  const parsed = finite(value, fallback);
  return clamp(parsed > 1 ? parsed / 100 : parsed, 0, 1);
};

const active = (value: unknown): boolean =>
  ['enabled', 'active'].includes(String(value || '').trim().toLowerCase());

const pendingInsertion = (value: unknown): boolean => {
  const normalized = String(value || '').trim().toLowerCase();
  return ['pending', 'pending_insertion', 'insertion', 'incomplete', 'draft', 'processing'].includes(normalized);
};

export function resolveEconomicBalancerConfig(raw: Record<string, unknown> = {}): EconomicBalancerConfig {
  const maxBidIncreasePct = Math.min(0.06, fraction(raw.max_bid_increase_pct, 0.06));
  const maxBidDecreasePct = Math.min(0.20, fraction(raw.max_bid_decrease_pct, 0.12));
  return {
    accountDailyBudgetLimit: Math.max(1, finite(
      raw.account_daily_budget_limit ?? raw.daily_budget_limit ?? raw.total_daily_budget,
      80,
    )),
    maxCampaignSpendShare: fraction(raw.max_campaign_spend_share, 0.25),
    maxAutoDiscoveryShare: fraction(raw.max_auto_discovery_share, 0.30),
    autoDiscoveryTargetShare: fraction(raw.auto_discovery_target_share, 0.25),
    manualLearningTargetShare: fraction(raw.manual_learning_target_share, 0.35),
    winnerTargetShare: fraction(raw.winner_target_share, 0.40),
    guardedTargetShare: fraction(raw.guarded_target_share, 0.10),
    overshareWarningThreshold: fraction(raw.overshare_warning_threshold, 0.25),
    overshareReductionThreshold: fraction(raw.overshare_reduction_threshold, 0.35),
    maxBidIncreasePct,
    maxBidDecreasePct,
    zeroImpressionIncreasePct: Math.min(maxBidIncreasePct, fraction(raw.zero_impression_bid_increase_pct, 0.05)),
    noClickIncreasePct: Math.min(0.03, fraction(raw.no_click_bid_increase_pct, 0.025)),
    noClickReductionPct: Math.min(maxBidDecreasePct, fraction(raw.no_click_bid_reduction_pct, 0.03)),
    clickReductionSoftPct: Math.min(maxBidDecreasePct, fraction(raw.click_reduction_soft_pct, 0.06)),
    clickReductionMediumPct: Math.min(maxBidDecreasePct, fraction(raw.click_reduction_medium_pct, 0.10)),
    clickReductionStrongPct: Math.min(0.12, maxBidDecreasePct, fraction(raw.click_reduction_strong_pct, 0.12)),
    clickSoftStart: Math.max(1, Math.floor(finite(raw.click_reduction_soft_start, 5))),
    clickMediumStart: Math.max(2, Math.floor(finite(raw.click_reduction_medium_start, 16))),
    clickStrongStart: Math.max(3, Math.floor(finite(raw.click_reduction_strong_start, 26))),
    maxSpendWithoutSale: Math.max(0, finite(raw.max_spend_without_sale, 0)),
    testToleranceFactor: clamp(finite(raw.test_tolerance_factor, 1.25), 0.5, 3),
    minBid: Math.max(0.02, finite(raw.min_bid, 0.10)),
    maxBid: Math.min(1, Math.max(0.02, finite(raw.max_bid, 1))),
    maximumCampaignBudget: Math.max(5, finite(raw.maximum_campaign_budget, 100)),
    maxBudgetIncreasePct: Math.min(0.20, fraction(raw.max_budget_increase_pct, 0.10)),
    maximumImpressionsWithoutClick: Math.max(20, Math.floor(finite(raw.maximum_impressions_without_click, 100))),
    learningObserveHours: clamp(finite(raw.learning_observe_hours, 6), 1, 24),
    learningWindowHours: clamp(finite(raw.learning_window_hours, 24), 6, 72),
    metricsFreshMinutes: clamp(finite(raw.economic_metrics_fresh_minutes, 30), 10, 180),
    decisionWindowMinutes: clamp(finite(raw.economic_decision_window_minutes, 15), 10, 60),
    cooldownHours: clamp(finite(raw.economic_cooldown_hours, 6), 1, 72),
    lowVolumeCooldownHours: clamp(finite(raw.low_volume_cooldown_hours, 24), 6, 168),
    maxChangesPerCycle: clamp(Math.floor(finite(raw.max_changes_per_cycle, 20)), 1, 100),
    maxChangesPerHour: clamp(Math.floor(finite(raw.max_changes_per_hour, 40)), 1, 200),
  };
}

export function calculateMaxSpendWithoutSale(
  config: EconomicBalancerConfig,
  allowableAdSpendPerOrder: number,
): number {
  if (config.maxSpendWithoutSale > 0) return roundMoney(config.maxSpendWithoutSale);
  if (allowableAdSpendPerOrder <= 0) return 0;
  return roundMoney(allowableAdSpendPerOrder * config.testToleranceFactor);
}

export function classifyEconomicCampaign(
  input: CampaignClassificationInput,
  config: EconomicBalancerConfig,
): CampaignEconomicState {
  if (String(input.campaignType || 'SP').toUpperCase() !== 'SP') return 'NOT_ELIGIBLE';
  if (pendingInsertion(input.state) || pendingInsertion(input.amazonStatus)) return 'NEW_PENDING_INSERTION';
  if (!active(input.state)) return 'NOT_ELIGIBLE';
  if (!input.structurallyComplete) return 'INCOMPLETE';
  if (!input.inStock) return 'OUT_OF_STOCK';
  if (!input.dataFresh) return 'DATA_STALE';
  if (!input.economicsAvailable) return 'ECONOMICALLY_UNSAFE';

  const targetAcos = input.targetAcos || 0;
  const winner = input.orders >= 2 && input.sales > 0 && input.profitAfterAds > 0 &&
    input.acos !== null && (targetAcos <= 0 || input.acos <= targetAcos);
  if (winner) return 'PROTECTED_WINNER';

  const absoluteShareCap = input.isAuto
    ? Math.min(config.maxCampaignSpendShare, config.maxAutoDiscoveryShare)
    : config.maxCampaignSpendShare;
  const shareCap = Math.min(
    absoluteShareCap,
    input.targetShare > 0 ? Math.max(input.targetShare * 1.5, config.overshareWarningThreshold) : config.overshareWarningThreshold,
  );
  if (input.spendShare >= shareCap) {
    return input.orders > 0 || input.sales > 0
      ? 'OVERSHARE_WITH_CONVERSION'
      : 'OVERSHARE_NO_CONVERSION';
  }

  if (input.lowVolume) return 'LOW_VOLUME_GUARDED';
  if (input.impressions <= 0 && input.clicks <= 0) return 'NEW_NO_IMPRESSIONS';
  if (input.impressions > 0 && input.clicks <= 0) return 'NEW_IMPRESSIONS_NO_CLICKS';
  if (input.ageHours < config.learningWindowHours || input.clicks < config.clickSoftStart) {
    return 'LEARNING_LOW_TRAFFIC';
  }
  return 'LEARNING_BALANCED';
}

function segmentFor(candidate: VirtualBudgetCandidate): VirtualBudgetAllocation['segment'] {
  if (candidate.classification === 'PROTECTED_WINNER') return 'winner';
  if (!candidate.isAuto && candidate.ageHours <= 24) return 'manual_learning';
  if (candidate.isAuto) return 'auto_discovery';
  return 'guarded';
}

function candidateWeight(candidate: VirtualBudgetCandidate): number {
  const marginMultiplier = 1 + clamp(candidate.marginPercent, 0, 50) / 100;
  const confidenceMultiplier = 0.5 + clamp(candidate.economicConfidence, 0, 100) / 200;
  const stockMultiplier = candidate.stockCoverageDays === null
    ? 0.8
    : candidate.stockCoverageDays < 7 ? 0.45
      : candidate.stockCoverageDays < 14 ? 0.75
        : candidate.stockCoverageDays >= 45 ? 1.10 : 1;
  const riskMultiplier = ['ECONOMICALLY_UNSAFE', 'DATA_STALE', 'INCOMPLETE', 'NOT_ELIGIBLE', 'OUT_OF_STOCK']
      .includes(candidate.classification)
    ? 0.05
    : candidate.classification === 'OVERSHARE_NO_CONVERSION' ? 0.30
      : candidate.classification === 'LOW_VOLUME_GUARDED' ? 0.55 : 1;
  const profitMultiplier = candidate.profitAfterAds > 0 ? 1.15 : 1;
  return Math.max(0.0001, marginMultiplier * confidenceMultiplier * stockMultiplier * riskMultiplier * profitMultiplier);
}

export function allocateVirtualBudgets(
  candidates: VirtualBudgetCandidate[],
  accountDailyBudgetLimit: number,
  config?: Pick<EconomicBalancerConfig,
    'maxAutoDiscoveryShare' | 'autoDiscoveryTargetShare' | 'manualLearningTargetShare' | 'winnerTargetShare' | 'guardedTargetShare'>,
): VirtualBudgetAllocation[] {
  if (!candidates.length || accountDailyBudgetLimit <= 0) return [];
  const segmentShares: Record<VirtualBudgetAllocation['segment'], number> = {
    auto_discovery: Math.min(config?.autoDiscoveryTargetShare ?? 0.25, config?.maxAutoDiscoveryShare ?? 0.30),
    manual_learning: config?.manualLearningTargetShare ?? 0.35,
    winner: config?.winnerTargetShare ?? 0.40,
    guarded: config?.guardedTargetShare ?? 0.10,
  };
  const grouped = new Map<VirtualBudgetAllocation['segment'], Array<VirtualBudgetCandidate & { weight: number }>>();
  for (const candidate of candidates) {
    const segment = segmentFor(candidate);
    const rows = grouped.get(segment) || [];
    rows.push({ ...candidate, weight: candidateWeight(candidate) });
    grouped.set(segment, rows);
  }
  let presentShare = Array.from(grouped.keys()).reduce((sum, segment) => sum + segmentShares[segment], 0);
  if (presentShare <= 0) {
    for (const segment of grouped.keys()) segmentShares[segment] = 1;
    presentShare = grouped.size;
  }
  const normalizedShares = new Map<VirtualBudgetAllocation['segment'], number>();
  for (const segment of grouped.keys()) {
    normalizedShares.set(segment, segmentShares[segment] / presentShare);
  }
  const autoShare = normalizedShares.get('auto_discovery') || 0;
  const maxAutoShare = config?.maxAutoDiscoveryShare ?? 0.30;
  if (autoShare > maxAutoShare) {
    const excess = autoShare - maxAutoShare;
    normalizedShares.set('auto_discovery', maxAutoShare);
    const otherSegments = Array.from(grouped.keys()).filter((segment) => segment !== 'auto_discovery');
    const otherShare = otherSegments.reduce((sum, segment) => sum + (normalizedShares.get(segment) || 0), 0);
    if (otherShare > 0) {
      for (const segment of otherSegments) {
        const share = normalizedShares.get(segment) || 0;
        normalizedShares.set(segment, share + excess * share / otherShare);
      }
    }
  }
  const allocations: VirtualBudgetAllocation[] = [];
  for (const [segment, rows] of grouped.entries()) {
    const normalizedSegmentShare = normalizedShares.get(segment) || 0;
    const totalWeight = rows.reduce((sum, row) => sum + row.weight, 0);
    for (const row of rows) {
      const targetShare = normalizedSegmentShare * row.weight / totalWeight;
      allocations.push({
        campaignId: row.campaignId,
        targetShare,
        virtualBudget: roundMoney(accountDailyBudgetLimit * targetShare),
        segment,
        weight: row.weight,
      });
    }
  }
  return allocations;
}

function observe(rule: string, reason: string, confidence = 80, nextReviewHours = 6, blockedBy?: string): EconomicAdjustment {
  return { action: 'observe', valueAfter: null, changePct: 0, rule, reason, confidence, nextReviewHours, blockedBy };
}

function bidAdjustment(
  action: 'increase_bid' | 'reduce_bid',
  input: AdjustmentInput,
  config: EconomicBalancerConfig,
  pct: number,
  rule: string,
  reason: string,
  confidence: number,
  nextReviewHours: number,
): EconomicAdjustment {
  if (!Number.isFinite(input.currentBid) || input.currentBid <= 0) {
    return observe(`${rule}_BID_NOT_CONFIRMED`, 'Bid atual ausente ou invalido; nenhuma escrita foi proposta.', 99, nextReviewHours, 'CURRENT_BID_MISSING');
  }
  const boundedPct = action === 'increase_bid'
    ? Math.min(pct, config.maxBidIncreasePct)
    : Math.min(pct, config.maxBidDecreasePct, 0.20);
  const raw = action === 'increase_bid'
    ? input.currentBid * (1 + boundedPct)
    : input.currentBid * (1 - boundedPct);
  const ceiling = action === 'increase_bid'
    ? Math.min(config.maxBid, input.safeMaxCpc > 0 ? input.safeMaxCpc : config.maxBid)
    : config.maxBid;
  let valueAfter = roundMoney(clamp(raw, config.minBid, ceiling));
  let actualChange = (valueAfter - input.currentBid) / input.currentBid;
  const absoluteLimit = action === 'increase_bid' ? config.maxBidIncreasePct : config.maxBidDecreasePct;
  if (action === 'increase_bid' && actualChange > absoluteLimit) {
    valueAfter = Math.floor(input.currentBid * (1 + absoluteLimit) * 100 + 1e-9) / 100;
  } else if (action === 'reduce_bid' && -actualChange > absoluteLimit) {
    valueAfter = Math.ceil(input.currentBid * (1 - absoluteLimit) * 100 - 1e-9) / 100;
  }
  valueAfter = clamp(valueAfter, config.minBid, ceiling);
  actualChange = (valueAfter - input.currentBid) / input.currentBid;
  if (Math.abs(valueAfter - input.currentBid) < 0.005) {
    return observe(`${rule}_NO_HEADROOM`, 'O bid ja esta no limite economico ou tecnico configurado.', confidence, nextReviewHours, 'BID_ENVELOPE');
  }
  return { action, valueAfter, changePct: actualChange, rule, reason, confidence, nextReviewHours };
}

export function proposeEconomicAdjustment(
  input: AdjustmentInput,
  config: EconomicBalancerConfig,
): EconomicAdjustment {
  if (input.ageHours < config.learningObserveHours) {
    return observe('LEARNING_OBSERVE_ONLY', `Campanha ativa ha ${input.ageHours.toFixed(1)}h; observar ate ${config.learningObserveHours}h.`, 95, config.learningObserveHours);
  }

  if (['NEW_PENDING_INSERTION', 'OUT_OF_STOCK', 'DATA_STALE', 'INCOMPLETE', 'NOT_ELIGIBLE'].includes(input.classification)) {
    return observe(`BLOCKED_${input.classification}`, `Nenhuma alteracao de bid permitida no estado ${input.classification}.`, 99, 12, input.classification);
  }

  if (input.classification === 'PROTECTED_WINNER') {
    if (input.budgetOptimizationEnabled && input.budgetExhausted && input.remainingAccountBudget >= 2 && input.currentBudget > 0) {
      const nextBudget = roundMoney(Math.min(
        config.maximumCampaignBudget,
        input.currentBudget * (1 + config.maxBudgetIncreasePct),
        input.currentBudget + input.remainingAccountBudget,
      ));
      if (nextBudget > input.currentBudget + 0.01) {
        return {
          action: 'increase_budget',
          valueAfter: nextBudget,
          changePct: (nextBudget - input.currentBudget) / input.currentBudget,
          rule: 'PROTECTED_WINNER_BUDGET_HEADROOM',
          reason: 'Campanha vencedora, lucrativa e limitada por budget recebeu apenas o headroom real ainda disponivel na conta.',
          confidence: 96,
          nextReviewHours: 6,
        };
      }
    }
    return observe('PROTECTED_WINNER_HOLD', 'Campanha vencedora protegida contra reducao por oscilacao curta.', 99, 6);
  }

  if (input.classification === 'OVERSHARE_WITH_CONVERSION') {
    return observe('OVERSHARE_WITH_CONVERSION_HOLD', 'Participacao alta, mas com conversao; preservar e revisar lucro antes de reduzir.', 95, 6);
  }

  if (!input.economicsAvailable) {
    if (input.sales <= 0 && input.spendShare >= config.overshareWarningThreshold && input.currentBid > config.minBid) {
      return bidAdjustment('reduce_bid', input, config, Math.min(0.08, config.maxBidDecreasePct),
        'ECONOMICS_MISSING_PROTECTIVE_REDUCTION',
        'Dados economicos incompletos bloquearam aumentos; a concentracao de gasto permite somente reducao protetiva.',
        82, 12);
    }
    return observe('ECONOMICS_MISSING_BLOCK_INCREASE', 'Preco, custo ou margem incompletos; aumentos bloqueados.', 99, 12, 'ECONOMIC_DATA_MISSING');
  }

  if (input.classification === 'OVERSHARE_NO_CONVERSION') {
    const pct = input.spendShare >= config.overshareReductionThreshold || input.clicks >= config.clickMediumStart
      ? config.clickReductionStrongPct
      : Math.min(0.10, config.maxBidDecreasePct);
    return bidAdjustment('reduce_bid', input, config, pct, 'OVERSHARE_NO_CONVERSION',
      `Campanha consumiu ${(input.spendShare * 100).toFixed(1)}% do gasto diario, acumulou ${input.clicks} cliques e nao gerou vendas; reduzir gradualmente, sem pausar.`,
      input.spendShare >= config.overshareReductionThreshold ? 97 : 92, 6);
  }

  if (input.sales <= 0 && input.clicks >= config.clickSoftStart) {
    let pct = config.clickReductionSoftPct;
    let rule = 'CLICKS_NO_SALE_SOFT';
    if (input.clicks >= config.clickStrongStart) {
      pct = config.clickReductionStrongPct;
      rule = 'CLICKS_NO_SALE_STRONG';
    } else if (input.clicks >= config.clickMediumStart) {
      pct = config.clickReductionMediumPct;
      rule = 'CLICKS_NO_SALE_MEDIUM';
    }
    if (input.maxSpendWithoutSale > 0 && input.spend >= input.maxSpendWithoutSale) {
      pct = config.clickReductionStrongPct;
      rule = 'MAX_SPEND_WITHOUT_SALE';
    }
    return bidAdjustment('reduce_bid', input, config, pct, rule,
      `${input.clicks} cliques e R$${input.spend.toFixed(2)} sem venda; reducao progressiva, sem pausa automatica.`,
      rule === 'CLICKS_NO_SALE_SOFT' ? 82 : 94,
      input.classification === 'LOW_VOLUME_GUARDED' ? config.lowVolumeCooldownHours : config.cooldownHours);
  }

  if (input.classification === 'NEW_NO_IMPRESSIONS' ||
      (input.classification === 'LOW_VOLUME_GUARDED' && input.impressions <= 0)) {
    if (input.safeMaxCpc <= 0 || input.currentBid >= input.safeMaxCpc) {
      return observe('ZERO_IMPRESSIONS_ECONOMIC_CEILING', 'Sem impressoes, mas nao existe headroom abaixo do CPC maximo sustentavel.', 98, 12, 'SUSTAINABLE_CPC');
    }
    const staleZeroDelivery = input.ageHours >= 168;
    const pct = input.classification === 'LOW_VOLUME_GUARDED' || input.ageHours < config.learningWindowHours
      ? Math.min(0.03, config.zeroImpressionIncreasePct)
      : config.zeroImpressionIncreasePct;
    return bidAdjustment('increase_bid', input, config, pct, staleZeroDelivery ? 'STALE_ZERO_DELIVERY_RECOVERY' : 'ZERO_IMPRESSIONS_SAFE_ENTRY',
      staleZeroDelivery
        ? `Campanha ativa há 7+ dias sem entrega; priorizada para recuperação com bid limitado ao CPC econômico.`
        : `Campanha ativa e estruturalmente valida sem impressoes; aumento controlado de ate ${(pct * 100).toFixed(1)}% para tentar entrar no leilao.`,
      90, input.classification === 'LOW_VOLUME_GUARDED' ? config.lowVolumeCooldownHours : config.cooldownHours);
  }

  if (input.classification === 'NEW_IMPRESSIONS_NO_CLICKS') {
    if (input.impressions >= config.maximumImpressionsWithoutClick) {
      return bidAdjustment('reduce_bid', input, config, config.noClickReductionPct, 'IMPRESSIONS_NO_CLICK_GUARD',
        `${input.impressions} impressoes sem clique indicam baixa resposta; nao aumentar exposicao.`,
        88, 12);
    }
    if (input.highlyRelevant && input.safeMaxCpc > input.currentBid) {
      return bidAdjustment('increase_bid', input, config, config.noClickIncreasePct, 'RELEVANT_TERM_LOW_CLICK_ENTRY',
        'Termo manual exact altamente relevante ainda com amostra pequena; aumento minimo e limitado pelo CPC sustentavel.',
        78, 12);
    }
    return observe('IMPRESSIONS_NO_CLICK_HOLD', 'Ha impressoes sem clique; manter bid ate haver evidencia de relevancia ou amostra suficiente.', 85, 12);
  }

  return observe('LEARNING_BALANCED_HOLD', 'Entrega dentro da faixa de aprendizado; manter bid e aguardar novos dados.', 88, 6);
}
