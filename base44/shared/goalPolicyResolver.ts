export type ObjectiveCode =
  | 'profitability' | 'growth' | 'launch' | 'defense' | 'liquidation'
  | 'maintenance' | 'aggressive_peak' | 'flex_stock' | 'custom';
export type PrimaryGoal =
  | 'acos' | 'roas' | 'tacos' | 'cpc' | 'daily_impressions'
  | 'budget_coverage' | 'cost_per_order' | 'growth';
export type ValueState = 'configured' | 'disabled' | 'missing';
export type ResolvedValue<T> = { value: T | null; state: ValueState; source: string | null };
type Layer = { source: string; values?: Record<string, unknown> | null };

const OBJECTIVES: Record<string, string> = {
  profitability: 'Lucratividade', growth: 'Crescimento', launch: 'Lançamento',
  defense: 'Defesa', liquidation: 'Liquidação', maintenance: 'Manutenção',
  aggressive_peak: 'Agressivo em Pico', flex_stock: 'Flex por Estoque', custom: 'Personalizado',
};
const GOAL_FIELDS = [
  'target_acos', 'max_acos', 'target_roas', 'target_tacos', 'max_tacos',
  'target_cpc', 'max_cpc', 'daily_budget_limit', 'target_daily_impressions',
  'min_daily_impressions', 'max_daily_impressions', 'impressions_goal_enabled',
  'target_coverage_hours', 'target_cost_per_order', 'growth_efficiency_enabled',
  'growth_efficiency_target', 'objective', 'objective_base', 'primary_goal',
  'min_bid', 'max_bid', 'max_bid_increase_pct', 'max_bid_decrease_pct',
  'pacing_enabled', 'dayparting_enabled', 'placement_optimization_enabled',
] as const;
const NUMERIC_FIELDS = new Set<string>(GOAL_FIELDS.filter((key) => ![
  'impressions_goal_enabled', 'growth_efficiency_enabled', 'objective', 'objective_base',
  'primary_goal', 'pacing_enabled', 'dayparting_enabled', 'placement_optimization_enabled',
].includes(key)));
const OBJECTIVE_CODES = new Set(Object.keys(OBJECTIVES));
const PRIMARY_GOALS = new Set<PrimaryGoal>([
  'acos', 'roas', 'tacos', 'cpc', 'daily_impressions', 'budget_coverage', 'cost_per_order', 'growth',
]);
const STRATEGY_OBJECTIVE: Record<string, string> = {
  profitability: 'PROFIT', growth: 'SALES_GROWTH', launch: 'LAUNCH', defense: 'DELIVERY_RECOVERY',
  liquidation: 'INVENTORY_CLEARANCE', maintenance: 'BALANCED', aggressive_peak: 'SALES_GROWTH',
  flex_stock: 'SALES_GROWTH', custom: 'CUSTOM',
};
const LIMITS = new Set(['max_acos', 'max_tacos', 'max_cpc', 'daily_budget_limit', 'max_bid']);

const asFiniteNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/**
 * Precedência documentada para metas desejadas: campanha > produto > PerformanceSettings
 * > AutopilotConfig legado. Defaults do sistema nunca preenchem alvos/tetos financeiros.
 * Limites rígidos são intersectados com limites econômicos; nenhum alvo de tráfego
 * ou objetivo estratégico pode relaxar um teto.
 */
export function resolveEffectivePerformanceSettings(input: {
  campaign?: Record<string, unknown> | null;
  product?: Record<string, unknown> | null;
  performanceSettings?: Record<string, unknown> | null;
  autopilotConfig?: Record<string, unknown> | null;
  systemDefaults?: Record<string, unknown> | null;
}) {
  const layers: Layer[] = [
    { source: 'campaign', values: input.campaign },
    { source: 'product', values: input.product },
    { source: 'PerformanceSettings', values: input.performanceSettings },
    { source: 'AutopilotConfig', values: input.autopilotConfig },
    { source: 'system_defaults', values: input.systemDefaults },
  ];
  const values: Record<string, unknown> = {};
  const origins: Record<string, ResolvedValue<unknown>> = {};

  for (const field of GOAL_FIELDS) {
    for (const layer of layers) {
      const record = layer.values;
      if (!record || !Object.prototype.hasOwnProperty.call(record, field)) continue;
      const raw = record[field];
      // Null/undefined means no value at this layer. False and numeric zero are explicit.
      if (raw === null || raw === undefined || raw === '') continue;
      if (NUMERIC_FIELDS.has(field)) {
        const parsed = asFiniteNumber(raw);
        if (parsed === null) continue;
        values[field] = parsed;
        origins[field] = { value: parsed, state: 'configured', source: layer.source };
      } else {
        values[field] = raw;
        origins[field] = {
          value: raw,
          state: typeof raw === 'boolean' && raw === false ? 'disabled' : 'configured',
          source: layer.source,
        };
      }
      break;
    }
    if (!Object.prototype.hasOwnProperty.call(origins, field)) {
      origins[field] = { value: null, state: 'missing', source: null };
    }
  }

  const objectiveValue = String(values.objective || 'custom').toLowerCase();
  const objectiveBase = String(values.objective_base || '').toLowerCase();
  const objective = OBJECTIVE_CODES.has(objectiveValue) ? objectiveValue : 'custom';
  const effectiveStrategy = objective === 'custom' && OBJECTIVE_CODES.has(objectiveBase) && objectiveBase !== 'custom'
    ? objectiveBase
    : objective;
  const primaryRaw = String(values.primary_goal || 'acos').toLowerCase() as PrimaryGoal;
  const primaryGoal = PRIMARY_GOALS.has(primaryRaw) ? primaryRaw : 'acos';

  const hardMaximumAcos = asFiniteNumber(values.max_acos);
  const economicBreakEvenAcos = asFiniteNumber(input.product?.break_even_acos ?? input.product?.breakEvenAcos);
  const effectiveMaximumAcos = hardMaximumAcos === null ? economicBreakEvenAcos
    : economicBreakEvenAcos === null ? hardMaximumAcos : Math.min(hardMaximumAcos, economicBreakEvenAcos);
  const hardMaximumCpc = asFiniteNumber(values.max_cpc);
  const economicMaximumCpc = asFiniteNumber(input.product?.maximum_economic_cpc ?? input.product?.maximumEconomicCpc);
  const effectiveMaximumCpc = hardMaximumCpc === null ? economicMaximumCpc
    : economicMaximumCpc === null ? hardMaximumCpc : Math.min(hardMaximumCpc, economicMaximumCpc);
  const requestedAcos = asFiniteNumber(values.target_acos);
  const targetAcos = requestedAcos === null ? null
    : effectiveMaximumAcos === null ? requestedAcos : Math.min(requestedAcos, effectiveMaximumAcos);
  const requestedCpc = asFiniteNumber(values.target_cpc);
  const targetCpc = requestedCpc;
  const conflicts: Array<{ type: string; message: string; resolution: string }> = [];

  if (requestedAcos !== null && effectiveMaximumAcos !== null && requestedAcos > effectiveMaximumAcos) {
    conflicts.push({
      type: 'ACOS_TARGET_ABOVE_HARD_LIMIT',
      message: `Meta de ACoS (${requestedAcos}%) excede o limite efetivo (${effectiveMaximumAcos}%).`,
      resolution: `Aplicar o limite obrigatório de ${effectiveMaximumAcos}%.`,
    });
  }
  if (requestedCpc !== null && effectiveMaximumCpc !== null && requestedCpc > effectiveMaximumCpc) {
    conflicts.push({
      type: 'CPC_TARGET_ABOVE_HARD_LIMIT',
      message: `Meta de CPC (R$ ${requestedCpc}) excede o teto efetivo (R$ ${effectiveMaximumCpc}).`,
      resolution: `O teto obrigatório de R$ ${effectiveMaximumCpc} prevalece; a meta desejada é mantida.`,
    });
  }
  const requestedRoas = asFiniteNumber(values.target_roas);
  if (requestedAcos !== null && requestedRoas !== null && requestedAcos > 0 && requestedRoas > 0
      && Math.abs((100 / requestedAcos) - requestedRoas) > 0.05) {
    conflicts.push({
      type: 'ACOS_ROAS_TARGETS_DIFFER',
      message: 'Metas de ACoS e ROAS não são equivalentes.',
      resolution: `A meta principal (${primaryGoal}) orienta otimização; ambas permanecem visíveis e o teto de segurança continua obrigatório.`,
    });
  }

  const effectiveValues: Record<string, unknown> = {
    ...values,
    objective,
    objective_base: objective === 'custom' ? objectiveBase || null : null,
    objective_label: OBJECTIVES[objective],
    effective_strategy: effectiveStrategy,
    primary_goal: primaryGoal,
    target_acos: targetAcos,
    requested_target_acos: requestedAcos,
    max_acos: effectiveMaximumAcos,
    target_roas: requestedRoas,
    target_tacos: asFiniteNumber(values.target_tacos),
    max_tacos: asFiniteNumber(values.max_tacos),
    target_cpc: targetCpc,
    max_cpc: effectiveMaximumCpc,
    daily_budget_limit: asFiniteNumber(values.daily_budget_limit),
  };
  const effectiveOrigins = { ...origins };
  if (economicBreakEvenAcos !== null && (hardMaximumAcos === null || economicBreakEvenAcos < hardMaximumAcos)) {
    effectiveOrigins.max_acos = { value: effectiveMaximumAcos, state: 'configured', source: 'product_economics' };
  }
  if (economicMaximumCpc !== null && (hardMaximumCpc === null || economicMaximumCpc < hardMaximumCpc)) {
    effectiveOrigins.max_cpc = { value: effectiveMaximumCpc, state: 'configured', source: 'product_economics' };
  }

  return {
    settings: effectiveValues,
    origins: effectiveOrigins,
    strategy: { objective, effectiveStrategy, primaryObjective: STRATEGY_OBJECTIVE[effectiveStrategy], label: OBJECTIVES[objective] },
    primaryGoal,
    conflicts,
    financialGuardrails: {
      maximumAcos: effectiveMaximumAcos,
      maximumCpc: effectiveMaximumCpc,
      maximumDailySpend: asFiniteNumber(values.daily_budget_limit),
    },
  };
}

export function evaluateConfiguredPerformanceGoal(policy: ReturnType<typeof resolveEffectivePerformanceSettings>, metrics: Record<string, unknown>) {
  const s = policy.settings;
  const primaryGoal = policy.primaryGoal;
  const metricMap: Record<string, { actual: number | null; target: number | null; direction: 'max' | 'min' }> = {
    acos: { actual: asFiniteNumber(metrics.acos), target: asFiniteNumber(s.target_acos), direction: 'max' },
    roas: { actual: asFiniteNumber(metrics.roas), target: asFiniteNumber(s.target_roas), direction: 'min' },
    tacos: { actual: asFiniteNumber(metrics.tacos), target: asFiniteNumber(s.target_tacos), direction: 'max' },
    cpc: { actual: asFiniteNumber(metrics.cpc), target: asFiniteNumber(s.target_cpc), direction: 'max' },
    daily_impressions: { actual: asFiniteNumber(metrics.daily_impressions), target: asFiniteNumber(s.target_daily_impressions), direction: 'min' },
    budget_coverage: { actual: asFiniteNumber(metrics.budget_coverage_hours), target: asFiniteNumber(s.target_coverage_hours), direction: 'max' },
    cost_per_order: { actual: asFiniteNumber(metrics.cost_per_order), target: asFiniteNumber(s.target_cost_per_order), direction: 'max' },
    growth: { actual: asFiniteNumber(metrics.growth_efficiency), target: asFiniteNumber(s.growth_efficiency_target), direction: 'min' },
  };
  const selected = metricMap[primaryGoal];
  const active = primaryGoal !== 'daily_impressions' || s.impressions_goal_enabled === true;
  const missing = !active || selected.target === null || selected.actual === null;
  const achieved = missing ? null : selected.direction === 'max' ? selected.actual! <= selected.target! : selected.actual! >= selected.target!;
  const hardCapReasons: string[] = [];
  const spend = asFiniteNumber(metrics.spend);
  if (policy.financialGuardrails.maximumDailySpend !== null && spend !== null
      && spend > policy.financialGuardrails.maximumDailySpend) hardCapReasons.push('DAILY_BUDGET_LIMIT_REACHED');
  if (policy.financialGuardrails.maximumAcos !== null) {
    const acos = asFiniteNumber(metrics.acos);
    if (acos !== null && acos > policy.financialGuardrails.maximumAcos) hardCapReasons.push('ACOS_HARD_LIMIT_EXCEEDED');
  }
  if (policy.financialGuardrails.maximumCpc !== null) {
    const cpc = asFiniteNumber(metrics.cpc);
    if (cpc !== null && cpc > policy.financialGuardrails.maximumCpc) hardCapReasons.push('CPC_HARD_LIMIT_EXCEEDED');
  }
  // A traffic/coverage target can guide pacing, but can never authorize spending
  // after a mandatory financial limit is exceeded.
  const canExpand = achieved === true && hardCapReasons.length === 0;
  return { primaryGoal, achieved, selectedMetric: selected, missing, hardCapReasons, canExpand };
}

/** Backwards-compatible adapter for older callers; unlike before, missing caps stay absent. */
export type ResolvedGoalPolicy = {
  primaryObjective: string;
  presetCode: string;
  presetVersion: number;
  effectiveTargets: {
    targetAcos: number | null;
    maximumAcos: number | null;
    targetAverageCpc: number | null;
    hardMaximumCpc: number | null;
    maximumDailySpend: number | null;
    targetRoas: number | null;
    targetTacos: number | null;
    targetDailyImpressions: number | null;
    targetCoverageHours: number | null;
    targetCostPerOrder: number | null;
    primaryGoal: PrimaryGoal;
    objective: ObjectiveCode;
    effectiveStrategy: string;
  };
  constraints: { maximumBidChangePct: number | null; minimumConfidenceForIncrease: number | null; respectManualPause: true };
  feasibility: 'FEASIBLE' | 'PARTIALLY_FEASIBLE' | 'CONFLICTING' | 'INSUFFICIENT_DATA' | 'ECONOMICALLY_UNSAFE';
  conflicts: Array<{ type: string; message: string; resolution: string }>;
  origins: Record<string, ResolvedValue<unknown>>;
};

export function resolveGoalPolicy(input: {
  objective?: string | null; objectiveBase?: string | null; primaryGoal?: string | null;
  targetAcos?: number | null; maximumAcos?: number | null; targetRoas?: number | null;
  targetTacos?: number | null; maximumTacos?: number | null; targetAverageCpc?: number | null;
  hardMaximumCpc?: number | null; maximumEconomicCpc?: number | null; breakEvenAcos?: number | null;
  maximumDailySpend?: number | null; targetDailyImpressions?: number | null; impressionsGoalEnabled?: boolean | null;
  targetCoverageHours?: number | null; targetCostPerOrder?: number | null; growthEfficiencyTarget?: number | null;
  growthEfficiencyEnabled?: boolean | null; maximumBidChangePct?: number | null;
}): ResolvedGoalPolicy {
  const policy = resolveEffectivePerformanceSettings({
    performanceSettings: {
      objective: input.objective, objective_base: input.objectiveBase, primary_goal: input.primaryGoal,
      target_acos: input.targetAcos, max_acos: input.maximumAcos, target_roas: input.targetRoas,
      target_tacos: input.targetTacos, max_tacos: input.maximumTacos, target_cpc: input.targetAverageCpc,
      max_cpc: input.hardMaximumCpc, daily_budget_limit: input.maximumDailySpend,
      target_daily_impressions: input.targetDailyImpressions, impressions_goal_enabled: input.impressionsGoalEnabled,
      target_coverage_hours: input.targetCoverageHours, target_cost_per_order: input.targetCostPerOrder,
      growth_efficiency_target: input.growthEfficiencyTarget, growth_efficiency_enabled: input.growthEfficiencyEnabled,
      max_bid_increase_pct: input.maximumBidChangePct,
    },
    product: { break_even_acos: input.breakEvenAcos, maximum_economic_cpc: input.maximumEconomicCpc },
  });
  const confidenceByObjective: Record<string, number> = {
    profitability: .85, growth: .80, launch: .80, defense: .85, liquidation: .80,
    maintenance: .80, aggressive_peak: .90, flex_stock: .85, custom: .75,
  };
  const maxChange = asFiniteNumber(policy.settings.max_bid_increase_pct);
  const conflicts = policy.conflicts;
  const hardCpc = policy.financialGuardrails.maximumCpc;
  if (input.hardMaximumCpc != null && input.maximumEconomicCpc != null
      && Number(input.hardMaximumCpc) > Number(input.maximumEconomicCpc)) {
    conflicts.push({ type: 'CPC_ABOVE_ECONOMIC_LIMIT', message: 'CPC máximo configurado supera o limite econômico do produto.', resolution: 'Aplicar o menor teto.' });
  }
  return {
    primaryObjective: policy.strategy.primaryObjective,
    presetCode: policy.strategy.objective,
    presetVersion: 2,
    effectiveTargets: {
      targetAcos: policy.settings.target_acos as number | null,
      maximumAcos: policy.financialGuardrails.maximumAcos,
      targetAverageCpc: policy.settings.target_cpc as number | null,
      hardMaximumCpc: hardCpc,
      maximumDailySpend: policy.financialGuardrails.maximumDailySpend,
      targetRoas: policy.settings.target_roas as number | null,
      targetTacos: policy.settings.target_tacos as number | null,
      targetDailyImpressions: asFiniteNumber(policy.settings.target_daily_impressions),
      targetCoverageHours: asFiniteNumber(policy.settings.target_coverage_hours),
      targetCostPerOrder: asFiniteNumber(policy.settings.target_cost_per_order),
      primaryGoal: policy.primaryGoal, objective: policy.strategy.objective,
      effectiveStrategy: policy.strategy.effectiveStrategy,
    },
    constraints: { maximumBidChangePct: maxChange, minimumConfidenceForIncrease: confidenceByObjective[policy.strategy.effectiveStrategy] ?? null, respectManualPause: true },
    feasibility: conflicts.length ? 'PARTIALLY_FEASIBLE'
      : hardCpc === null && policy.financialGuardrails.maximumAcos === null ? 'INSUFFICIENT_DATA' : 'FEASIBLE',
    conflicts, origins: policy.origins,
  };
}
