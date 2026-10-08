/** Preserve the existing decision (including terminal status) on an idempotency race. */
export async function createOptimizationDecisionOnce(entity: any, payload: any) {
  try {
    return await entity.create(payload);
  } catch (error: any) {
    const detail = String(error?.constraint_name || error?.constraint || error?.message || '');
    if (!payload.amazon_account_id || !payload.idempotency_key ||
      !detail.includes('optimization_decision_idempotency_unique')) throw error;
    const rows = await entity.filter({
      amazon_account_id: payload.amazon_account_id,
      idempotency_key: payload.idempotency_key,
    }, undefined, 1);
    if (!rows?.[0]) throw error;
    return rows[0];
  }
}
