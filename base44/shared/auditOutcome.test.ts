import { assertEquals } from 'jsr:@std/assert@1';
import { createAuditOutcome } from './auditOutcome.ts';

Deno.test('critical commercial alerts complete the audit without implying a technical failure', () => {
  const outcome = createAuditOutcome({ correlationId: 'audit-1', criticalAlerts: ['DECISION_STALE'] });
  assertEquals(outcome.ok, false);
  assertEquals(outcome.audit_status, 'completed_with_alerts');
  assertEquals(outcome.technical_failure, false);
  assertEquals(outcome.critical_alerts, ['DECISION_STALE']);
});

Deno.test('partial audit coverage is explicit and not classified as a technical failure', () => {
  const outcome = createAuditOutcome({ correlationId: 'audit-2', partial: true });
  assertEquals(outcome.audit_status, 'partial');
  assertEquals(outcome.partial, true);
  assertEquals(outcome.technical_failure, false);
});

Deno.test('technical and authentication failures retain the full explicit contract', () => {
  const outcome = createAuditOutcome({ correlationId: 'audit-3', technicalFailure: true,
    technicalStatus: 'authentication_error', sourceErrors: [{ source: 'auth', error: 'unauthorized' }] });
  assertEquals(Object.keys(outcome).sort(), [
    'audit_status', 'completed_at', 'correlation_id', 'critical_alerts', 'ok', 'partial', 'source_errors', 'technical_failure',
  ]);
  assertEquals(outcome.audit_status, 'authentication_error');
  assertEquals(outcome.technical_failure, true);
});
