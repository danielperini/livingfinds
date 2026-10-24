export type AuditOutcomeInput = {
  correlationId: string;
  criticalAlerts?: unknown[];
  partial?: boolean;
  technicalFailure?: boolean;
  technicalStatus?: 'technical_failure' | 'authentication_error' | 'timeout';
  sourceErrors?: unknown[];
  completedAt?: string;
};

/** Shared result contract: operational findings are distinct from runtime failures. */
export function createAuditOutcome(input: AuditOutcomeInput) {
  const criticalAlerts = Array.isArray(input.criticalAlerts) ? input.criticalAlerts : [];
  const sourceErrors = Array.isArray(input.sourceErrors) ? input.sourceErrors : [];
  const technicalFailure = input.technicalFailure === true;
  const partial = input.partial === true;
  const auditStatus = technicalFailure
    ? input.technicalStatus || 'technical_failure'
    : partial ? 'partial' : criticalAlerts.length ? 'completed_with_alerts' : 'completed';
  return {
    ok: !technicalFailure && !partial && criticalAlerts.length === 0,
    audit_status: auditStatus,
    technical_failure: technicalFailure,
    critical_alerts: criticalAlerts,
    partial,
    correlation_id: String(input.correlationId || '').trim() || crypto.randomUUID(),
    source_errors: sourceErrors,
    completed_at: input.completedAt || new Date().toISOString(),
  };
}
