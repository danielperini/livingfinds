import test from 'node:test';
import assert from 'node:assert/strict';
import { projectProfitSeries, quantile } from './profitProjectionMath.js';

const isoDate = (offset) => {
  const date = new Date('2026-01-01T12:00:00Z');
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
};

test('quantile interpolates a sorted empirical distribution', () => {
  assert.equal(quantile([0, 10, 20, 30], 0.5), 15);
  assert.ok(Math.abs(quantile([0, 10, 20, 30], 0.1) - 3) < 1e-9);
  assert.equal(quantile([], 0.5), 0);
});

test('profit projection returns ordered P10/P50/P90 paths after 30 observations', () => {
  const points = Array.from({ length: 42 }, (_, index) => ({
    date: isoDate(index),
    profit: 100 + index * 2 + (index % 7 === 0 ? 20 : -4),
  }));
  const result = projectProfitSeries(points, 30);
  assert.equal(result.ready, true);
  assert.equal(result.points.length, 30);
  assert.ok(result.p10 <= result.p50);
  assert.ok(result.p50 <= result.p90);
  assert.ok(result.diagnostics.confidence > 0);
  result.points.forEach((point) => assert.ok(point.p10 <= point.p50 && point.p50 <= point.p90));
});

test('profit projection refuses a short empirical history', () => {
  const points = Array.from({ length: 29 }, (_, index) => ({ date: isoDate(index), profit: 100 }));
  assert.equal(projectProfitSeries(points).ready, false);
});
