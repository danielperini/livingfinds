import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveAcosFromRoas,
  deriveRoasFromAcos,
  normalizePerformanceSettings,
  resolveUnifiedBidCeiling,
  updateEfficiencyGoal,
  updateUnifiedBidCeiling,
} from './performanceSettingsNormalization.js';

test('ACoS e ROAS permanecem equivalentes', () => {
  assert.equal(deriveRoasFromAcos(15), 6.67);
  assert.equal(deriveAcosFromRoas(5), 20);
  assert.deepEqual(
    updateEfficiencyGoal({ target_acos: 10, target_roas: 10 }, 'target_roas', 4),
    { target_acos: 25, target_roas: 4 },
  );
});

test('ACoS salvo prevalece sobre ROAS legado divergente', () => {
  const normalized = normalizePerformanceSettings(
    { target_acos: 15, target_roas: 5, max_bid: 3, max_cpc: 1.1 },
    { target_acos: 10, max_bid: 5 },
  );
  assert.equal(normalized.target_acos, 15);
  assert.equal(normalized.target_roas, 6.67);
  assert.equal(normalized.max_bid, 1.1);
  assert.equal(normalized.max_cpc, 1.1);
});

test('um único teto sincroniza os campos legados e limita metas incompatíveis', () => {
  assert.equal(resolveUnifiedBidCeiling({ max_bid: 4, max_cpc: 1.25 }), 1.25);
  assert.deepEqual(
    updateUnifiedBidCeiling({ min_bid: 2, target_cpc: 1.8 }, 1.1),
    { min_bid: 1.1, target_cpc: 1.1, max_bid: 1.1, max_cpc: 1.1 },
  );
});

test('normalização mantém limites de segurança acima das respectivas metas', () => {
  const normalized = normalizePerformanceSettings({
    target_acos: 20,
    max_acos: 10,
    target_tacos: 8,
    max_tacos: 5,
    min_bid: 2,
    max_bid: 1,
    max_cpc: 1,
    target_cpc: 1.5,
  });
  assert.equal(normalized.max_acos, 20);
  assert.equal(normalized.max_tacos, 8);
  assert.equal(normalized.min_bid, 1);
  assert.equal(normalized.target_cpc, 1);
});
