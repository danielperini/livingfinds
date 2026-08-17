import { strict as assert } from 'node:assert';
import {
  classifyNoImpressionCalibration,
  shouldMaintainActiveNoImpressionAlert,
} from './noImpressionCalibrationPolicy.ts';

const base = {
  keywordEnabled: true,
  campaignKnown: true,
  campaignState: 'enabled',
  campaignOperational: true,
  productEligibility: 'eligible' as const,
  structureReady: true,
  economicsReady: true,
  keywordMetricDays: 2,
  keywordImpressions: 0,
  recentBidChange: false,
  currentBid: 0.5,
  maxBid: 1,
};

Deno.test('ausencia de linha de metrica nunca vira zero de impressoes', () => {
  assert.equal(classifyNoImpressionCalibration({
    ...base, keywordMetricDays: 0, keywordImpressions: null,
  }).action, 'STALE_NO_DATA');
});

Deno.test('um unico dia nao confirma uma janela de 48 horas', () => {
  assert.equal(classifyNoImpressionCalibration({
    ...base, keywordMetricDays: 1,
  }).action, 'STALE_NO_DATA');
});

Deno.test('campanha incompleta e economia pendente bloqueiam aumento', () => {
  assert.equal(classifyNoImpressionCalibration({
    ...base, structureReady: false,
  }).action, 'STALE_GUARDRAIL');
  assert.equal(classifyNoImpressionCalibration({
    ...base, economicsReady: false,
  }).action, 'STALE_GUARDRAIL');
});

Deno.test('campanha ausente no snapshot deixa alerta obsoleto sem presumir inatividade', () => {
  assert.equal(classifyNoImpressionCalibration({
    ...base, campaignKnown: false, campaignState: '', campaignOperational: false,
  }).action, 'STALE_GUARDRAIL');
});

Deno.test('produto sem estoque encerra alerta sem aumentar lance', () => {
  assert.equal(classifyNoImpressionCalibration({
    ...base, productEligibility: 'ineligible',
  }).action, 'RESOLVE_INELIGIBLE');
});

Deno.test('impressao observada encerra alerta sem reduzir lance', () => {
  assert.equal(classifyNoImpressionCalibration({
    ...base, keywordImpressions: 3,
  }).action, 'RESOLVE_IMPRESSIONS');
});

Deno.test('zero confirmado permite aumento somente fora do cooldown', () => {
  assert.equal(classifyNoImpressionCalibration(base).action, 'BOOST_CONFIRMED_ZERO');
  assert.equal(classifyNoImpressionCalibration({
    ...base, recentBidChange: true,
  }).action, 'HOLD_CONFIRMED_ZERO');
});

Deno.test('teto de lance preserva alerta mas impede novo aumento', () => {
  assert.equal(classifyNoImpressionCalibration({
    ...base, currentBid: 1,
  }).action, 'HOLD_CONFIRMED_ZERO');
});

Deno.test('somente zero confirmado pode criar ou manter alerta ativo', () => {
  assert.equal(shouldMaintainActiveNoImpressionAlert('BOOST_CONFIRMED_ZERO'), true);
  assert.equal(shouldMaintainActiveNoImpressionAlert('HOLD_CONFIRMED_ZERO'), true);
  assert.equal(shouldMaintainActiveNoImpressionAlert('STALE_GUARDRAIL'), false);
  assert.equal(shouldMaintainActiveNoImpressionAlert('STALE_NO_DATA'), false);
  assert.equal(shouldMaintainActiveNoImpressionAlert('RESOLVE_INELIGIBLE'), false);
  assert.equal(shouldMaintainActiveNoImpressionAlert('RESOLVE_IMPRESSIONS'), false);
});
