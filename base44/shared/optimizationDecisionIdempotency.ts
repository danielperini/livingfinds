type DecisionEntity<T extends Record<string, unknown>> = {
  create: (input: Record<string, unknown>) => Promise<T>;
  filter: (query: Record<string, unknown>, sort?: string, limit?: number, offset?: number) => Promise<T[]>;
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

/**
 * Makes concurrent decision creation idempotent. A unique-key race is only
 * treated as success when the canonical row can be read back by account/key.
 */
export async function createOrLoadOptimizationDecision<T extends Record<string, unknown>>(
  entity: DecisionEntity<T>,
  input: Record<string, unknown>,
): Promise<{ decision: T; created: boolean }> {
  try {
    return { decision: await entity.create(input), created: true };
  } catch (error) {
    if (!isIdempotencyUniqueConflict(error)) throw error;
    const accountId = String(input.amazon_account_id || '');
    const idempotencyKey = String(input.idempotency_key || '');
    if (!accountId || !idempotencyKey) throw error;

    const rows = await entity.filter({ amazon_account_id: accountId, idempotency_key: idempotencyKey }, '-created_at', 10, 0);
    const decision = rows.find((row) =>
      String(row.amazon_account_id || '') === accountId && String(row.idempotency_key || '') === idempotencyKey
    );
    if (!decision) throw error;
    return { decision, created: false };
  }
}
