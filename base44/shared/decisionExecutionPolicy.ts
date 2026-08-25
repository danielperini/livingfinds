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

/**
 * NEW FIX #1: Soft Pause Deduplication Detection
 *
 * Identifica se uma decisão de pausa é "soft" (não baseada em hard guardrails)
 * Soft pauses são canceladas/bloqueadas por winner_protection e devem ser dedupadas
 * para não serem recriadas continuamente.
 *
 * Hard guardrails: sem estoque, not_buyable, listing inactive, margem negativa, break-even/cap violado
 * Soft pauses: tudo mais (low acos, low relevance, etc.)
 */
export function isSoftPause(decision: {
  action?: string;
  rule_key?: string;
  reason_code?: string;
  rationale?: string;
  error_message?: string;
}): boolean {
  const action = String(decision.action || '').toLowerCase();
  if (!action.includes('pause')) return false;

  const text = `${String(decision.rule_key || '').toLowerCase()} ${String(decision.reason_code || '').toLowerCase()} ${String(decision.rationale || '').toLowerCase()}`;

  // HARD guardrails que justificam pausa permanente
  const hardGuardrails = [
    'out_of_stock', 'sem_estoque', 'stock', 'inventory',
    'not_buyable', 'não_comprável', 'listing_inactive', 'listing_suppressed',
    'negative_margin', 'margem_negativa', 'loss', 'prejuízo',
    'break_even', 'cap', 'daily_cap', 'budget_exceeded',
    'user_pause', 'manual_pause',
  ];

  for (const guard of hardGuardrails) {
    if (text.includes(guard)) return false;
  }

  // Tudo mais é soft pause
  return true;
}

/**
 * NEW FIX #1: Fallback Action Chain Generator
 *
 * Quando uma soft pause é dedupada/cancelada, gera alternativa válida na cadeia:
 *   1. recover_bid — aumenta bid para recuperar entrega (se margem permite)
 *   2. increase_budget — realoca budget ocioso se disponível
 *   3. reactivate — reativa campanha pausada se ganhou stock/economics
 *   4. promote_exact — promove termo forte para EXACT keyword
 *   5. HOLD — mantém em observação, sem ação imediata
 */
export type FallbackAction = 'recover_bid' | 'increase_budget' | 'reactivate' | 'promote_exact' | 'HOLD';

export function generateSoftPauseFallback(input: {
  campaign_id: string;
  asin: string;
  paused_reason: string;
  has_safe_bid_capacity: boolean;
  has_margin: boolean;
  has_budget_available: boolean;
  has_stock: boolean;
  has_strong_search_term: boolean;
}): { fallback_action: FallbackAction; rationale: string } {
  // 1. Recuperar bid
  if (input.has_safe_bid_capacity && input.has_margin) {
    return {
      fallback_action: 'recover_bid',
      rationale: `Pausa soft dedupada; recuperando lance em vez de pausar. Safe CPC disponível, margem viável. Campanha: ${input.campaign_id}`,
    };
  }

  // 2. Aumentar budget
  if (input.has_budget_available && input.has_margin) {
    return {
      fallback_action: 'increase_budget',
      rationale: `Pausa soft dedupada; realocando budget ocioso em vez de pausar. ASIN: ${input.asin}`,
    };
  }

  // 3. Reativar
  if (input.has_stock && input.has_margin) {
    return {
      fallback_action: 'reactivate',
      rationale: `Pausa soft dedupada; reativando campanha pois estoque e economia se normalizaram. Campanha: ${input.campaign_id}`,
    };
  }

  // 4. Promover EXACT
  if (input.has_strong_search_term && input.has_margin) {
    return {
      fallback_action: 'promote_exact',
      rationale: `Pausa soft dedupada; promovendo termo forte para EXACT keyword em vez de pausar campanha. ASIN: ${input.asin}`,
    };
  }

  // 5. HOLD
  return {
    fallback_action: 'HOLD',
    rationale: `Pausa soft dedupada; mantendo em observação. Nenhuma alternativa viável no momento. Campanha: ${input.campaign_id}`,
  };
}

/**
 * NEW FIX #1: Marcar pausa como dedupada
 *
 * Registra que uma soft pause foi eliminada da duplicação e qual fallback foi escolhido
 * para não recriar a mesma pausa continuamente (PAUSE->CANCELLED storm prevention)
 */
export function markSoftPauseDeduplicated(decision: any, fallback: FallbackAction, fallbackRationale: string): void {
  decision.soft_pause_deduplicated = true;
  decision.soft_pause_dedup_timestamp = new Date().toISOString();
  decision.soft_pause_fallback_action = fallback;
  decision.soft_pause_fallback_rationale = fallbackRationale;
  decision.dedup_marker = `soft_pause_dedup|${decision.campaign_id || decision.entity_id}|${fallback}|${Date.now()}`;
}
