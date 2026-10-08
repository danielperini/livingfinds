/** Ads contribution excludes advertising itself; total Amazon fees are counted once. */
const finite = (v: unknown) => v !== null && v !== undefined && v !== '' && typeof v !== 'boolean' && Number.isFinite(Number(v));
const money = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;
export function adsEconomicsStatus(rec: any, complete = false): string {
  if (rec?.costs_confirmed_by_user !== true || !finite(rec?.unit_cost) || Number(rec.unit_cost) <= 0) return 'missing_cost';
  if (!finite(rec.current_price) || Number(rec.current_price) <= 0 || !String(rec.price_source || '').startsWith('sp_api')) return 'missing_price';
  if (!rec.fees_verified_at || rec.fees_source !== 'sp_api_product_fees') return 'missing_fees';
  return complete ? 'complete' : 'partial';
}
export function calculateAdsUnitEconomics(rec: any): Record<string, number> | null {
  const price = Number(rec?.current_price);
  if (!finite(rec?.current_price) || price <= 0 || rec?.costs_confirmed_by_user !== true || !finite(rec?.unit_cost) || Number(rec.unit_cost) <= 0) return null;
  const extraKeys = ['inbound_freight_per_unit', 'tax_per_unit', 'logistics_cost_per_unit', 'packaging_cost_per_unit', 'other_variable_cost_per_unit', 'estimated_return_cost'];
  const extras = extraKeys.map(k => rec[k] == null || rec[k] === '' ? 0 : Number(rec[k]));
  if (extras.some(v => !Number.isFinite(v) || v < 0)) return null;
  if (finite(rec.amazon_fee_amount) && Number(rec.amazon_fee_amount) < 0) return null;
  let fee: number;
  if (finite(rec.amazon_fee_amount) && Number(rec.amazon_fee_amount) >= 0) {
    // SP-API totalFee includes referral, FBA and fixed fees; do not add the components again.
    fee = Number(rec.amazon_fee_amount);
  } else {
    if (![rec.amazon_fee_percent, rec.fba_fee, rec.amazon_fixed_fee].every(finite)) return null;
    if ([rec.amazon_fee_percent, rec.fba_fee, rec.amazon_fixed_fee].some(v => Number(v) < 0)) return null;
    fee = price * Number(rec.amazon_fee_percent) / 100 + Number(rec.fba_fee) + Number(rec.amazon_fixed_fee);
  }
  const taxPct = rec.simple_national_tax_pct == null ? 0 : Number(rec.simple_national_tax_pct);
  if (!Number.isFinite(taxPct) || taxPct < 0 || taxPct > 100) return null;
  const costs = Number(rec.unit_cost) + extras.reduce((a,b) => a+b,0) + fee + price * taxPct / 100;
  const contribution = price - costs;
  const margin = contribution / price * 100;
  return {total_variable_cost_per_unit: money(costs), contribution_margin_amount: money(contribution), contribution_margin_percent: money(margin), break_even_acos: money(margin)};
}
