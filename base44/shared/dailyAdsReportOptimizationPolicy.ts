export const REQUIRED_DAILY_SP_REPORTS = [
  'spCampaigns',
  'spSearchTerm',
  'spAdvertisedProduct',
] as const;

const REPORT_OPTIMIZATION_START_HOUR_BRT = 7;
const REPORT_OPTIMIZATION_START_MINUTE_BRT = 25;
const PROCESSING_LEASE_MS = 60 * 60_000;
const RETRY_COOLDOWN_MS = 30 * 60_000;

export type DailyReportOptimizationRun = {
  status?: string;
  started_at?: string | null;
  completed_at?: string | null;
};

export type DailyReportOptimizationAssessment = {
  eligible: boolean;
  reason: string;
  report_date: string;
  target_report_date: string;
  retry_stale_run: boolean;
};

export function isDailyReportOptimizationSuccessful(input: {
  responseOk?: boolean;
  dataOk?: boolean;
  skipped?: boolean;
  failedActions?: number;
  confirmationOk?: boolean;
  confirmationDivergences?: number;
  confirmationRetries?: number;
}): boolean {
  return input.responseOk !== false && input.dataOk !== false && input.skipped !== true &&
    Number(input.failedActions || 0) === 0 && input.confirmationOk !== false &&
    Number(input.confirmationDivergences || 0) === 0 &&
    Number(input.confirmationRetries || 0) === 0;
}

const REQUIRED_GROUP_BY: Record<string, string> = {
  spCampaigns: 'campaign',
  spSearchTerm: 'searchTerm',
  spAdvertisedProduct: 'advertiser',
};

export function canonicalDailyReportTypesForDate(
  jobs: Array<{ report_type_id?: unknown; group_by?: unknown; end_date?: unknown }>,
  reportDate: string,
): string[] {
  return [...new Set(jobs
    .filter((job) => String(job.end_date || '') === reportDate && isCanonicalDailyReportJob(job))
    .map((job) => String(job.report_type_id)))].sort();
}

export function isCanonicalDailyReportJob(job: {
  report_type_id?: unknown;
  group_by?: unknown;
}): boolean {
  const requiredGroup = REQUIRED_GROUP_BY[String(job.report_type_id || '')];
  if (!requiredGroup) return false;
  let groupBy: string[] = [];
  if (Array.isArray(job.group_by)) groupBy = job.group_by.map(String);
  else if (typeof job.group_by === 'string') {
    try {
      const parsed = JSON.parse(job.group_by);
      if (Array.isArray(parsed)) groupBy = parsed.map(String);
    } catch {
      return false;
    }
  }
  return groupBy.includes(requiredGroup);
}

export function brazilCalendarDate(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function previousBrazilCalendarDate(date: Date): string {
  const [year, month, day] = brazilCalendarDate(date).split('-').map(Number);
  const previous = new Date(Date.UTC(year, month - 1, day - 1, 12));
  return previous.toISOString().slice(0, 10);
}

function brazilHourAndMinute(date: Date): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { hour: Number(values.hour) % 24, minute: Number(values.minute) };
}

export function assessDailyReportOptimization(input: {
  now: Date;
  reportDate: string;
  processedReportTypes: string[];
  existingRun?: DailyReportOptimizationRun | null;
}): DailyReportOptimizationAssessment {
  const targetReportDate = previousBrazilCalendarDate(input.now);
  const base = {
    report_date: input.reportDate,
    target_report_date: targetReportDate,
    retry_stale_run: false,
  };
  if (input.reportDate !== targetReportDate) {
    return { ...base, eligible: false, reason: 'latest_closed_day_report_not_ready' };
  }

  const time = brazilHourAndMinute(input.now);
  if (
    time.hour < REPORT_OPTIMIZATION_START_HOUR_BRT ||
    (time.hour === REPORT_OPTIMIZATION_START_HOUR_BRT &&
      time.minute < REPORT_OPTIMIZATION_START_MINUTE_BRT)
  ) {
    return { ...base, eligible: false, reason: 'waiting_for_closed_day_report_maturation' };
  }

  const processed = new Set(input.processedReportTypes);
  const missing = REQUIRED_DAILY_SP_REPORTS.filter((type) => !processed.has(type));
  if (missing.length) {
    return { ...base, eligible: false, reason: `required_reports_incomplete:${missing.join(',')}` };
  }

  const run = input.existingRun;
  if (!run) return { ...base, eligible: true, reason: 'ready' };
  const status = String(run.status || '').toLowerCase();
  if (['success', 'completed'].includes(status)) {
    return { ...base, eligible: false, reason: 'already_optimized_for_report_date' };
  }
  if (status === 'processing') {
    const startedAt = Date.parse(String(run.started_at || ''));
    if (Number.isFinite(startedAt) && input.now.getTime() - startedAt < PROCESSING_LEASE_MS) {
      return { ...base, eligible: false, reason: 'optimization_already_running' };
    }
    return { ...base, eligible: true, reason: 'recover_stale_optimization', retry_stale_run: true };
  }

  const completedAt = Date.parse(String(run.completed_at || ''));
  if (Number.isFinite(completedAt) && input.now.getTime() - completedAt < RETRY_COOLDOWN_MS) {
    return { ...base, eligible: false, reason: 'retry_cooldown' };
  }
  return { ...base, eligible: true, reason: 'retry_failed_optimization' };
}
