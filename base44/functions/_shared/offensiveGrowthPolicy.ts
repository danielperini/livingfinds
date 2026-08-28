export const SOFT_PAUSE_RECOVERY_ORDER = [
  "recover_bid",
  "increase_budget",
  "reactivate",
  "promote_exact",
  "HOLD",
] as const;

export type SoftPauseAction = typeof SOFT_PAUSE_RECOVERY_ORDER[number];

export interface GrowthCaps {
  maxBudgetActions: number;
  maxExactActions: number;
  maxBidRecoveries: number;
}

export const CANONICAL_GROWTH_CAPS: GrowthCaps = {
  maxBudgetActions: 6,
  maxExactActions: 6,
  maxBidRecoveries: 8,
};

export function isWinner30dProtected(input: {
  winner30d?: boolean | null;
  winner_30d?: boolean | null;
  winnerWindowDays?: number | null;
}): boolean {
  return input.winner30d === true || input.winner_30d === true || input.winnerWindowDays === 30;
}

export function chooseSoftPauseRecoveryAction(input: {
  blocked: boolean;
  winner30d?: boolean | null;
  winner_30d?: boolean | null;
  winnerWindowDays?: number | null;
  attempted?: Iterable<string>;
}): SoftPauseAction {
  if (!input.blocked) return "HOLD";
  const attempted = new Set(input.attempted ?? []);
  for (const action of SOFT_PAUSE_RECOVERY_ORDER) {
    if (action === "HOLD") return action;
    if (isWinner30dProtected(input) && (action === "increase_budget" || action === "reactivate" || action === "promote_exact")) continue;
    if (!attempted.has(action)) return action;
  }
  return "HOLD";
}

export function clampGrowthCaps(input: Partial<GrowthCaps> = {}): GrowthCaps {
  return {
    maxBudgetActions: Math.min(Math.max(input.maxBudgetActions ?? CANONICAL_GROWTH_CAPS.maxBudgetActions, 0), CANONICAL_GROWTH_CAPS.maxBudgetActions),
    maxExactActions: Math.min(Math.max(input.maxExactActions ?? CANONICAL_GROWTH_CAPS.maxExactActions, 0), CANONICAL_GROWTH_CAPS.maxExactActions),
    maxBidRecoveries: Math.min(Math.max(input.maxBidRecoveries ?? CANONICAL_GROWTH_CAPS.maxBidRecoveries, 0), CANONICAL_GROWTH_CAPS.maxBidRecoveries),
  };
}
