export type SchedulerJob = {
  name: string;
  function: string;
  cron: string;
  payload?: Record<string, unknown>;
};

export function validateSchedule(jobs: SchedulerJob[]): string[] {
  const issues: string[] = [];
  const seen = new Map<string, string>();
  for (const job of jobs) {
    const key = job.function + '|' + job.cron + '|' + JSON.stringify(job.payload ?? {});
    const previous = seen.get(key);
    if (previous) issues.push('duplicate:' + job.function + ':' + previous + ':' + job.name);
    else seen.set(key, job.name);
    if (!job.name || !job.function || !job.cron || job.cron.trim().split(/\\s+/).length !== 5) {
      issues.push('invalid:' + (job.name || job.function || 'unnamed'));
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
  try { return { acquired: true, value: await action() }; }
  finally { await release(); }
}
