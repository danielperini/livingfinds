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
};

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

export function shouldDispatchRun(
  run: SchedulerRun | null | undefined,
  nowMs: number,
  maxAttempts: number,
): boolean {
  if (!run) return true;
  if (run.status === 'succeeded' || run.status === 'exhausted') return false;
  if (run.status === 'running') {
    const startedAt = Date.parse(String(run.started_at || ''));
    // Recover a process crash after a bounded lease; a recent worker may still be active.
    return Number(run.attempt_count || 0) < maxAttempts && Number.isFinite(startedAt) &&
      nowMs - startedAt > 10 * 60_000;
  }
  if (Number(run.attempt_count || 0) >= maxAttempts) return false;
  const nextAttempt = Date.parse(String(run.next_attempt_at || ''));
  return !Number.isFinite(nextAttempt) || nextAttempt <= nowMs;
}

export function isStaleFinalAttempt(
  run: SchedulerRun | null | undefined,
  nowMs: number,
  maxAttempts: number,
): boolean {
  if (run?.status !== 'running' || Number(run.attempt_count || 0) < maxAttempts) return false;
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
