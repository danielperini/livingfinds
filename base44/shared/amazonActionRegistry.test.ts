import { validateAmazonAction } from './amazonActionRegistry.ts';

function assert(value: unknown, message = 'assertion failed'): asserts value {
  if (!value) throw new Error(message);
}

Deno.test('registro aceita ação realmente conectada ao executor', () => {
  assert(validateAmazonAction({ action: 'set_bid', execution_mode: 'EXPEDITED_QUEUE' }).valid);
});

Deno.test('registro bloqueia placement ainda sem executor canônico', () => {
  const result = validateAmazonAction({
    action: 'reduce_placement_adjustment',
    execution_mode: 'EXPEDITED_QUEUE',
  });
  assert(result.valid === false);
  assert(result.reason.startsWith('UNSUPPORTED_AMAZON_ACTION'));
});
