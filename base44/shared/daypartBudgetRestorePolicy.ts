export type BudgetRestoreInput = {
  currentBudget: number;
  baselineBudget: number;
  currentSpend: number;
  minimumCampaignBudget: number;
  remainingAccountBudget: number;
  accountHardCap: boolean;
  bidOnlyWindow: boolean;
  pauseWindow: boolean;
  active: boolean;
  inStock: boolean;
  appReducedBudget: boolean;
};

export type BudgetRestoreDecision = {
  eligible: boolean;
  targetBudget: number;
  reason: string;
};

const money = (value: unknown) => Math.round((Number(value) || 0) * 100) / 100;

/**
 * Restaura somente budget reduzido pelo próprio LivingFinds.
 * Não aumenta teto global, não ignora hard cap e não atua em janela de pausa.
 */
export function decideDaypartBudgetRestore(input: BudgetRestoreInput): BudgetRestoreDecision {
  const current = Math.max(0, money(input.currentBudget));
  const baseline = Math.max(current, money(input.baselineBudget));
  const minimum = Math.max(0, money(input.minimumCampaignBudget));

  if (!input.active) return { eligible: false, targetBudget: current, reason: 'CAMPAIGN_NOT_ACTIVE' };
  if (!input.inStock) return { eligible: false, targetBudget: current, reason: 'OUT_OF_STOCK' };
  if (!input.bidOnlyWindow || input.pauseWindow) return { eligible: false, targetBudget: current, reason: 'NOT_BID_ONLY_WINDOW' };
  if (input.accountHardCap) return { eligible: false, targetBudget: current, reason: 'ACCOUNT_HARD_CAP' };
  if (!input.appReducedBudget) return { eligible: false, targetBudget: current, reason: 'NO_APP_REDUCTION_EVIDENCE' };

  const requested = Math.max(minimum, baseline);
  const delta = money(requested - current);
  if (delta <= 0) return { eligible: false, targetBudget: current, reason: 'ALREADY_AT_BASELINE' };
  if (money(input.remainingAccountBudget) < delta) {
    return { eligible: false, targetBudget: current, reason: 'INSUFFICIENT_GLOBAL_BUDGET' };
  }
  if (money(input.currentSpend) >= requested) {
    return { eligible: false, targetBudget: current, reason: 'CAMPAIGN_ALREADY_SPENT_BASELINE' };
  }

  return { eligible: true, targetBudget: requested, reason: 'RESTORE_APP_REDUCED_BUDGET' };
}
