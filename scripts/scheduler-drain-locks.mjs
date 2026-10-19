import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export function schedulerLockKeys(schedule) {
  if (!schedule || !Array.isArray(schedule.jobs) || schedule.jobs.length === 0) {
    throw new Error('schedule must contain at least one job');
  }
  const keys = new Set();
  for (const job of schedule.jobs) {
    if (!job || typeof job.function !== 'string' || !/^[A-Za-z0-9_]+$/.test(job.function)) {
      throw new Error('schedule contains an invalid function name');
    }
    const account = String(job.payload?.amazon_account_id || 'all-accounts');
    keys.add(`livingfinds:scheduler:${job.function}|${account}`);
  }
  return [...keys].sort();
}

function sqlLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

export function buildSchedulerDrainSql(schedule) {
  const keys = schedulerLockKeys(schedule);
  const values = keys.map(sqlLiteral).join(', ');
  return `-- Generated from the canonical scheduler schedule. Keep this session open through deploy.
SET statement_timeout = '10min';
DO $drain$
DECLARE
  lock_keys text[] := ARRAY[${values}];
  key text;
  all_acquired boolean;
BEGIN
  LOOP
    all_acquired := true;
    FOREACH key IN ARRAY lock_keys LOOP
      IF NOT pg_try_advisory_lock(hashtextextended(key, 0)) THEN
        all_acquired := false;
        EXIT;
      END IF;
    END LOOP;
    IF all_acquired THEN
      EXIT;
    END IF;
    FOREACH key IN ARRAY lock_keys LOOP
      PERFORM pg_advisory_unlock(hashtextextended(key, 0));
    END LOOP;
    PERFORM pg_sleep(2);
  END LOOP;
END
$drain$;
RESET statement_timeout;
SELECT 'SCHEDULER_DRAIN_LOCKS_ACQUIRED';
SELECT pg_sleep(86400);
`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const here = dirname(fileURLToPath(import.meta.url));
  const schedulePath = resolve(here, '../base44/schedules/amazon-automation-schedule.json');
  const schedule = JSON.parse(readFileSync(schedulePath, 'utf8'));
  process.stdout.write(buildSchedulerDrainSql(schedule));
}
