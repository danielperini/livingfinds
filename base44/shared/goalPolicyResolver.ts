export type ResolvedGoalPolicy = {
  primaryObjective: 'PROFIT' | 'BALANCED' | 'SALES_GROWTH' | 'LAUNCH' | 'DELIVERY_RECOVERY' | 'INVENTORY_CLEARANCE';
  presetCode: string;
  presetVersion: number;
  effectiveTargets: {
    targetAcos: number;
    maximumAcos: number;
    targetAverageCpc: number | null;
    hardMaximumCpc: number | null;
    maximumDailySpend: number;
  };
  constraints: {
    maximumBidChangePct: number;
    minimumConfidenceForIncrease: number;
    respectManualPause: true;
  };
  feasibility: 'FEASIBLE' | 'PARTIALLY_FEASIBLE' | 'CONFLICTING' | 'INSUFFICIENT_DATA' | 'ECONOMICALLY_UNSAFE';
  conflicts: Array<{ type: string; message: string; resolution: string }>;
};

const positive = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const PRESETS: Record<string, { objective: ResolvedGoalPolicy['primaryObjective']; minConfidence: number; targetAcos: number }> = {
  profitability: { objective: 'PROFIT', minConfidence: 0.85, targetAcos: 15 },
  balanced: { objective: 'BALANCED', minConfidence: 0.75, targetAcos: 20 },
  growth: { objective: 'SALES_GROWTH', minConfidence: 0.80, targetAcos: 25 },
  launch: { objective: 'LAUNCH', minConfidence: 0.80, targetAcos: 30 },
  defense: { objective: 'DELIVERY_RECOVERY', minConfidence: 0.85, targetAcos: 20 },
  liquidation: { objective: 'INVENTORY_CLEARANCE', minConfidence: 0.80, targetAcos: 25 },
  maintenance: { objective: 'BALANCED', minConfidence: 0.80, targetAcos: 18 },
};

/**
 * Resolve a intenção já persistida em PerformanceSettings/AutopilotConfig.
 * Limites econômicos sempre prevalecem sobre metas e presets.
 */
export function resolveGoalPolicy(input: {
  objective?: string | null;
  targetAcos?: number | null;
  maximumAcos?: number | null;
  breakEvenAcos?: number | null;
  targetAverageCpc?: number | null;
  hardMaximumCpc?: number | null;
  maximumEconomicCpc?: number | null;
  maximumDailySpend?: number | null;
  maximumBidChangePct?: number | null;
}): ResolvedGoalPolicy {
  const presetCode = String(input.objective || 'profitability').toLowerCase();
  const preset = PRESETS[presetCode] || PRESETS.profitability;
  const conflicts: ResolvedGoalPolicy['conflicts'] = [];
  const breakEven = positive(input.breakEvenAcos);
  const requestedTarget = positive(input.targetAcos) || preset.targetAcos;
  const requestedMaximum = positive(input.maximumAcos) || requestedTarget;
  const maximumAcos = breakEven ? Math.min(requestedMaximum, breakEven) : requestedMaximum;
  const targetAcos = Math.min(requestedTarget, maximumAcos);

  if (breakEven && (requestedTarget > breakEven || requestedMaximum > breakEven)) {
    conflicts.push({
      type: 'TARGET_ABOVE_BREAK_EVEN',
      message: `Meta solicitada de ACoS ultrapassa o equilíbrio econômico de ${breakEven.toFixed(2)}%.`,
      resolution: `ACoS operacional limitado a ${maximumAcos.toFixed(2)}%.`,
    });
  }

  const hardCpc = positive(input.hardMaximumCpc);
  const economicCpc = positive(input.maximumEconomicCpc);
  const effectiveHardCpc = hardCpc && economicCpc
    ? Math.min(hardCpc, economicCpc)
    : hardCpc || economicCpc;
  if (hardCpc && economicCpc && hardCpc > economicCpc) {
    conflicts.push({
      type: 'CPC_ABOVE_ECONOMIC_LIMIT',
      message: `CPC máximo configurado ultrapassa o teto econômico de R$ ${economicCpc.toFixed(2)}.`,
      resolution: `Teto efetivo limitado a R$ ${effectiveHardCpc?.toFixed(2)}.`,
    });
  }

  return {
    primaryObjective: preset.objective,
    presetCode,
    presetVersion: 1,
    effectiveTargets: {
      targetAcos,
      maximumAcos,
      targetAverageCpc: positive(input.targetAverageCpc),
      hardMaximumCpc: effectiveHardCpc,
      maximumDailySpend: positive(input.maximumDailySpend) || 56,
    },
    constraints: {
      maximumBidChangePct: Math.min(0.20, positive(input.maximumBidChangePct) || 0.20),
      minimumConfidenceForIncrease: preset.minConfidence,
      respectManualPause: true,
    },
    feasibility: conflicts.length > 0 ? 'PARTIALLY_FEASIBLE' : breakEven ? 'FEASIBLE' : 'INSUFFICIENT_DATA',
    conflicts,
  };
}
