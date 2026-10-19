import test from 'node:test';
import assert from 'node:assert/strict';
import { dailyMotorNotice } from './dailyMotorStatus.js';

test('does not call an exhausted daily cycle idle', () => {
  const notice = dailyMotorNotice({ data: { daily_motor: {
    date: '2026-10-19', due: true, status: 'exhausted', attempts: 6,
    last_error: 'unified_engine:stage_failed',
  } } }, '2026-10-19T17:40:00.000Z');
  assert.equal(notice.tone, 'danger');
  assert.match(notice.title, /esgotado/);
  assert.match(notice.message, /6 tentativa/);
  assert.match(notice.message, /unified_engine:stage_failed/);
});

test('shows a running cycle without claiming it is complete', () => {
  const notice = dailyMotorNotice({ data: { daily_motor: {
    date: '2026-10-19', due: true, status: 'running', started_at: '2026-10-19T13:00:00Z',
  } } });
  assert.equal(notice.tone, 'info');
  assert.match(notice.message, /sem confirmação de conclusão/);
});

test('only confirmed success is reported as completed', () => {
  const notice = dailyMotorNotice({ data: { daily_motor: {
    date: '2026-10-19', due: true, status: 'succeeded', confirmed_success: true, attempts: 2,
  } } });
  assert.equal(notice.tone, 'success');
  assert.match(notice.title, /concluído/);
});

test('missing health never produces an idle claim', () => {
  const notice = dailyMotorNotice({ error: 'offline' });
  assert.equal(notice.tone, 'warning');
  assert.match(notice.title, /indisponível/);
});
