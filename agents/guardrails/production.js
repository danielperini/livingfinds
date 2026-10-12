const READ_ONLY_AGENT_ACTIONS = new Set([
  'read_repository_file',
  'propose_patch',
  'run_allowlisted_tests',
  'inspect_github_actions',
  'inspect_vps_health',
  'inspect_runtime_configuration',
]);

const PROTECTED_ACTIONS = new Set([
  'amazon_campaign_write',
  'amazon_budget_or_bid_change',
  'database_write',
  'secret_access',
  'deploy',
  'main_branch_write',
  'destructive_filesystem_operation',
]);

export function isAgentActionAllowed(action) {
  return READ_ONLY_AGENT_ACTIONS.has(action) && !PROTECTED_ACTIONS.has(action);
}

export function guardAgentAction(action) {
  if (!isAgentActionAllowed(action)) {
    return { allowed: false, status: 'blocked', reason: 'A ação não está exposta ao agente; exige fluxo administrativo e aprovação humana.' };
  }
  return { allowed: true, status: 'read_only' };
}

export const protectedProductionActions = [...PROTECTED_ACTIONS];
