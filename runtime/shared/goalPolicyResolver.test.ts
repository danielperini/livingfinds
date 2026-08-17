import { resolveGoalPolicy } from './goalPolicyResolver.ts';

function assert(value: unknown, message = 'assertion failed'): asserts value {
  if (!value) throw new Error(message);
}

Deno.test('meta do usuário nunca ultrapassa ACoS de equilíbrio', () => {
  const policy = resolveGoalPolicy({
    objective: 'growth',
    targetAcos: 45,
    maximumAcos: 50,
    breakEvenAcos: 31,
    maximumBidChangePct: 0.35,
  });
  assert(policy.effectiveTargets.targetAcos === 31);
  assert(policy.effectiveTargets.maximumAcos === 31);
  assert(policy.constraints.maximumBidChangePct === 0.20);
  assert(policy.feasibility === 'PARTIALLY_FEASIBLE');
});

Deno.test('CPC médio desejado não vira teto individual', () => {
  const policy = resolveGoalPolicy({
    targetAverageCpc: 0.70,
    hardMaximumCpc: 1.20,
    maximumEconomicCpc: 0.95,
  });
  assert(policy.effectiveTargets.targetAverageCpc === 0.70);
  assert(policy.effectiveTargets.hardMaximumCpc === 0.95);
});
