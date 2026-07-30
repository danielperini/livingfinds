import { classifyExecutionPolicy, shouldSupersedeDecision } from './decisionExecutionPolicy.ts';

function assert(value: unknown, message = 'assertion failed'): asserts value {
  if (!value) throw new Error(message);
}

Deno.test('produto não comprável recebe execução imediata P0', () => {
  const policy = classifyExecutionPolicy({
    action: 'pause_campaign',
    urgencyReasonCode: 'NOT_BUYABLE',
    entityType: 'campaign',
    entityId: '123',
  });
  assert(policy.execution_mode === 'EXECUTE_NOW');
  assert(policy.priority_class === 'P0');
});

Deno.test('redução econômica entra na fila rápida', () => {
  const policy = classifyExecutionPolicy({
    action: 'set_bid',
    ruleKey: 'profit_erosion_defensive',
    entityType: 'keyword',
    entityId: 'kw1',
  });
  assert(policy.execution_mode === 'EXPEDITED_QUEUE');
  assert(policy.priority_class === 'P1');
});

Deno.test('proteção P1 cancela crescimento P3 conflitante', () => {
  assert(shouldSupersedeDecision(
    { priority_class: 'P1', conflict_group: 'keyword:1', action: 'reduce_bid' },
    { priority_class: 'P3', conflict_group: 'keyword:1', action: 'increase_bid' },
  ));
});
