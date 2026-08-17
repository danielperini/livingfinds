export type InventoryCoverageStatus =
  | 'out_of_stock'
  | 'insufficient_history'
  | 'no_velocity'
  | 'critical'
  | 'low'
  | 'healthy';

export type InventoryCoverageInput = {
  fbaInventory?: number | null;
  availableQuantity?: number | null;
  reservedInventory?: number | null;
  inboundInventory?: number | null;
  unitsSold?: number | null;
  observedDays?: number | null;
  criticalDays?: number;
  lowDays?: number;
  minimumHistoryDays?: number;
};

const finiteNonNegative = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

const rounded = (value: number | null, decimals = 2): number | null => {
  if (value === null || !Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

/**
 * TACoS canônico. Retorna percentual e nunca substitui faturamento real ausente
 * por vendas atribuídas de Ads.
 */
export function calculateRealTacos(spend: unknown, realSales: unknown): number | null {
  const spendValue = finiteNonNegative(spend);
  const salesValue = finiteNonNegative(realSales);
  if (salesValue <= 0) return null;
  return rounded((spendValue / salesValue) * 100, 2);
}

export function calculateObservedWindowDays(dates: Array<string | null | undefined>, maxDays = 30): number {
  const ordered = [...new Set(dates.filter((value): value is string => Boolean(value)))].sort();
  if (ordered.length <= 1) return ordered.length;
  const first = new Date(ordered[0]).getTime();
  const last = new Date(ordered[ordered.length - 1]).getTime();
  if (!Number.isFinite(first) || !Number.isFinite(last)) return 0;
  return Math.min(maxDays, Math.max(1, Math.round((last - first) / 86400000) + 1));
}

/**
 * Cobertura de estoque baseada em unidades reais da SP-API.
 *
 * - fba_inventory e available_quantity representam duas leituras do estoque
 *   vendável; usamos o maior valor para não provocar pausa por divergência stale.
 * - reserved_inventory é diagnóstico, não estoque vendável.
 * - inbound_inventory aparece como cobertura projetada, mas não evita proteção
 *   sobre o estoque disponível agora porque não há ETA confiável.
 * - histórico menor que 7 dias não autoriza redução automática por Days of Supply.
 */
export function calculateInventoryCoverage(input: InventoryCoverageInput) {
  const criticalDays = Math.max(1, finiteNonNegative(input.criticalDays) || 7);
  const lowDays = Math.max(criticalDays, finiteNonNegative(input.lowDays) || 21);
  const minimumHistoryDays = Math.max(1, finiteNonNegative(input.minimumHistoryDays) || 7);

  const fbaInventory = finiteNonNegative(input.fbaInventory);
  const availableQuantity = finiteNonNegative(input.availableQuantity);
  const availableNow = Math.max(fbaInventory, availableQuantity);
  const reserved = finiteNonNegative(input.reservedInventory);
  const inbound = finiteNonNegative(input.inboundInventory);
  const unitsSold = finiteNonNegative(input.unitsSold);
  const observedDays = Math.min(30, finiteNonNegative(input.observedDays));
  const dailyVelocity = unitsSold > 0 && observedDays > 0 ? unitsSold / observedDays : 0;

  const coverageNow = dailyVelocity > 0
    ? availableNow / dailyVelocity
    : availableNow === 0 ? 0 : null;
  const coverageWithInbound = dailyVelocity > 0
    ? (availableNow + inbound) / dailyVelocity
    : availableNow + inbound === 0 ? 0 : null;

  let status: InventoryCoverageStatus;
  if (availableNow <= 0) status = 'out_of_stock';
  else if (observedDays < minimumHistoryDays) status = 'insufficient_history';
  else if (dailyVelocity <= 0) status = 'no_velocity';
  else if ((coverageNow ?? 0) < criticalDays) status = 'critical';
  else if ((coverageNow ?? 0) < lowDays) status = 'low';
  else status = 'healthy';

  return {
    available_now: rounded(availableNow, 0) ?? 0,
    reserved_inventory: rounded(reserved, 0) ?? 0,
    inbound_inventory: rounded(inbound, 0) ?? 0,
    units_sold: rounded(unitsSold, 2) ?? 0,
    observed_days: rounded(observedDays, 0) ?? 0,
    daily_sales_velocity: rounded(dailyVelocity, 4) ?? 0,
    days_of_supply: rounded(coverageNow, 2),
    days_of_supply_with_inbound: rounded(coverageWithInbound, 2),
    status,
    actionable: status === 'out_of_stock' || status === 'critical' || status === 'low',
    data_quality: observedDays >= minimumHistoryDays ? 'sufficient' : 'insufficient_history',
  };
}
