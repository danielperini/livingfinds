import test from 'node:test';
import assert from 'node:assert/strict';
import { readAllDashboardPages, dashboardDecisionCounts } from '../../base44/shared/dashboardReads.js';
import { recentDecisionMessage, loadMotorDashboardStatus, refreshMotorDashboard } from './motorDashboardRead.js';
import { dailyMotorNotice } from './dailyMotorStatus.js';

test('pagination exceeds 5000 records and does not erase 1280 historical decisions when 24h is empty', async () => {
  const rows = Array.from({ length: 6280 }, (_, index) => ({ id: String(index), created_at: '2026-10-22T00:00:00Z', status: 'blocked' }));
  const offsets = [];
  const all = await readAllDashboardPages({ filter: async (query, sort, limit, offset) => {
    assert.equal(typeof query, 'object'); assert.equal(sort, 'id'); offsets.push(offset);
    return rows.slice(offset, offset + limit);
  } });
  assert.equal(all.length, 6280); assert.ok(offsets.includes(6000));
  const counts = dashboardDecisionCounts(all.slice(0, 1280), Date.parse('2026-10-24T12:00:00Z'));
  assert.equal(counts.historical_total, 1280); assert.equal(counts.recent_24h, 0);
  assert.match(recentDecisionMessage({ complete: true }, 0, 1280), /Histórico preservado: 1280/);
});

test('reproduces sort.startsWith error and corrects the query/sort argument contract', async () => {
  const legacy = { filter: async (query, sort, _limit, offset) => {
    assert.equal(typeof query, 'object');
    sort.startsWith('-');
    return offset ? [] : [{ id: 'decision-1' }];
  } };
  await assert.rejects(legacy.filter({}, { sort: '-created_at' }), /sort.startsWith is not a function/);
  assert.deepEqual(await readAllDashboardPages(legacy), [{ id: 'decision-1' }]);
  await assert.rejects(readAllDashboardPages(legacy, { filter: '-created_at' }), /filter must be an object/);
  await assert.rejects(readAllDashboardPages(legacy, { sort: { limit: 1000 } }), /sort must be a string/);
});

test('incomplete, repeated or failed pages never become no_recent_decisions', async () => {
  await assert.rejects(readAllDashboardPages({ filter: async () => [{ id: 'repeat' }] }, { pageSize: 1 }), /pagination incomplete/);
  await assert.rejects(readAllDashboardPages({ filter: async () => { throw new Error('entity offline'); } }), /entity offline/);
  assert.match(recentDecisionMessage({ complete: false }, 0, 0), /Consultando todas/);
  assert.doesNotMatch(recentDecisionMessage({ error: 'offline' }, 0, 0), /^Nenhuma decisão/);
});

test('confirmed, only sent, approved and locally blocked decisions have independent counters', () => {
  const now = Date.now();
  const created_at = new Date(now).toISOString();
  const counts = dashboardDecisionCounts([
    { id: 'confirmed', created_at, confirmation_status: 'confirmed' },
    { id: 'sent', created_at, amazon_request_id: 'req-1', status: 'executed' },
    { id: 'approved', created_at, status: 'approved' },
    { id: 'blocked', created_at, status: 'blocked', attempt_count: 3 },
    { id: 'unknown', created_at, remote_outcome: 'unknown', amazon_request_id: 'req-2', confirmation_status: 'confirmed' },
  ], now);
  assert.equal(counts.recent_24h, 5); assert.equal(counts.confirmed, 1); assert.equal(counts.sent, 3);
  assert.equal(counts.unconfirmed, 1); assert.equal(counts.sent_without_confirmation, 1);
  assert.equal(counts.remote_unknown, 1); assert.equal(counts.blocked, 2);
});

test('old exhausted cycle is historical, with replay blocked and reconciliation pending', () => {
  const notice = dailyMotorNotice({ data: { daily_motor: {
    date: '2026-10-23', status: 'exhausted', is_running: false, current_execution_known: true,
    started_at: '2026-10-23T04:25:00Z', finished_at: '2026-10-23T04:30:00Z',
    remote_outcome: 'unknown', replay: 'blocked', reconciliation: 'pending',
  } } });
  assert.equal(notice.title, 'Último ciclo diário: esgotado e bloqueado');
  assert.match(notice.message, /23\/10\/2026/); assert.match(notice.message, /Nenhum ciclo atual em execução/);
  assert.match(notice.message, /Reconciliação pendente/); assert.match(notice.message, /Replay automático bloqueado/);
});

test('Atualizar dados atuais invokes only read sources and the read-only status, never Amazon or the motor', async () => {
  const calls = [];
  const client = { functions: { invoke: async (name, args) => {
    calls.push({ name, args }); assert.equal(name, 'getMotorDashboardStatus');
    return { data: { daily_motor: { is_running: false }, read_only: true } };
  } }, entities: new Proxy({}, { get: () => { throw new Error('unexpected write'); } }) };
  await refreshMotorDashboard({ reloadSources: async () => { calls.push({ name: 'reloadReadQueries' }); },
    loadStatus: () => loadMotorDashboardStatus(client, 'account') });
  assert.deepEqual(calls.map((row) => row.name), ['reloadReadQueries', 'getMotorDashboardStatus']);
});

test('refreshes the session and retries the read-only diagnosis after 401', async () => {
  const calls = [];
  let attempts = 0;
  const client = {
    auth: { me: async () => { calls.push('me'); return { id: 'user' }; } },
    functions: { invoke: async () => {
      calls.push('invoke');
      attempts += 1;
      if (attempts === 1) { const error = new Error('Unauthorized'); error.status = 401; throw error; }
      return { data: { daily_motor: { is_running: false }, read_only: true } };
    } },
  };
  const result = await loadMotorDashboardStatus(client, 'account');
  assert.equal(result.read_only, true);
  assert.deepEqual(calls, ['invoke', 'me', 'invoke']);
});


test('uses the renewed session directly when the self-hosted app id is absent', async () => {
  const calls = [];
  const store = new Map([['base44_access_token', 'expired'], ['base44_refresh_token', 'refresh']]);
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  globalThis.window = { localStorage: {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
  } };
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    if (url === '/api/auth/refresh') return new Response(JSON.stringify({ ok: true, token: 'fresh' }), { status: 200 });
    return new Response(JSON.stringify({ daily_motor: { is_running: false }, read_only: true }), { status: 200 });
  };
  const client = { functions: { invoke: async () => { const error = new Error('Unauthorized'); error.status = 401; throw error; } } };
  try {
    const result = await loadMotorDashboardStatus(client, 'account');
    assert.equal(result.read_only, true);
    assert.equal(calls[1].url, '/api/apps/livingfinds/functions/getMotorDashboardStatus');
    assert.match(calls[1].options.headers.Authorization, /^Bearer fresh$/);
  } finally {
    globalThis.window = previousWindow;
    globalThis.fetch = previousFetch;
  }
});
