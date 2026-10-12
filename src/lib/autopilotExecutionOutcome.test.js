import test from 'node:test';
import assert from 'node:assert/strict';
import { getExecutionOutcome } from './autopilotExecutionOutcome.js';

test('não chama aceite da API de confirmação final', () => {
  assert.equal(getExecutionOutcome({ id: 'd1', ok: true, status: 'executed' }).status, 'sent');
  assert.equal(getExecutionOutcome({ id: 'd1', ok: true, status: 'confirming' }).status, 'confirming');
  assert.equal(getExecutionOutcome({ id: 'd1', ok: true, status: 'confirmed' }).status, 'confirmed');
});

test('preserva falha, bloqueio e resultado ausente como estados não concluídos', () => {
  assert.equal(getExecutionOutcome({ id: 'd1', ok: false, error: 'timeout' }).status, 'failed');
  assert.equal(getExecutionOutcome({ id: 'd1', ok: true, skipped: true, reason: 'obsoleto' }).status, 'blocked');
  assert.equal(getExecutionOutcome(null).status, 'failed');
});
