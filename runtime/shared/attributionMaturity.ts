export const ATTRIBUTION_MATURITY_DAYS = 14;

export type AttributionMaturity = 'provisional' | 'attribution' | 'mature';

function utcDay(value: string): number | null {
  const normalized = String(value || '').slice(0, 10);
  const timestamp = new Date(`${normalized}T12:00:00Z`).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

/**
 * Conversion metrics are attached to the traffic date and can still be revised
 * during Amazon's attribution window. Only a closed 14-day window is eligible
 * for irreversible or hourly profitability decisions.
 */
export function classifyAttributionMaturity(
  metricDate: string,
  today: string,
  maturityDays = ATTRIBUTION_MATURITY_DAYS,
): AttributionMaturity {
  const metricDay = utcDay(metricDate);
  const currentDay = utcDay(today);
  if (metricDay == null || currentDay == null || metricDay >= currentDay) return 'provisional';
  const ageDays = Math.floor((currentDay - metricDay) / 86400000);
  return ageDays >= Math.max(1, maturityDays) ? 'mature' : 'attribution';
}
