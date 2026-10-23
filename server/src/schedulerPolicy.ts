export type SchedulerJob = {
  name: string;
  function: string;
  cron: string;
  payload?: Record<string, unknown>;
  /** Reexecuta no dia local se a janela do cron foi perdida durante uma queda. */
  catch_up_daily?: boolean;
  /** Função watchdog cuja confirmação pode reconciliar este ciclo diário. */
  reconciles_daily_function?: string;
  retry?: { max_attempts?: number; base_delay_seconds?: number; max_delay_seconds?: number };
};

export type SchedulerRun = {
  status?: string;
  attempt_count?: number;
  next_attempt_at?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  recovery_count?: number;
  last_error?: string | null;
  remote_outcome?: string;
};

export type ClassifiedAuditOutcome = {
  scheduler_success: boolean;
  classification: 'completed' | 'completed_with_alerts' | 'partial' | 'technical_failure' | 'authentication_error' | 'timeout' | 'invalid_response';
  error: string | null;
  summary: Record<string, unknown> | null;
};

const AUDIT_CLASSIFIED_JOBS = new Set([
  'auditAdsAutomationE2E',
  'runCanonicalWeeklyDecisionReview',
]);

export function isAuditOutcomeJob(functionName: string): boolean {
  return AUDIT_CLASSIFIED_JOBS.has(functionName);
}

function summarizeAuditPayload(payload: any): Record<string, unknown> | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const safeText = (value: unknown) => String(value || '').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/Atza\|[^\s]+/gi, '[redacted]')
    .replace(/(token|secret|password|authorization)\s*[:=]\s*[^,\s"]+/gi, '$1=[redacted]')
    .replace(/[\r\n\t]+/g, ' ').slice(0, 500);
  return {
    ...(typeof payload.ok === 'boolean' ? { ok: payload.ok } : {}),
    ...(typeof payload.audit_status === 'string' ? { audit_status: safeText(payload.audit_status) } : {}),
    ...(typeof payload.technical_failure === 'boolean' ? { technical_failure: payload.technical_failure } : {}),
    critical_alerts: Array.isArray(payload.critical_alerts) ? payload.critical_alerts.slice(0, 100) : [],
    ...(typeof payload.partial === 'boolean' ? { partial: payload.partial } : {}),
    partial_reasons: Array.isArray(payload.partial_reasons) ? payload.partial_reasons.slice(0, 50).map(safeText) : [],
    ...(typeof payload.correlation_id === 'string' ? { correlation_id: payload.correlation_id.slice(0, 180) } : {}),
    source_errors: Array.isArray(payload.source_errors) ? payload.source_errors.slice(0, 50).map((item: any) => ({
      source: safeText(item?.source || 'unknown'), error: safeText(item?.error || item?.message || item),
      ...(item?.diagnostic_only === true ? { diagnostic_only: true } : {}),
    })) : [],
    ...(typeof payload.completed_at === 'string' ? { completed_at: payload.completed_at } : {}),
  };
}

export function classifyAuditJobException(functionName: string, error: unknown, correlationId: string) {
  if (!isAuditOutcomeJob(functionName)) return null;
  const message = String((error as Error)?.message || error || 'scheduler_invocation_failed');
  const timeout = /timeout|timed out|deadline exceeded|aborterror/i.test(message);
  const authenticationError = /\b401\b|\b403\b|unauthori[sz]ed|authentication failed|invalid token/i.test(message);
  const auditStatus = timeout ? 'timeout' : authenticationError ? 'authentication_error' : 'technical_failure';
  return {
    scheduler_success: false,
    classification: auditStatus as 'timeout' | 'authentication_error' | 'technical_failure',
    error: message.slice(0, 500),
    summary: {
      ok: false,
      audit_status: auditStatus,
      technical_failure: true,
      critical_alerts: [],
      partial: false,
      correlation_id: correlationId,
      source_errors: [{ source: functionName, error: message.slice(0, 500) }],
      completed_at: new Date().toISOString(),
    },
  };
}

/**
 * These jobs report operational findings as data. Business alerts and partial
 * coverage do not make the scheduler itself fail; only a transport/runtime
 * failure or an invalid explicit outcome contract does.
 */
export function classifyAuditJobResponse(functionName: string, response: any): ClassifiedAuditOutcome | null {
  if (!AUDIT_CLASSIFIED_JOBS.has(functionName)) return null;
  const status = Number(response?.status ?? response?.statusCode);
  const payload = response?.data && typeof response.data === 'object' && !Array.isArray(response.data)
    ? response.data
    : response;
  const fail = (classification: ClassifiedAuditOutcome['classification'], error: string): ClassifiedAuditOutcome => ({
    scheduler_success: false, classification, error, summary: summarizeAuditPayload(payload),
  });
  if (status === 401 || status === 403) return fail('authentication_error', `HTTP ${status} authentication failure`);
  if (status === 408 || status === 504 || payload?.timed_out === true) return fail('timeout', `HTTP ${status || 'unknown'} timeout`);
  if (Number.isFinite(status) && (status < 200 || status >= 300)) {
    return fail('technical_failure', `HTTP ${status} response`);
  }
  if (!response || typeof response !== 'object' || Array.isArray(response) || response.ok !== true || !Number.isFinite(status)) {
    return fail('invalid_response', 'missing successful HTTP response envelope');
  }
  const required = ['ok', 'audit_status', 'technical_failure', 'critical_alerts', 'partial', 'correlation_id', 'source_errors', 'completed_at'];
  if (!payload || required.some((key) => !(key in payload)) || typeof payload.ok !== 'boolean' ||
    typeof payload.technical_failure !== 'boolean' || typeof payload.partial !== 'boolean' ||
    typeof payload.audit_status !== 'string' || !Array.isArray(payload.critical_alerts) ||
    !Array.isArray(payload.source_errors) || typeof payload.correlation_id !== 'string' || !payload.correlation_id.trim() ||
    !Number.isFinite(Date.parse(payload.completed_at))) {
    return fail('invalid_response', 'invalid explicit audit outcome contract');
  }
  if (payload.technical_failure || ['technical_failure', 'authentication_error', 'timeout'].includes(payload.audit_status)) {
    const classification = payload.audit_status === 'authentication_error' ? 'authentication_error'
      : payload.audit_status === 'timeout' ? 'timeout' : 'technical_failure';
    const details = payload.source_errors.map((item: any) => String(item?.error || item?.message || item)).filter(Boolean).join('; ');
    return fail(classification, details || `audit reported ${classification}`);
  }
  if (!['completed', 'completed_with_alerts', 'partial'].includes(payload.audit_status) ||
    (!payload.ok && !payload.partial && payload.critical_alerts.length === 0)) {
    return fail('invalid_response', 'inconsistent audit outcome contract');
  }
  const classification = payload.partial ? 'partial'
    : payload.critical_alerts.length || payload.audit_status === 'completed_with_alerts' ? 'completed_with_alerts'
    : 'completed';
  return { scheduler_success: true, classification, error: null, summary: summarizeAuditPayload(payload) };
}

export function schedulerReplayBlocked(run: SchedulerRun | null | undefined): boolean {
  return run?.remote_outcome === 'unknown' || /deployment_interrupted|remote_unknown|remote[ _](state|outcome).*?(unknown|not confirmed)|(?:estado|resultado) remoto desconhecido|automatic replay blocked/i.test(run?.last_error || '');
}

export function isDailyCycleExecutionConfirmedResponse(response: any): boolean {
  if (!response || response.ok !== true) return false;
  const data = response.data ?? response;
  const reports = Array.isArray(data?.reports) ? data.reports : [];
  return reports.length > 0 && reports.every((report: any) =>
    report?.daily_cycle?.status === 'confirmed' &&
    report?.execution?.executor === 'confirmed' &&
    report?.execution?.confirmation === 'confirmed'
  );
}

export function isSuccessfulJobResponse(response: any): boolean {
  if (!response || response.ok !== true || response.data?.ok === false) return false;
  const hasFailedStage = (value: any, depth = 0): boolean => {
    if (!value || typeof value !== 'object' || depth > 6) return false;
    if (value.ok === false) return true;
    if (Array.isArray(value)) return value.some((item) => hasFailedStage(item, depth + 1));
    return Object.values(value).some((item) => hasFailedStage(item, depth + 1));
  };
  return !hasFailedStage(response.data?.stages);
}

export function failedJobStages(response: any): Array<{ name: string; detail: string }> {
  const data = response?.data ?? response;
  const candidates: Record<string, any> = data?.stages && typeof data.stages === 'object' ? { ...data.stages } : {};
  for (const [name, stage] of Object.entries({
    economic_evidence: data?.economic_evidence,
    unified_engine: data?.unified_engine,
    reconciliation: data?.pre_execution_reconciliation ?? data?.reconciliation,
    arbitration: data?.pre_execution_arbitration ?? data?.arbitration,
    supervision: data?.v6sia_supervision ?? data?.supervision,
  })) {
    if (!(name in candidates) && stage !== undefined) candidates[name] = stage;
  }
  const failures: Array<{ name: string; detail: string }> = [];
  for (const [name, stage] of Object.entries(candidates)) {
    if (!stage || typeof stage !== 'object' || stage.ok !== false) continue;
    const nested = Array.isArray(stage.failed_stages) ? stage.failed_stages : [];
    const nestedFailures = nested
      .filter((item: any) => item && typeof item === 'object')
      .map((item: any, index: number) => ({
        name: String(item.stage || item.name || `${name}.failed_stage_${index + 1}`),
        detail: String(item.error || item.detail || item.reason || item.message || item.status || 'stage_failed'),
      }));
    if (nestedFailures.length) {
      failures.push(...nestedFailures);
      continue;
    }
    failures.push({
      name,
      detail: String(stage.error || stage.message || stage.reason || stage.status || 'stage_failed'),
    });
  }
  return failures;
}

export function shouldDispatchRun(
  run: SchedulerRun | null | undefined,
  nowMs: number,
  maxAttempts: number,
): boolean {
  if (schedulerReplayBlocked(run)) return false;
  if (!run) return true;
  if (run.status === 'succeeded' || run.status === 'exhausted') return false;
  if (run.status === 'running') return false; // A lost lease does not prove a remote write was not sent.

  if (Number(run.attempt_count || 0) >= maxAttempts) return false;
  const nextAttempt = Date.parse(String(run.next_attempt_at || ''));
  return !Number.isFinite(nextAttempt) || nextAttempt <= nowMs;
}

export function shouldRecoverDailyCatchUpRun(
  job: SchedulerJob,
  run: SchedulerRun | null | undefined,
  nowMs: number,
  cooldownMs = 60 * 60_000,
  maxRecoveries = 4,
): boolean {
  if (schedulerReplayBlocked(run)) return false;
  if (job.catch_up_daily !== true || run?.status !== 'exhausted') return false;
  if (Number(run.recovery_count || 0) >= maxRecoveries) return false;
  const finishedAt = Date.parse(String(run.finished_at || ''));
  return Number.isFinite(finishedAt) && nowMs - finishedAt >= cooldownMs;
}

export function shouldDispatchScheduledRun(
  job: SchedulerJob,
  run: SchedulerRun | null | undefined,
  nowMs: number,
  maxAttempts: number,
): boolean {
  return shouldDispatchRun(run, nowMs, maxAttempts) ||
    shouldRecoverDailyCatchUpRun(job, run, nowMs);
}

export function isStaleFinalAttempt(
  run: SchedulerRun | null | undefined,
  nowMs: number,
  maxAttempts: number,
): boolean {
  if (run?.status !== 'running') return false; // Any abandoned attempt requires reconciliation.
  const startedAt = Date.parse(String(run.started_at || ''));
  return Number.isFinite(startedAt) && nowMs - startedAt > 10 * 60_000;
}

export function retryDelaySeconds(attempt: number, baseSeconds = 60, maxSeconds = 1800): number {
  const safeAttempt = Math.max(1, Math.floor(Number(attempt) || 1));
  const base = Math.max(1, Math.floor(Number(baseSeconds) || 60));
  const max = Math.max(base, Math.floor(Number(maxSeconds) || 1800));
  return Math.min(max, base * (2 ** Math.min(safeAttempt - 1, 20)));
}

export function dailyCatchUpSlot(
  job: SchedulerJob,
  local: { year: number; month: number; day: number; hour: number; min: number },
): string | null {
  if (job.catch_up_daily !== true) return null;
  const fields = job.cron.trim().split(/\s+/);
  if (
    fields.length !== 5 || !/^\d+$/.test(fields[0]) || !/^\d+$/.test(fields[1]) ||
    fields.slice(2).some((field) => field !== '*')
  ) return null;
  const scheduledMinute = Number(fields[0]);
  const scheduledHour = Number(fields[1]);
  if (local.hour * 60 + local.min < scheduledHour * 60 + scheduledMinute) return null;
  return `${local.year}-${String(local.month).padStart(2, '0')}-${
    String(local.day).padStart(2, '0')
  }`;
}

export function validateSchedule(jobs: SchedulerJob[]): string[] {
  const issues: string[] = [];
  const seen = new Map<string, string>();
  for (const job of jobs) {
    const key = job.function + '|' + job.cron + '|' + JSON.stringify(job.payload ?? {});
    const previous = seen.get(key);
    if (previous) issues.push('duplicate:' + job.function + ':' + previous + ':' + job.name);
    else seen.set(key, job.name);
    if (!job.name || !job.function || !job.cron || job.cron.trim().split(/\s+/).length !== 5) {
      issues.push('invalid:' + (job.name || job.function || 'unnamed'));
    }
  }
  const dailyCatchUpFunctions = new Set(jobs.filter((job) => job.catch_up_daily === true).map((job) => job.function));
  for (const job of jobs) {
    if (job.reconciles_daily_function && !dailyCatchUpFunctions.has(job.reconciles_daily_function)) {
      issues.push('invalid_daily_reconciliation:' + job.function + ':' + job.reconciles_daily_function);
    }
  }
  return issues;
}

export async function runWithLock<T>(
  acquire: () => Promise<(() => Promise<void>) | null>,
  action: () => Promise<T>,
): Promise<{ acquired: false } | { acquired: true; value: T }> {
  const release = await acquire();
  if (!release) return { acquired: false };
  try {
    return { acquired: true, value: await action() };
  } finally {
    await release();
  }
}
