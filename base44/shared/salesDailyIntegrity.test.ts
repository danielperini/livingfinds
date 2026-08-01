import { assertEquals } from 'jsr:@std/assert';
import { canonicalAccountSalesByDate, economicDecisionGate, safeRevenuePercent } from './salesDailyIntegrity.ts';

Deno.test('never invents a margin percentage when revenue is zero', () => {
  assertEquals(safeRevenuePercent(-43.64, 0), null);
  assertEquals(economicDecisionGate({ revenue: 0, netMarginPct: -4364 }), { allowed: false, reason: 'NO_REVENUE', marginPct: null });
});

Deno.test('blocks growth below the hard 15 percent floor', () => {
  assertEquals(economicDecisionGate({ revenue: 35.9, netMarginPct: 5.6 }), { allowed: false, reason: 'MARGIN_BELOW_FLOOR', marginPct: 5.6 });
  assertEquals(economicDecisionGate({ revenue: 79.9, netMarginPct: 12.33 }), { allowed: false, reason: 'MARGIN_BELOW_FLOOR', marginPct: 12.33 });
});

Deno.test('does not double count account total and product rows', () => {
  const result = canonicalAccountSalesByDate([
    { date: '2026-07-31', source: 'sp_api_orders_report', aggregation_level: 'product', asin: 'A', ordered_product_sales: 100, units_ordered: 2, orders: 1 },
    { date: '2026-07-31', source: 'sp_api_orders_report', aggregation_level: 'product', asin: 'B', ordered_product_sales: 50, units_ordered: 1, orders: 1 },
    { date: '2026-07-31', source: 'sp_api_orders_report', aggregation_level: 'account_total', ordered_product_sales: 150, units_ordered: 3, orders: 2 },
  ]).get('2026-07-31');
  assertEquals(result, { revenue: 150, units: 3, orders: 2, source: 'sp_api_orders_report', quality: 'account_total' });
});

Deno.test('rejects ads attribution as real SP API revenue', () => {
  assertEquals(canonicalAccountSalesByDate([{ date: '2026-07-31', source: 'ads_report', ordered_product_sales: 999 }]).size, 0);
});
