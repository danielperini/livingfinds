/**
 * Guardrails for resuming paused Amazon Ads campaigns.
 * Inventory alone never authorizes an automatic resume.
 */
export function hasExplicitCampaignReactivationConfirmation(body) {
  return body?.user_confirmed_reactivation === true;
}

export function isEnabledCampaignState(state) {
  return ['ENABLED', 'ACTIVE'].includes(String(state || '').trim().toUpperCase());
}
