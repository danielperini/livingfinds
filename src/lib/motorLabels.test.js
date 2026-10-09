import test from 'node:test';
import assert from 'node:assert/strict';
import { getAmazonConfirmationStatus } from './motorLabels.js';

const label = item => getAmazonConfirmationStatus(item).label;

test('verified legacy bid logs display Amazon confirmation for every target', () => {
  for (const asin of ['B0F45JG27L', 'B0HLMF8PPD', 'B0GHP68123', 'B0GR6GXS1B']) {
    assert.equal(label({ asin, status: 'confirmed', amazon_confirmed: true, new_bid: 0.57 }), 'Confirmado na Amazon');
  }
});

test('an explicit reconciliation result overrides legacy confirmation', () => {
  const legacy = { status: 'confirmed', amazon_confirmed: true };
  assert.equal(label({ ...legacy, amazon_confirmation_status: 'divergent' }), 'Divergente na Amazon');
  assert.equal(label({ ...legacy, confirmation_status: 'pending', executed_at: '2026-10-09' }), 'Aguardando confirmação');
});

test('local status, truthy strings and timestamps alone do not prove confirmation', () => {
  for (const row of [{ status: 'confirmed' }, { amazon_confirmed: true }, { status: 'confirmed', amazon_confirmed: 'true' }, { last_attempt_at: '2026-10-09' }]) {
    assert.equal(label(row), 'Não enviado à Amazon');
  }
  assert.equal(label({ status: 'completed' }), 'Concluído localmente');
  assert.equal(label({ status: 'executed', executed_at: '2026-10-09' }), 'Aguardando confirmação');
  assert.equal(label({ amazon_confirmation_status: 'confirmed' }), 'Confirmado na Amazon');
});
