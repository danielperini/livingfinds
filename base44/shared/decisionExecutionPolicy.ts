export type ExecutionMode =
  | 'EXECUTE_NOW'
  | 'EXPEDITED_QUEUE'
  | 'STANDARD_QUEUE'
  | 'SCHEDULED_WINDOW'
  | 'MANUAL_REVIEW';

export type PriorityClass = 'P0' | 'P1' | 'P2' | 'P3' | 'P4';

const P0_REASONS = new Set([
  'NOT_BUYABLE',
  'OUT_OF_STOCK',
  'LISTING_SUPPRESSED',
  'USER_PAUSE_VIOLATION',
  'HARD_DAILY_CAP_RISK',
  'RUNAWAY_SPEND',
  'SAFE_CPC_VIOLATION',
]);

export function classifyExecutionPolicy(input: {
  action?: string | null;
  ruleKey?: string | null;
  urgencyReasonCode?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  scheduledFor?: string | null;
  expectedLossIfDelayed?: number | null;
}) {
  const action = String(input.action || '').toLowerCase();
  const rule = String(input.ruleKey || '').toLowerCase();
  const inferredReason = input.urgencyReasonCode
    || (rule.includes('stock_zero') ? 'OUT_OF_STOCK'
      : rule.includes('not_buyable') ? 'NOT_BUYABLE'
        : rule.includes('manual') && action.includes('pause') ? 'USER_PAUSE_VIOLATION'
          : rule.includes('cpc_above') ? 'SAFE_CPC_VIOLATION'
            : rule.includes('profit') ? 'LOSS_AFTER_PRIOR_REDUCTION'
              : action.includes('increase') || rule.includes('growth') ? 'NORMAL_OPTIMIZATION'
                : 'NORMAL_OPTIMIZATION');

  let executionMode: ExecutionMode = 'STANDARD_QUEUE';
  let priorityClass: PriorityClass = 'P2';
  let sla: number | null = null;

  if (P0_REASONS.has(inferredReason)) {
    executionMode = 'EXECUTE_NOW';
    priorityClass = 'P0';
    sla = 60;
  } else if (action.includes('archive')) {
    executionMode = 'MANUAL_REVIEW';
    priorityClass = 'P4';
  } else if (input.scheduledFor || rule.includes('daypart')) {
    executionMode = 'SCHEDULED_WINDOW';
    priorityClass = 'P2';
  } else if (
    action.includes('pause_keyword')
    || action.includes('reduce')
    || rule.includes('profit')
    || rule.includes('acos_above')
    || rule.includes('cpc_above')
  ) {
    executionMode = 'EXPEDITED_QUEUE';
    priorityClass = 'P1';
    sla = 300;
  } else if (action.includes('increase') || rule.includes('growth') || rule.includes('create')) {
    executionMode = 'STANDARD_QUEUE';
    priorityClass = 'P3';
  }

  return {
    execution_mode: executionMode,
    priority_class: priorityClass,
    urgency_reason_code: inferredReason,
    execution_sla_seconds: sla,
    expected_loss_if_delayed: input.expectedLossIfDelayed ?? null,
    conflict_group: `${input.entityType || 'entity'}:${input.entityId || 'unknown'}`,
    requires_fresh_data: true,
    maximum_data_age_minutes: executionMode === 'EXECUTE_NOW' ? 10 : 36 * 60,
    confirmation_required: true,
  };
}

export function priorityRank(priority: PriorityClass): number {
  return { P0: 0, P1: 1, P2: 2, P3: 3, P4: 4 }[priority];
}

export function shouldSupersedeDecision(
  incoming: { priority_class?: PriorityClass; conflict_group?: string; action?: string },
  existing: { priority_class?: PriorityClass; conflict_group?: string; action?: string },
): boolean {
  if (!incoming.conflict_group || incoming.conflict_group !== existing.conflict_group) return false;
  const incomingRank = priorityRank(incoming.priority_class || 'P2');
  const existingRank = priorityRank(existing.priority_class || 'P2');
  if (incomingRank < existingRank) return true;
  const incomingReduces = String(incoming.action || '').includes('pause') || String(incoming.action || '').includes('reduce');
  const existingIncreases = String(existing.action || '').includes('increase');
  return incomingRank === existingRank && incomingReduces && existingIncreases;
}
