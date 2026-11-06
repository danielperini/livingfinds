import { createOrLoadOptimizationDecision } from './optimizationDecisionIdempotency.ts';

type IdempotentResult = {
  decision: Record<string, unknown> | null;
  created: boolean;
  reused: boolean;
  conflict: null | { constraint: string; fields: string[] };
  diagnostic?: Record<string, unknown>;
};

/** Persist a sales-mode waste decision through the Hostinger PostgreSQL transaction. */
export async function createSalesModeWasteDecision(base44: any, input: Record<string, unknown>): Promise<IdempotentResult> {
  return await createOrLoadOptimizationDecision(
    base44.asServiceRole.entities.OptimizationDecision,
    input,
    {
      createIdempotent: async (decisionInput) => {
        const response = await base44.asServiceRole.functions.invoke('createOptimizationDecisionIdempotent', {
          _service_role: true, decision: decisionInput,
        });
        const result = response?.data ?? response ?? {};
        if (result?.ok !== true || (!result.decision && !result.conflict)) {
          throw new Error(`Criação idempotente indisponível: ${String(result?.error || 'resposta inválida').slice(0, 240)}`);
        }
        return {
          decision: result.decision || null, created: result.created === true,
          reused: result.reused === true, conflict: result.conflict || null,
          diagnostic: result.diagnostic || undefined,
        };
      },
    },
  );
}
