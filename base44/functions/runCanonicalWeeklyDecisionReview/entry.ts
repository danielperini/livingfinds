import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { createAuditOutcome } from '../../shared/auditOutcome.ts';

const safeError = (value: unknown) => String((value as Error)?.message || value || 'weekly_review_failed')
  .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
  .replace(/Atza\|[^\s]+/gi, '[redacted]')
  .replace(/(token|secret|password|authorization)\s*[:=]\s*[^,\s"]+/gi, '$1=[redacted]')
  .replace(/[\r\n\t]+/g, ' ').slice(0, 500);

async function invoke(base44: any, name: string, payload: Record<string, unknown>) {
  try {
    const response = await base44.asServiceRole.functions.invoke(name, payload);
    const status = Number(response?.status);
    if (response?.ok === false || (Number.isFinite(status) && (status < 200 || status >= 300))) {
      throw new Error(`${name}:http_${status || 'unknown'}`);
    }
    const data = response?.data ?? response;
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`${name}:invalid_response`);
    return { data, error: null as string | null };
  } catch (error) {
    return { data: null, error: safeError(error) };
  }
}

Deno.serve(async (request) => {
  let correlationId: string = crypto.randomUUID();
  const sourceErrors: Array<Record<string, unknown>> = [];
  try {
    const body = await request.json().catch(() => ({}));
    correlationId = String(body.correlation_id || '').trim() || correlationId;
    const base44 = createClientFromRequest(request);
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    if (!authenticated && !body._service_role) {
      const outcome = createAuditOutcome({ correlationId, technicalFailure: true, technicalStatus: 'authentication_error',
        sourceErrors: [{ source: 'authentication', error: 'Não autorizado' }] });
      return Response.json({ ...outcome, error: 'Não autorizado' }, { status: 401 });
    }
    const core = await invoke(base44, 'runEconomicEvidenceDecisionPolicy', {
      amazon_account_id: body.amazon_account_id || null,
      _service_role: true,
      dry_run: false,
      weekly_review: true,
      max_candidates: 500,
      correlation_id: correlationId,
      trigger_type: 'weekly_gpt_economic_review',
    });
    if (core.error) sourceErrors.push({ source: 'deterministic_core', error: core.error });
    const economicEvidence = core.data || { ok: false, error: core.error || 'invalid_core_result' };
    const coreTechnicalFailure = core.error !== null || economicEvidence.technical_failure === true || economicEvidence.audit_status === 'technical_failure';

    // AI review is diagnostic. A provider failure must not erase a completed deterministic core.
    const ai = coreTechnicalFailure ? { data: null, error: null } : await invoke(base44, 'runWeeklyGptRuleReview', {
      ...body,
      _service_role: true,
      correlation_id: correlationId,
      economic_evidence_review: economicEvidence,
      trigger_type: body.trigger_type || 'canonical_weekly_gpt_review',
    });
    const gptReview = coreTechnicalFailure
      ? { ok: false, skipped: true, reason: 'deterministic_core_failure', diagnostic_only: true }
      : ai.data || { ok: false, error: ai.error || 'invalid_ai_diagnostic_result', diagnostic_only: true };
    const aiFailed = !coreTechnicalFailure && Boolean(ai.error || gptReview.ok === false || gptReview.technical_failure === true);
    if (aiFailed) sourceErrors.push({ source: 'openai_diagnostic', error: ai.error || safeError(gptReview.error || 'AI review incomplete'), diagnostic_only: true });

    const partial = aiFailed || economicEvidence.ok !== true || economicEvidence.partial === true || coreTechnicalFailure;
    const criticalAlerts = Array.isArray(economicEvidence.critical_alerts) ? economicEvidence.critical_alerts : [];
    const outcome = createAuditOutcome({ correlationId, criticalAlerts, partial, technicalFailure: coreTechnicalFailure,
      sourceErrors, completedAt: new Date().toISOString() });
    return Response.json({
      ...outcome,
      review: 'canonical-weekly-decision-review',
      shared_economic_policy: 'runEconomicEvidenceDecisionPolicy',
      same_policy_as_operational_cycle: true,
      economic_evidence: economicEvidence,
      gpt_review: gptReview,
      ai_provider: 'OpenAI',
      ai_diagnostic_status: coreTechnicalFailure ? 'skipped_core_failure' : aiFailed ? 'failed_diagnostic_only' : 'completed',
      manual_approval_required: false,
    }, { status: coreTechnicalFailure ? 500 : 200 });
  } catch (error) {
    const sourceError = { source: 'weekly_review', error: safeError(error) };
    const outcome = createAuditOutcome({ correlationId, technicalFailure: true, sourceErrors: [...sourceErrors, sourceError] });
    return Response.json({ ...outcome, error: sourceError.error }, { status: 500 });
  }
});
