import type { ExecutionMode } from './decisionExecutionPolicy.ts';

export type AmazonActionDefinition = {
  actionCode: string;
  entityType: string;
  endpoint: string;
  executor: string;
  reversible: boolean;
  rollbackAction?: string;
  allowedModes: ExecutionMode[];
  confirmationRequired: boolean;
  supported: boolean;
};

const QUEUED: ExecutionMode[] = ['EXPEDITED_QUEUE', 'STANDARD_QUEUE', 'SCHEDULED_WINDOW'];
const STATE_MODES: ExecutionMode[] = ['EXECUTE_NOW', ...QUEUED];

const definitions: AmazonActionDefinition[] = [
  ...['set_bid', 'reduce_bid', 'increase_bid', 'update_bid'].map(actionCode => ({
    actionCode,
    entityType: 'keyword',
    endpoint: '/sp/keywords',
    executor: 'executePairedManualBidDecision',
    reversible: true,
    rollbackAction: 'set_bid',
    allowedModes: QUEUED,
    confirmationRequired: true,
    supported: true,
  })),
  ...['update_budget', 'reduce_budget', 'increase_budget', 'set_budget'].map(actionCode => ({
    actionCode,
    entityType: 'campaign',
    endpoint: '/sp/campaigns',
    executor: 'executeAutopilotDecisionV2',
    reversible: true,
    rollbackAction: 'set_budget',
    allowedModes: QUEUED,
    confirmationRequired: true,
    supported: true,
  })),
  {
    actionCode: 'pause_campaign',
    entityType: 'campaign',
    endpoint: '/sp/campaigns',
    executor: 'executePauseDecisionSafe',
    reversible: true,
    rollbackAction: 'enable_campaign',
    allowedModes: STATE_MODES,
    confirmationRequired: true,
    supported: true,
  },
  {
    actionCode: 'enable_campaign',
    entityType: 'campaign',
    endpoint: '/sp/campaigns',
    executor: 'executeAutopilotDecisionV2',
    reversible: true,
    rollbackAction: 'pause_campaign',
    allowedModes: QUEUED,
    confirmationRequired: true,
    supported: true,
  },
  ...['pause_keyword', 'enable_keyword'].map(actionCode => ({
    actionCode,
    entityType: 'keyword',
    endpoint: '/sp/keywords',
    executor: 'executeAutopilotDecisionV2',
    reversible: true,
    rollbackAction: actionCode === 'pause_keyword' ? 'enable_keyword' : 'pause_keyword',
    allowedModes: STATE_MODES,
    confirmationRequired: true,
    supported: true,
  })),
  ...['negative_exact', 'negative_keyword'].map(actionCode => ({
    actionCode,
    entityType: 'keyword',
    endpoint: '/sp/negativeKeywords',
    executor: 'executeAutopilotDecisionV2',
    reversible: false,
    allowedModes: ['STANDARD_QUEUE'] as ExecutionMode[],
    confirmationRequired: true,
    supported: true,
  })),
  {
    actionCode: 'create_keyword',
    entityType: 'keyword',
    endpoint: '/sp/keywords',
    executor: 'executeAutopilotDecisionV2',
    reversible: true,
    rollbackAction: 'pause_keyword',
    allowedModes: ['STANDARD_QUEUE'],
    confirmationRequired: true,
    supported: true,
  },
  {
    actionCode: 'apply_dayparting',
    entityType: 'keyword',
    endpoint: '/sp/keywords',
    executor: 'applyDaypartingSchedule',
    reversible: true,
    rollbackAction: 'set_bid',
    allowedModes: ['SCHEDULED_WINDOW'],
    confirmationRequired: true,
    supported: true,
  },
];

const registry = new Map(definitions.map(definition => [definition.actionCode, definition]));

export function getAmazonActionDefinition(action: unknown): AmazonActionDefinition | null {
  return registry.get(String(action || '')) || null;
}

export function validateAmazonAction(input: { action?: string; execution_mode?: ExecutionMode }) {
  const definition = getAmazonActionDefinition(input.action);
  if (!definition?.supported) {
    return { valid: false, reason: `UNSUPPORTED_AMAZON_ACTION:${input.action || 'missing'}`, definition };
  }
  if (input.execution_mode && !definition.allowedModes.includes(input.execution_mode)) {
    return {
      valid: false,
      reason: `EXECUTION_MODE_NOT_ALLOWED:${input.action}:${input.execution_mode}`,
      definition,
    };
  }
  return { valid: true, reason: 'SUPPORTED', definition };
}

export const AMAZON_ACTION_REGISTRY = Object.freeze(definitions);
