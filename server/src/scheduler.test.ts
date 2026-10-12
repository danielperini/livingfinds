import { assertEquals } from 'jsr:@std/assert@1';
import {
  dailyCatchUpSlot,
  isStaleFinalAttempt,
  isSuccessfulJobResponse,
  retryDelaySeconds,
  runWithLock,
  shouldDispatchRun,
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
