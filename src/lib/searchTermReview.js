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

export function getSearchTermDataContext(rows = [], account = null) {
  const timestamps = rows
    .map((row) => row?.performance_confirmed_at || row?.synced_at || row?.last_seen_at)
    .map((value) => Date.parse(String(value || '')))
    .filter(Number.isFinite);
  const latest = timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null;

  const windows = new Set(rows.map((row) => {
    const start = row?.metrics_period_start || row?.data_window_start || row?.period_start;
    const end = row?.metrics_period_end || row?.data_window_end || row?.period_end;
    return start && end ? `${String(start).slice(0, 10)}|${String(end).slice(0, 10)}` : null;
  }).filter(Boolean));

  const marketplace = account?.marketplace_id || account?.marketplace || account?.country_code || null;
  const window = windows.size === 1
    ? [...windows][0].split('|')
    : null;

  return {
    accountId: account?.id || null,
    marketplace: marketplace ? String(marketplace) : null,
    periodStart: window?.[0] || null,
    periodEnd: window?.[1] || null,
    periodStatus: !rows.length ? 'no_data' : window ? 'known' : 'not_recorded',
    updatedAt: latest,
  };
}
