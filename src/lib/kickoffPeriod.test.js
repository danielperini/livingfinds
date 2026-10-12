import test from 'node:test';
import assert from 'node:assert/strict';
import { dateKeyInSaoPaulo, filterKickoffByDateRange, kickoffActivityDate, loadAllKickoffQueuePages } from './kickoffPeriod.js';

test('Kick-off date filter uses the Sao Paulo local day, including UTC midnight boundaries', () => {
  assert.equal(dateKeyInSaoPaulo('2026-10-13T02:30:00.000Z'), '2026-10-12');
  assert.equal(dateKeyInSaoPaulo('2026-10-13T03:30:00.000Z'), '2026-10-13');
});

test('Kick-off activity date prioritizes the latest execution event over queue creation', () => {
  const item = { created_date: '2026-10-10T14:00:00Z', last_attempt_at: '2026-10-12T15:00:00Z' };
  assert.equal(kickoffActivityDate(item), '2026-10-12');
  assert.deepEqual(filterKickoffByDateRange([item, { created_date: '2026-10-10T14:00:00Z' }], '2026-10-12', '2026-10-12'), [item]);
});

test('range filter includes both boundaries and supports open-ended ranges', () => {
  const rows = [
    { id: 'before', created_date: '2026-10-10T14:00:00Z' },
    { id: 'start', created_date: '2026-10-11T14:00:00Z' },
    { id: 'end', created_date: '2026-10-12T14:00:00Z' },
    { id: 'after', created_date: '2026-10-13T14:00:00Z' },
  ];
  assert.deepEqual(filterKickoffByDateRange(rows, '2026-10-11', '2026-10-12').map(row => row.id), ['start', 'end']);
  assert.deepEqual(filterKickoffByDateRange(rows, '2026-10-12').map(row => row.id), ['end', 'after']);
  assert.deepEqual(filterKickoffByDateRange(rows, '', '2026-10-11').map(row => row.id), ['before', 'start']);
});

test('empty range keeps all records for the explicit all-period option', () => {
  const rows = [{ created_date: '2026-10-10T14:00:00Z' }, { created_date: '2026-10-12T14:00:00Z' }];
  assert.deepEqual(filterKickoffByDateRange(rows), rows);
});

test('queue pagination loads every page and de-duplicates overlapping rows', async () => {
  const pages = [
    [{ id: '1' }, { id: '2' }],
    [{ id: '2' }, { id: '3' }],
    [{ id: '4' }],
  ];
  const offsets = [];
  const records = await loadAllKickoffQueuePages(async (offset, limit) => {
    offsets.push([offset, limit]);
    return pages[offset / limit] || [];
  }, 2);
  assert.deepEqual(offsets, [[0, 2], [2, 2], [4, 2]]);
  assert.deepEqual(records.map(record => record.id), ['1', '2', '3', '4']);
});

test('queue pagination stops when the API repeats a page despite increasing offsets', async () => {
  let calls = 0;
  const page = [{ id: '1' }, { id: '2' }];
  const records = await loadAllKickoffQueuePages(async () => {
    calls += 1;
    return page;
  }, 2);
  assert.equal(calls, 2);
  assert.deepEqual(records, page);
});
