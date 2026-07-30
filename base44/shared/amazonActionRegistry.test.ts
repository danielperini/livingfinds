import { AMAZON_ACTION_REGISTRY, validateAmazonAction } from './amazonActionRegistry.ts';

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

Deno.test('nenhuma ação suportada fica sem probe de confirmação', () => {
  for (const action of AMAZON_ACTION_REGISTRY.filter((item) => item.supported)) {
    assert(!action.confirmationRequired || Boolean(action.confirmationProbe), action.actionCode);
  }
});

Deno.test('ações sem confirmação remota completa permanecem bloqueadas', () => {
  for (const action of ['negative_exact', 'negative_keyword', 'create_keyword', 'apply_dayparting']) {
    assert(validateAmazonAction({ action }).valid === false, action);
  }
});

Deno.test('estado de keyword é suportado após probe remoto', () => {
  assert(validateAmazonAction({ action: 'pause_keyword', execution_mode: 'EXPEDITED_QUEUE' }).valid);
  assert(validateAmazonAction({ action: 'enable_keyword', execution_mode: 'STANDARD_QUEUE' }).valid);
});
