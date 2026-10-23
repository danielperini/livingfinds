import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { recentDecisionMessage } from './motorDashboardRead.js';
const require = createRequire(import.meta.url);
const bundled = await build({
  entryPoints: ['src/components/dashboard/MotorOperationalReadout.jsx'], bundle: true, write: false,
  platform: 'node', format: 'esm', jsx: 'automatic', plugins: [{ name: 'isolated-dashboard', setup(builder) {
    builder.onResolve({ filter: /^@\/api\/base44Client$/ }, () => ({ path: 'mock-client', namespace: 'test' }));
    builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export const base44={functions:{invoke(){throw new Error("No network allowed")}}};' }));
    builder.onResolve({ filter: /^react(?:\/.*)?$/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
  } }],
});
const { default: Readout } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const source = { latest_at: '2026-10-24T11:55:00Z', latest_status: 'fresh', status: 'data_stale', total_records: 3208,
  recent_records: 1237, old_records: 1763, missing_timestamp_records: 208, coverage_percent: 38.56 };
const data = { daily_motor: { status: 'exhausted', correlation_id: 'cycle-visible', last_cycle_date: '2026-10-23',
  reconciliation: 'pending', replay: 'blocked', block_reason: 'deployment_interrupted', is_running: false },
  service: { status: 'responding', database_read: true },
  scheduler: { enabled: true, started: true, healthy: false, last_error: 'syncReports: connection refused' }, states: ['scheduler_error'],
  data_freshness: { campaigns: source }, decision_counts: { stale: 1020, historical_total: 1020, recent_24h: 0, blocked: 1020 } };
test('actual dashboard renders partial coverage, historical block, correlation and technical scheduler cause', () => {
  const html = renderToStaticMarkup(createElement(Readout, { data }));
  for (const text of ['3208', '1237', '1763', '208', '38.56', '1020', 'cycle-visible', 'deployment_interrupted', 'connection refused',
    'cobertura incompleta', 'Reconciliação pendente', 'Replay automático bloqueado', 'Nenhum ciclo atual']) assert.ok(html.includes(text), text);
  assert.ok(!html.includes('cobertura recente completa'));
  assert.ok(!html.includes('Repetir'));
});
test('legacy missing correlation is shown explicitly; no synthetic correlation is invented', () => {
  const html = renderToStaticMarkup(createElement(Readout, { data: { ...data, daily_motor: { ...data.daily_motor, correlation_id: null } } }));
  assert.match(html, /correlation_id: ausente no registro legado/);
});
test('no new decisions preserves the stale/history meaning', () => {
  const text = recentDecisionMessage({ complete: true }, 0, 1020);
  assert.match(text, /Nenhuma decisão nova/); assert.match(text, /1020 decisões/);
  assert.match(text, /bloqueios/);
});
