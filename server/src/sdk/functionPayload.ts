export const READ_ONLY_FUNCTIONS = new Set(['getMotorDashboardStatus', 'getMotorCycleEvidence']);

export function buildFunctionPayload(name: string, payload: Record<string, any>, contextCorrelationId?: string | null) {
  if (READ_ONLY_FUNCTIONS.has(name)) return { ...payload };
  return { ...payload, correlation_id: contextCorrelationId || String(payload.correlation_id || '').trim() || crypto.randomUUID() };
}
