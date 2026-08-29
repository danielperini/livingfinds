import { buildCanonicalBidDecision, evaluateDecisionGovernance, type CanonicalBidInput } from './canonicalDecisionPolicy.ts';

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const base: CanonicalBidInput = {
  currentBid: 1,
  safeMaxCpc: 2,
  impressions: 100,
  clicks: 10,
  sameSkuOrders: 2,
  spend: 8,
  maxSpendWithoutSale: 20,
  spendShare: 0.1,
  ageHours: 48,
  inStock: true,
  structurallyComplete: true,
  dataFresh: true,
  economicsComplete: true,
  cooldownActive: false,
  pendingInsertion: false,
  winnerProtected: true,
  lowVolumeGuarded: false,
  defensive: false,
  isManualExact: true,
  adGroupConfirmed: true,
  productAdConfirmed: true,
  priorReductionCount: 0,
  attributionComplete: true,
  acos: 20,
  targetAcos: 30,
  breakEvenAcos: 45,
  profitAfterAds: 12,
};

Deno.test('V4 strong winner aumenta 15% e reavalia em 3h', () => {
  const decision = buildCanonicalBidDecision({ ...base, acos: 20 });
  assert(decision.action === 'INCREASE', 'strong winner não aumentou');
  assert(decision.proposedBid === 1.15, 'strong winner não aplicou +15%');
  assert(decision.nextEvaluationHours === 3, 'strong winner não reavalia em 3h');
});

Deno.test('V4 winner aumenta 10% e reavalia em 4h', () => {
  const decision = buildCanonicalBidDecision({ ...base, acos: 24 });
  assert(decision.action === 'INCREASE', 'winner não aumentou');
  assert(decision.proposedBid === 1.1, 'winner não aplicou +10%');
  assert(decision.nextEvaluationHours === 4, 'winner não reavalia em 4h');
});

Deno.test('V4 nunca ultrapassa safeMaxCpc', () => {
  const decision = buildCanonicalBidDecision({ ...base, acos: 20, safeMaxCpc: 1.07 });
  assert(decision.proposedBid === 1.07, 'aumento ultrapassou ou ignorou safeMaxCpc');
});

Deno.test('V4 cooldown produz HOLD', () => {
  const decision = buildCanonicalBidDecision({ ...base, cooldownActive: true });
  assert(decision.action === 'HOLD', 'cooldown não produziu HOLD');
});

Deno.test('V4 out_of_stock produz BLOCK', () => {
  const governance = evaluateDecisionGovernance({
    actionType: 'increase_bid', entityType: 'keyword', currentValue: 1, proposedValue: 1.15,
    snapshotId: 'snap', verifiedEvidenceId: 'evidence', confidence: 99,
    dataFresh: true, productEligible: true, listingActive: true, offerActive: true,
    buyable: true, inStock: false, economicsComplete: true, profitAfterAds: 10,
    safeMaxCpc: 2, cooldownActive: false,
  });
  assert(!governance.allowed && governance.blockers.some((row) => row.code === 'OUT_OF_STOCK'), 'sem estoque não bloqueou');
});
