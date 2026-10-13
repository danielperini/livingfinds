import test from 'node:test';
import assert from 'node:assert/strict';
import { isRetryableQueueFailure, safeQueueError, summarizeOperationalQueue } from './operationalQueueHealth.js';

test('retryable failures remain in recovery only below the attempt ceiling', () => {
  assert.equal(isRetryableQueueFailure({ status: 'failed', attempt_count: 2, max_attempts: 5, last_error: 'Amazon 429 rate limit' }), true);
  assert.equal(isRetryableQueueFailure({ status: 'failed', attempt_count: 5, max_attempts: 5, last_error: 'Amazon 429 rate limit' }), false);
  assert.equal(isRetryableQueueFailure({ status: 'failed', attempt_count: 1, retryable: true }), true);
});

test('summary separates retrying, terminal, safety blocked and old history', () => {
  const now = Date.now();
  const recent = new Date(now - 60_000).toISOString();
  const old = new Date(now - 26 * 60 * 60 * 1000).toISOString();
  const rows = [
    { id: 'retry', status: 'failed', updated_at: recent, attempt_count: 1, last_error: '429 rate limit' },
    { id: 'terminal', status: 'failed', updated_at: recent, attempt_count: 5, last_error: 'invalid payload' },
    { id: 'blocked', status: 'failed', updated_at: recent, attempt_count: 5, last_error: 'no stock', asin: 'OUT' },
    { id: 'old', status: 'failed', updated_at: old, attempt_count: 5, last_error: 'invalid payload' },
    { id: 'done', status: 'completed', updated_at: recent },
    { id: 'cancelled', status: 'cancelled', updated_at: recent, last_error: 'Cancelled by operator' },
  ];
  const summary = summarizeOperationalQueue(rows, item => item.asin === 'OUT' ? { available_quantity: 0 } : null, now);
  assert.deepEqual(summary.retryingQueue.map(row => row.id), ['retry']);
  assert.deepEqual(summary.pendingQueue.map(row => row.id), ['retry']);
  assert.deepEqual(summary.failedQueue.map(row => row.id), ['terminal']);
  assert.deepEqual(summary.safetyBlockedQueue.map(row => row.id), ['blocked']);
  assert.deepEqual(summary.historicalQueue.map(row => row.id).sort(), ['cancelled', 'done', 'old']);
});

test('queue error presentation redacts credentials and truncates long details', () => {
  assert.equal(safeQueueError({ last_error: 'Bearer abc.def Atzr|secret client_secret=hidden' }), 'Bearer [token ocultado] [token ocultado] client_secret=[ocultado]');
  assert.equal(safeQueueError({ last_error: 'x'.repeat(400) }).length, 240);
});


import { isDecisionQueueOverdue } from './operationalQueueHealth.js';

test('decision alert includes only executable work that is past its due time', () => {
  const now = Date.now();
  const old = new Date(now - 30 * 60_000).toISOString();
  const future = new Date(now + 30 * 60_000).toISOString();
  assert.equal(isDecisionQueueOverdue({ status: 'approved', queue_status: 'pending', queued_at: old }, now), true);
  assert.equal(isDecisionQueueOverdue({ status: 'waiting_retry', queue_status: 'scheduled', next_retry_at: future, created_at: old }, now), false);
  assert.equal(isDecisionQueueOverdue({ status: 'pending_approval', queue_status: 'pending', created_at: old }, now), false);
  assert.equal(isDecisionQueueOverdue({ status: 'pending', queue_status: 'completed', created_at: old }, now), false);
  assert.equal(isDecisionQueueOverdue({ status: 'approved', queue_status: 'failed', created_at: old }, now), false);
  assert.equal(isDecisionQueueOverdue({ status: 'completed', queue_status: 'completed', created_at: old }, now), false);
  assert.equal(isDecisionQueueOverdue({ status: 'approved', queue_status: 'pending', queued_at: new Date(now - 10 * 60_000).toISOString() }, now), false);
});
