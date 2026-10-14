import { assertEquals } from 'jsr:@std/assert@1';
import {
  dailyCatchUpSlot,
  failedJobStages,
  isDailyCycleExecutionConfirmedResponse,
  isStaleFinalAttempt,
  isSuccessfulJobResponse,
  retryDelaySeconds,
  runWithLock,
  shouldDispatchRun,
  shouldDispatchScheduledRun,
  shouldRecoverDailyCatchUpRun,
  validateSchedule,
} from './schedulerPolicy.ts';

Deno.test('schedule validation catches exact duplicate jobs but allows distinct payloads', () => {
  const jobs = [
    { name: 'one', function: 'sync', cron: '*/15 * * * *', payload: { account: 'a' } },
    { name: 'duplicate', function: 'sync', cron: '*/15 * * * *', payload: { account: 'a' } },
    { name: 'other account', function: 'sync', cron: '*/15 * * * *', payload: { account: 'b' } },
  ];
  assertEquals(validateSchedule(jobs), ['duplicate:sync:one:duplicate']);
});

Deno.test('schedule validation rejects malformed cron definitions', () => {
  assertEquals(validateSchedule([{ name: 'bad', function: 'sync', cron: 'every 15 minutes' }]), [
    'invalid:bad',
  ]);
});

Deno.test('schedule diária declara watchdog redundante ligado ao ciclo canônico', async () => {
  const schedulePath = new URL('../../base44/schedules/amazon-automation-schedule.json', import.meta.url);
  const config = JSON.parse(await Deno.readTextFile(schedulePath));
  const jobs = config.jobs;
  const watchdog = jobs.find((job: any) => job.function === 'runDailyMotorWatchdog');
  assertEquals(watchdog?.catch_up_daily, true);
  assertEquals(watchdog?.reconciles_daily_function, 'runCanonicalDecisionCycle');
  assertEquals(jobs.some((job: any) => job.function === watchdog?.reconciles_daily_function && job.catch_up_daily === true), true);
  assertEquals(validateSchedule(jobs), []);
});

Deno.test('runWithLock skips when another owner holds the lock', async () => {
  let ran = false;
  const result = await runWithLock(async () => null, async () => {
    ran = true;
  });
  assertEquals(result, { acquired: false });
  assertEquals(ran, false);
});

Deno.test('runWithLock always releases after success or failure', async () => {
  let releases = 0;
  const acquire = async () => async () => {
    releases++;
  };
  assertEquals(await runWithLock(acquire, async () => 42), { acquired: true, value: 42 });
  try {
    await runWithLock(acquire, async () => {
      throw new Error('expected');
    });
  } catch { /* expected */ }
  assertEquals(releases, 2);
});

Deno.test('daily motor catch-up runs only after its local scheduled time', () => {
  const job = {
    name: 'daily motor',
    function: 'runCanonicalDecisionCycle',
    cron: '25 1 * * *',
    catch_up_daily: true,
  };
  assertEquals(dailyCatchUpSlot(job, { year: 2026, month: 10, day: 12, hour: 1, min: 24 }), null);
  assertEquals(
    dailyCatchUpSlot(job, { year: 2026, month: 10, day: 12, hour: 1, min: 25 }),
    '2026-10-12',
  );
  assertEquals(
    dailyCatchUpSlot(job, { year: 2026, month: 10, day: 12, hour: 8, min: 0 }),
    '2026-10-12',
  );
  assertEquals(
    dailyCatchUpSlot({ ...job, catch_up_daily: false }, {
      year: 2026,
      month: 10,
      day: 12,
      hour: 8,
      min: 0,
    }),
    null,
  );
  assertEquals(
    dailyCatchUpSlot({ ...job, cron: '25 1 * * 0' }, {
      year: 2026,
      month: 10,
      day: 12,
      hour: 8,
      min: 0,
    }),
    null,
  );
});

Deno.test('retry backoff is exponential and capped', () => {
  assertEquals(retryDelaySeconds(1, 60, 300), 60);
  assertEquals(retryDelaySeconds(2, 60, 300), 120);
  assertEquals(retryDelaySeconds(8, 60, 300), 300);
});

Deno.test('persistent scheduler states retry only after due time and stop terminal runs', () => {
  const now = Date.parse('2026-10-12T12:00:00Z');
  assertEquals(shouldDispatchRun(null, now, 6), true);
  assertEquals(
    shouldDispatchRun(
      { status: 'failed', attempt_count: 1, next_attempt_at: '2026-10-12T12:01:00Z' },
      now,
      6,
    ),
    false,
  );
  assertEquals(
    shouldDispatchRun(
      { status: 'failed', attempt_count: 1, next_attempt_at: '2026-10-12T11:59:00Z' },
      now,
      6,
    ),
    true,
  );
  assertEquals(shouldDispatchRun({ status: 'succeeded', attempt_count: 1 }, now, 6), false);
  assertEquals(shouldDispatchRun({ status: 'exhausted', attempt_count: 6 }, now, 6), false);
  assertEquals(
    shouldDispatchRun(
      { status: 'running', attempt_count: 1, started_at: '2026-10-12T11:40:00Z' },
      now,
      6,
    ),
    true,
  );
  assertEquals(
    shouldDispatchRun(
      { status: 'running', attempt_count: 1, started_at: '2026-10-12T11:59:00Z' },
      now,
      6,
    ),
    false,
  );
  const finalStaleRun = { status: 'running', attempt_count: 6, started_at: '2026-10-12T11:40:00Z' };
  assertEquals(shouldDispatchRun(finalStaleRun, now, 6), false);
  assertEquals(isStaleFinalAttempt(finalStaleRun, now, 6), true);
});

Deno.test('exhausted daily catch-up receives bounded recoveries after cooldown', () => {
  const job = { name: 'daily motor', function: 'runCanonicalDecisionCycle', cron: '25 1 * * *', catch_up_daily: true };
  const now = Date.parse('2026-10-13T12:00:00Z');
  const exhausted = { status: 'exhausted', attempt_count: 6, recovery_count: 0, finished_at: '2026-10-13T10:59:00Z' };
  assertEquals(shouldRecoverDailyCatchUpRun(job, exhausted, now), true);
  assertEquals(shouldDispatchScheduledRun(job, exhausted, now, 6), true);
  assertEquals(shouldRecoverDailyCatchUpRun(job, { ...exhausted, finished_at: '2026-10-13T11:01:00Z' }, now), false);
  assertEquals(shouldRecoverDailyCatchUpRun(job, { ...exhausted, recovery_count: 1 }, now), true);
  assertEquals(shouldRecoverDailyCatchUpRun(job, { ...exhausted, recovery_count: 2 }, now), true);
  assertEquals(shouldRecoverDailyCatchUpRun(job, { ...exhausted, recovery_count: 3 }, now), false);
  assertEquals(shouldRecoverDailyCatchUpRun({ ...job, catch_up_daily: false }, exhausted, now), false);
  assertEquals(shouldDispatchRun(exhausted, now, 6), false);
});

Deno.test('canonical cycle failures identify the actual failed stage', () => {
  assertEquals(failedJobStages({ ok: true, status: 200, data: {
    ok: false,
    economic_evidence: { ok: true },
    unified_engine: { ok: false, error: 'metrics query timed out' },
    pre_execution_reconciliation: { ok: false, reason: 'partial' },
    pre_execution_arbitration: { ok: true },
  } }), [
    { name: 'unified_engine', detail: 'metrics query timed out' },
    { name: 'reconciliation', detail: 'partial' },
  ]);
});

Deno.test('watchdog reconciles a confirmed Ads cycle despite unrelated audit failure', () => {
  const response = { ok: true, data: { ok: false, reports: [{
    daily_cycle: { status: 'confirmed' },
    execution: { executor: 'confirmed', confirmation: 'confirmed' },
    sku_coverage: { health: 'incomplete' },
  }] } };
  assertEquals(isDailyCycleExecutionConfirmedResponse(response), true);
  assertEquals(isDailyCycleExecutionConfirmedResponse({ ok: true, data: { reports: [{
    daily_cycle: { status: 'confirmed' },
    execution: { executor: 'confirmed', confirmation: 'failed' },
  }] } }), false);
  assertEquals(isDailyCycleExecutionConfirmedResponse({ ok: true, data: { reports: [] } }), false);
});
Deno.test('partial engine responses are not recorded as successful scheduler runs', () => {
  assertEquals(
    isSuccessfulJobResponse({ ok: true, data: { ok: true, stages: { metrics: { ok: true } } } }),
    true,
  );
  assertEquals(
    isSuccessfulJobResponse({
      ok: true,
      data: { ok: true, stages: { metrics: { ok: false, error: 'timeout' } } },
    }),
    false,
  );
  assertEquals(isSuccessfulJobResponse({ ok: true, data: { ok: false } }), false);
  assertEquals(isSuccessfulJobResponse({ ok: false, status: 502 }), false);
});
