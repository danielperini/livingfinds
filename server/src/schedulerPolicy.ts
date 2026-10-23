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
