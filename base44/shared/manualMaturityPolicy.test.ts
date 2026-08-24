import { calculateZeroSpendManualRate, decideMatureCampaignAction, reallocateReleasedCapacity } from './manualMaturityPolicy.ts';
function eq<T>(a: T, b: T) { if (a !== b) throw new Error(`Expected ${String(b)}, got ${String(a)}`); }
Deno.test('calculates zero_spend_manual_rate only over active mature MANUAL campaigns', () => {
  const result = calculateZeroSpendManualRate([
    { id: '1', type: 'MANUAL', maturity: 'MATURE', status: 'ACTIVE', spend: 0, sales: 0, profit: 0 },
    { id: '2', type: 'MANUAL', maturity: 'MATURE', status: 'ACTIVE', spend: 2, sales: 1, profit: 1 },
    { id: '3', type: 'AUTO', maturity: 'MATURE', status: 'ACTIVE', spend: 0, sales: 0, profit: 0 },
    { id: '4', type: 'MANUAL', maturity: 'MATURE', status: 'PAUSED', spend: 0, sales: 0, profit: 0 },
  ]);
  eq(result.zero_spend_manual_rate, 0.5); eq(result.activeMatureManual, 2); eq(result.meetsShortTerm, false);
});
Deno.test('progresses negative mature campaigns and preserves winners', () => {
  const base = { id: 'bad', type: 'MANUAL', maturity: 'MATURE', status: 'ACTIVE', spend: 5, sales: 0, profit: 0, bid: 1 } as const;
  eq(decideMatureCampaignAction(base).nextStage, 'REDUCE_BID');
  eq(decideMatureCampaignAction({ ...base, priorStage: 'REDUCE_BID', bid: 0.9 }).nextStage, 'RE_EVALUATE');
  eq(decideMatureCampaignAction({ ...base, priorStage: 'RE_EVALUATE', negativeEvaluations: 2 }).action, 'PAUSE');
  eq(decideMatureCampaignAction({ ...base, id: 'winner', campaignClass: 'WINNER', sales: 10, profit: 4 }).action, 'PRESERVE_WINNER');
});
Deno.test('reallocates released budget and capacity to protected classes', () => {
  const result = reallocateReleasedCapacity([
    { id: 'w', type: 'MANUAL', maturity: 'MATURE', status: 'ACTIVE', spend: 1, sales: 1, profit: 1, campaignClass: 'WINNER' },
    { id: 'e', type: 'MANUAL', maturity: 'MATURE', status: 'ACTIVE', spend: 1, sales: 1, profit: 1, campaignClass: 'EFFICIENT' },
    { id: 'n', type: 'MANUAL', maturity: 'CREATED', status: 'ACTIVE', spend: 0, sales: 0, profit: 0, campaignClass: 'NEW_EXACT' },
  ], 60, 6);
  eq(result.allocations.length, 3); eq(result.allocations[0].budget, 30); eq(result.allocations[0].capacity, 3); eq(result.allocations[2].budget, 10);
});
