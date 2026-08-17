export type SalesDailyLike = Record<string, any>;

const REAL_SOURCES = new Set(['sp_api_finance_events', 'sp_api_orders_report']);

function finite(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function salesScope(row: SalesDailyLike): 'account_total' | 'product' {
  if (row?.aggregation_level === 'account_total') return 'account_total';
  if (row?.aggregation_level === 'product') return 'product';
  return String(row?.asin || '').trim() || String(row?.sku || '').trim() ? 'product' : 'account_total';
}

export function isTrustedRealSales(row: SalesDailyLike): boolean {
  return Boolean(row?.date) && REAL_SOURCES.has(String(row?.source || ''));
}

export function revenueOf(row: SalesDailyLike): number {
  if (row?.source === 'sp_api_finance_events' && row?.finance_sync_status === 'synced') {
    return Math.max(0, finite(row.gross_revenue));
  }
  return Math.max(0, finite(row?.ordered_product_sales));
}

function sourcePriority(row: SalesDailyLike): number {
  if (row?.source === 'sp_api_finance_events' && row?.finance_sync_status === 'synced') return 3;
  if (row?.source === 'sp_api_orders_report') return 2;
  return 0;
}

function newestFirst(a: SalesDailyLike, b: SalesDailyLike): number {
  return String(b?.finance_synced_at || b?.updated_date || '').localeCompare(String(a?.finance_synced_at || a?.updated_date || ''));
}

/** One canonical account total per day: account aggregate when available, otherwise product sum. */
export function canonicalAccountSalesByDate(rows: SalesDailyLike[]) {
  const grouped = new Map<string, SalesDailyLike[]>();
  for (const row of rows || []) {
    if (!isTrustedRealSales(row)) continue;
    const list = grouped.get(row.date) || [];
    list.push(row);
    grouped.set(row.date, list);
  }
  const result = new Map<string, { revenue: number; units: number; orders: number; source: string; quality: string }>();
  for (const [date, dayRows] of grouped) {
    const totals = dayRows.filter((row) => salesScope(row) === 'account_total').sort((a, b) => sourcePriority(b) - sourcePriority(a) || newestFirst(a, b));
    const selected = totals.length ? [totals[0]] : dayRows.filter((row) => salesScope(row) === 'product');
    result.set(date, {
      revenue: selected.reduce((sum, row) => sum + revenueOf(row), 0),
      units: selected.reduce((sum, row) => sum + Math.max(0, finite(row.units_ordered)), 0),
      orders: selected.reduce((sum, row) => sum + Math.max(0, finite(row.orders)), 0),
      source: totals.length ? String(totals[0].source) : 'product_rollup',
      quality: totals.length ? 'account_total' : 'product_rollup',
    });
  }
  return result;
}

/** Percentage is undefined without positive revenue; never divide by 1 or substitute 0. */
export function safeRevenuePercent(amount: unknown, revenue: unknown): number | null {
  const denominator = finite(revenue);
  const numerator = Number(amount);
  if (!(denominator > 0) || !Number.isFinite(numerator)) return null;
  return (numerator / denominator) * 100;
}

export function economicDecisionGate(input: { revenue: unknown; netMarginPct: unknown; dataComplete?: boolean }, minimumMarginPct = 15) {
  const revenue = finite(input.revenue);
  const margin = Number(input.netMarginPct);
  if (!(revenue > 0)) return { allowed: false, reason: 'NO_REVENUE', marginPct: null };
  if (input.dataComplete === false || !Number.isFinite(margin)) return { allowed: false, reason: 'INCOMPLETE_ECONOMICS', marginPct: null };
  if (margin < minimumMarginPct) return { allowed: false, reason: 'MARGIN_BELOW_FLOOR', marginPct: margin };
  return { allowed: true, reason: 'OK', marginPct: margin };
}
