export const SEARCH_TERM_FILTERS = Object.freeze({
  all: { label: 'Todos os termos', definition: 'Todos os registros da conta carregados em todas as páginas.' },
  clicks_no_orders: {
    label: 'Cliques e sem pedidos',
    definition: 'Cliques atribuídos > 0 e pedidos atribuídos = 0 na janela de métricas do registro.',
  },
  spend_no_sales: {
    label: 'Gastos sem vendas',
    definition: 'Gasto atribuído > 0 e receita atribuída = 0 na janela de métricas do registro.',
  },
});

const finite = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export function matchesSearchTermFilter(row, filter = 'all') {
  if (filter === 'clicks_no_orders') {
    const clicks = finite(row?.clicks);
    const orders = finite(row?.orders);
    return clicks !== null && orders !== null && clicks > 0 && orders === 0;
  }
  if (filter === 'spend_no_sales') {
    const spend = finite(row?.spend);
    const sales = finite(row?.sales);
    return spend !== null && sales !== null && spend > 0 && sales === 0;
  }
  return true;
}

export function dedupeSearchTermRows(rows = []) {
  const byKey = new Map();
  for (const row of rows) {
    const key = String(row?.unique_key || row?.id || '');
    if (!key) continue;
    const current = byKey.get(key);
    const rowTime = Date.parse(String(row?.metrics_fresh_at || row?.synced_at || row?.updated_at || '')) || 0;
    const currentTime = Date.parse(String(current?.metrics_fresh_at || current?.synced_at || current?.updated_at || '')) || 0;
    if (!current || rowTime >= currentTime) byKey.set(key, row);
  }
  return [...byKey.values()];
}

export function getSearchTermDataContext(rows = [], account = null) {
  const timestamps = rows
    .map((row) => row?.metrics_fresh_at || row?.performance_confirmed_at || row?.synced_at || row?.last_seen_at)
    .map((value) => Date.parse(String(value || '')))
    .filter(Number.isFinite);
  const latest = timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null;

  const explicitWindows = rows.map((row) => {
    const start = row?.metrics_period_start || row?.data_window_start || row?.period_start;
    const end = row?.metrics_period_end || row?.data_window_end || row?.period_end;
    return start && end ? `${String(start).slice(0, 10)}|${String(end).slice(0, 10)}` : null;
  });
  const dates = rows.map((row) => String(row?.date || '').slice(0, 10)).filter(Boolean).sort();
  const attributionWindows = new Set(rows.map((row) => Number(row?.attribution_window_days || 0)).filter((days) => days > 0));
  const knownDates = dates.length ? [dates[0], dates[dates.length - 1]] : null;
  const windows = new Set(explicitWindows.filter(Boolean));
  const window = windows.size === 1 ? [...windows][0].split('|') : null;
  const hasUnknownWindow = explicitWindows.some((value) => !value);


  const marketplace = account?.marketplace_id || account?.marketplace || account?.country_code || null;

  return {
    accountId: account?.id || null,
    marketplace: marketplace ? String(marketplace) : null,
    periodStart: window?.[0] || knownDates?.[0] || null,
    periodEnd: window?.[1] || knownDates?.[1] || null,
    attributionWindowDays: attributionWindows.size === 1 ? [...attributionWindows][0] : null,
    currency: account?.currency_code || null,
    periodStatus: !rows.length ? 'no_data' : windows.size > 1 || (hasUnknownWindow && windows.size > 0) || attributionWindows.size > 1 ? 'mixed' : window || knownDates ? 'known' : 'not_recorded',
    updatedAt: latest,
  };
}
