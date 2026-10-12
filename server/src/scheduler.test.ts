import { assertEquals } from 'jsr:@std/assert@1';
import { runWithLock, validateSchedule } from './schedulerPolicy.ts';

Deno.test('schedule validation catches exact duplicate jobs but allows distinct payloads', () => {
  const jobs = [
    { name: 'one', function: 'sync', cron: '*/15 * * * *', payload: { account: 'a' } },
    { name: 'duplicate', function: 'sync', cron: '*/15 * * * *', payload: { account: 'a' } },
    { name: 'other account', function: 'sync', cron: '*/15 * * * *', payload: { account: 'b' } },
  ];
  assertEquals(validateSchedule(jobs), ['duplicate:sync:one:duplicate']);
});

Deno.test('schedule validation rejects malformed cron definitions', () => {
  assertEquals(validateSchedule([{ name: 'bad', function: 'sync', cron: 'every 15 minutes' }]), ['invalid:bad']);
});

Deno.test('runWithLock skips when another owner holds the lock', async () => {
  let ran = false;
  const result = await runWithLock(async () => null, async () => { ran = true; });
  assertEquals(result, { acquired: false });
  assertEquals(ran, false);
});

Deno.test('runWithLock always releases after success or failure', async () => {
  let releases = 0;
  const acquire = async () => async () => { releases++; };
  assertEquals(await runWithLock(acquire, async () => 42), { acquired: true, value: 42 });
  try { await runWithLock(acquire, async () => { throw new Error('expected'); }); } catch { /* expected */ }
  assertEquals(releases, 2);
});
