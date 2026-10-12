import { assertEquals } from 'jsr:@std/assert@1';
import { validateSchedule } from './scheduler.ts';

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
