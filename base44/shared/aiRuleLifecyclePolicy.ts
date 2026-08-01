import type { CentralGoalMode } from './centralPerformanceGoals.ts';

const GROWTH_ACTIONS = new Set(['increase_bid_percent', 'activate_keyword', 'activate_campaign', 'create_exact_keyword', 'create_phrase_keyword', 'create_broad_keyword', 'create_product_target', 'redistribute_budget']);
const PROTECTIVE_ACTIONS = new Set(['decrease_bid_percent', 'pause_keyword', 'pause_campaign', 'negate_search_term', 'recommend_manual_review']);

export function evaluateAiRuleCandidate(input: {
  action: string; confidence: number; backtestPassed: boolean; holdoutPassed: boolean;
  centralMode: CentralGoalMode; expectedProfitChangePct?: number; hasRollback: boolean;
}) {
  const reasons: string[] = [];
  if (input.confidence < 0.90) reasons.push('CONFIDENCE_BELOW_90');
  if (!input.backtestPassed) reasons.push('BACKTEST_FAILED');
  if (!input.holdoutPassed) reasons.push('HOLDOUT_FAILED');
  if (!input.hasRollback) reasons.push('ROLLBACK_REQUIRED');
  if (Number(input.expectedProfitChangePct || 0) < 0) reasons.push('EXPECTED_PROFIT_NEGATIVE');
  if (GROWTH_ACTIONS.has(input.action) && input.centralMode !== 'GROW') reasons.push(`GROWTH_BLOCKED_IN_${input.centralMode}`);
  if (!GROWTH_ACTIONS.has(input.action) && !PROTECTIVE_ACTIONS.has(input.action) && input.action !== 'set_bid') reasons.push('ACTION_NOT_LIFECYCLE_APPROVED');
  return { eligible: reasons.length === 0, nextStatus: reasons.length ? 'rejected' : 'validating', reasons };
}

export function canPromoteValidatingRule(input: { ageDays: number; shadowSamples: number; shadowProfitDeltaPct: number; shadowAcosDeltaPp: number; centralMode: CentralGoalMode; action: string }) {
  const growth = GROWTH_ACTIONS.has(input.action);
  const eligible = input.ageDays >= 7 && input.shadowSamples >= 20 && input.shadowProfitDeltaPct >= 0 && input.shadowAcosDeltaPp <= 0 && (!growth || input.centralMode === 'GROW');
  return { eligible, status: eligible ? 'active' : 'validating' };
}
