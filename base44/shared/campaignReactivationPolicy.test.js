import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hasExplicitCampaignReactivationConfirmation,
  isEnabledCampaignState,
} from './campaignReactivationPolicy.js';

test('campaign reactivation requires an explicit user confirmation', () => {
  assert.equal(hasExplicitCampaignReactivationConfirmation({}), false);
  assert.equal(hasExplicitCampaignReactivationConfirmation({ _service_role: true }), false);
  assert.equal(hasExplicitCampaignReactivationConfirmation({ user_confirmed_reactivation: true }), true);
});

test('only enabled campaign states count as active AUTO coverage', () => {
  assert.equal(isEnabledCampaignState('ENABLED'), true);
  assert.equal(isEnabledCampaignState('active'), true);
  assert.equal(isEnabledCampaignState('PAUSED'), false);
  assert.equal(isEnabledCampaignState('INCOMPLETE'), false);
  assert.equal(isEnabledCampaignState(undefined), false);
});
