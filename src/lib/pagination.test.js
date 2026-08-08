import test from 'node:test';
import assert from 'node:assert/strict';
import { pageRange, visiblePageNumbers } from './pagination.js';

test('keeps first, current neighborhood and last page visible', () => {
  assert.deepEqual(visiblePageNumbers(5, 10), [1, 'ellipsis-4', 4, 5, 6, 'ellipsis-10', 10]);
});

test('calculates a range without exceeding the total', () => {
  assert.deepEqual(pageRange(3, 50, 121), { from: 101, to: 121 });
  assert.deepEqual(pageRange(1, 50, 0), { from: 0, to: 0 });
});
