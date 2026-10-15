type DecisionEntity<T extends Record<string, unknown>> = {
  create: (input: Record<string, unknown>) => Promise<T>;
  filter: (query: Record<string, unknown>, sort?: string, limit?: number, offset?: number) => Promise<T[]>;
};

export type IdempotentDecisionResult<T extends Record<string, unknown>> = {
  decision: T | null;
  created: boolean;
  reused: boolean;
  conflict: null | { constraint: string; fields: string[] };
  diagnostic?: Record<string, unknown>;
};

function errorDetails(error: unknown): string {
  const value = error as any;
  return [value?.message, value?.details, value?.constraint, value?.cause?.message]
    .filter(Boolean).map(String).join(' ');
}

function isIdempotencyUniqueConflict(error: unknown): boolean {
  const value = error as any;
  const details = errorDetails(error).toLowerCase();
  return details.includes('optimization_decision_idempotency_unique') ||
    (String(value?.code || '') === '23505' && details.includes('idempotency'));
}

const INTENT_FIELDS = [
  'amazon_account_id', 'decision_type', 'entity_type', 'entity_id',
  'campaign_id', 'ad_group_id', 'keyword_id', 'target_id', 'asin', 'sku', 'action',
  'canonical_action_type', 'rule_key', 'reason_code', 'decision_window', 'cycle_key',
  'value_before', 'value_after', 'proposed_value',
];

function intentConflicts(existing: Record<string, unknown>, proposed: Record<string, unknown>) {
  const fields = INTENT_FIELDS.filter((field) => {
    const normalize = (value: unknown) => value == null || value === '' ? '' : typeof value === 'number' ? String(value) : String(value).trim();
    return normalize(existing[field]) !== normalize(proposed[field]);
  });
  return fields.length ? { constraint: 'optimization_decision_idempotency_unique', fields } : null;
}

function reusedOrConflict<T extends Record<string, unknown>>(rows: T[], input: Record<string, unknown>): IdempotentDecisionResult<T> | null {
  if (rows.length > 1) return {
    decision: null, created: false, reused: false,
    conflict: { constraint: 'optimization_decision_idempotency_unique', fields: ['multiple_existing_rows'] },
  };
  const decision = rows[0];
  if (!decision) return null;
  const conflict = intentConflicts(decision, input);
  return { decision, created: false, reused: !conflict, conflict };
}

/**
 * Makes concurrent decision creation idempotent. A unique-key race is only
 * treated as success when the canonical row can be read back by account/key.
 */
export async function createOrLoadOptimizationDecision<T extends Record<string, unknown>>(
  entity: DecisionEntity<T>,
  input: Record<string, unknown>,
  options: { createIdempotent?: (input: Record<string, unknown>) => Promise<IdempotentDecisionResult<T>> } = {},
): Promise<IdempotentDecisionResult<T>> {
  if (options.createIdempotent) return await options.createIdempotent(input);

  // Legacy adapter fallback remains useful for unit tests and external callers.
  // The Hostinger lifecycle paths explicitly pass the PostgreSQL operation above.
  const accountId = String(input.amazon_account_id || '');
  const idempotencyKey = String(input.idempotency_key || '');
  if (accountId && idempotencyKey) {
    const existing = await entity.filter({ amazon_account_id: accountId, idempotency_key: idempotencyKey }, '-created_at', 10, 0);
    const matches = existing.filter((row) => String(row.amazon_account_id || '') === accountId && String(row.idempotency_key || '') === idempotencyKey);
    const result = reusedOrConflict(matches, input);
    if (result) return result;
  }
  try {
    return { decision: await entity.create(input), created: true, reused: false, conflict: null };
  } catch (error) {
    if (!isIdempotencyUniqueConflict(error)) throw error;
    if (!accountId || !idempotencyKey) throw error;

    // The unique-key winner may not be visible to a read immediately after the
    // insert conflict. Retry bounded reads, then preserve the original error.
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, Math.min(250, 25 * 2 ** attempt)));
      const rows = await entity.filter({ amazon_account_id: accountId, idempotency_key: idempotencyKey }, '-created_at', 10, 0);
      const matches = rows.filter((row) => String(row.amazon_account_id || '') === accountId && String(row.idempotency_key || '') === idempotencyKey);
      const result = reusedOrConflict(matches, input);
      if (result) return result;
    }
    throw error;
  }
}
