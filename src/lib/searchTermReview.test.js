import test from 'node:test';
import assert from 'node:assert/strict';
import { getSearchTermDataContext, matchesSearchTermFilter } from './searchTermReview.js';

test('cliques e sem pedidos exige cliques positivos e zero pedidos conhecidos', () => {
  assert.equal(matchesSearchTermFilter({ clicks: 2, orders: 0 }, 'clicks_no_orders'), true);
  assert.equal(matchesSearchTermFilter({ clicks: 0, orders: 0 }, 'clicks_no_orders'), false);
  assert.equal(matchesSearchTermFilter({ clicks: 4, orders: 1 }, 'clicks_no_orders'), false);
  assert.equal(matchesSearchTermFilter({ clicks: 4 }, 'clicks_no_orders'), false);
});

test('gasto sem vendas exige gasto positivo e receita zero, sem limiar universal', () => {
  assert.equal(matchesSearchTermFilter({ spend: 0.01, sales: 0 }, 'spend_no_sales'), true);
  assert.equal(matchesSearchTermFilter({ spend: 0, sales: 0 }, 'spend_no_sales'), false);
  assert.equal(matchesSearchTermFilter({ spend: 40, sales: 1 }, 'spend_no_sales'), false);
  assert.equal(matchesSearchTermFilter({ spend: 40 }, 'spend_no_sales'), false);
});

test('contexto exibe janela apenas quando os registros têm período conhecido e compatível', () => {
  const account = { id: 'acct-1', marketplace_id: 'A2Q3Y263D00KWC' };
  const known = getSearchTermDataContext([
    { data_window_start: '2026-10-01', data_window_end: '2026-10-07', performance_confirmed_at: '2026-10-08T12:00:00Z' },
    { period_start: '2026-10-01', period_end: '2026-10-07', synced_at: '2026-10-08T13:00:00Z' },
  ], account);
  assert.equal(known.accountId, 'acct-1');
  assert.equal(known.marketplace, 'A2Q3Y263D00KWC');
  assert.equal(known.periodStatus, 'known');
  assert.equal(known.periodStart, '2026-10-01');
  assert.equal(known.updatedAt, '2026-10-08T13:00:00.000Z');

  const unknown = getSearchTermDataContext([{ clicks: 0 }], account);
  assert.equal(unknown.periodStatus, 'not_recorded');
  assert.equal(unknown.periodStart, null);
});
