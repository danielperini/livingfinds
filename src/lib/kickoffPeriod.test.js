import test from 'node:test';
import assert from 'node:assert/strict';
import { dateKeyInSaoPaulo, filterKickoffByDate, kickoffActivityDate } from './kickoffPeriod.js';

test('Kick-off date filter uses the Sao Paulo local day, including UTC midnight boundaries', () => {
  assert.equal(dateKeyInSaoPaulo('2026-10-13T02:30:00.000Z'), '2026-10-12');
  assert.equal(dateKeyInSaoPaulo('2026-10-13T03:30:00.000Z'), '2026-10-13');
});

test('Kick-off activity date prioritizes the latest execution event over queue creation', () => {
  const item = { created_date: '2026-10-10T14:00:00Z', last_attempt_at: '2026-10-12T15:00:00Z' };
  assert.equal(kickoffActivityDate(item), '2026-10-12');
  assert.deepEqual(filterKickoffByDate([item, { created_date: '2026-10-10T14:00:00Z' }], '2026-10-12'), [item]);
});

test('empty date filter keeps all records for the explicit all-period option', () => {
  const rows = [{ created_date: '2026-10-10T14:00:00Z' }, { created_date: '2026-10-12T14:00:00Z' }];
  assert.deepEqual(filterKickoffByDate(rows, ''), rows);
});
