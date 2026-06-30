/**
 * Utilitários de moeda para Amazon Ads Brasil
 * Formatação, normalização e validação de valores monetários
 */

/**
 * Formata valor numérico como moeda local
 * Ex: 1499.9 → "R$ 1.499,90" (BRL, pt-BR)
 */
export function formatCurrency(
  value: number | string,
  currencyCode: string = 'BRL',
  locale: string = 'pt-BR'
): string {
  const numericValue = Number(value || 0);

  if (!Number.isFinite(numericValue)) {
    return currencyCode === 'BRL' ? 'R$ 0,00' : '$0.00';
  }

  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: currencyCode,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(numericValue);
}

/**
 * Normaliza input de moeda BRL para número
 * Aceita: "R$ 1,25", "1,25", "1.000,50", 1.25
 * Retorna: 1.25 (número)
 */
export function normalizeBRLInput(value: string | number): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error('Valor monetário inválido.');
    }
    return Number(value.toFixed(2));
  }

  const normalized = String(value)
    .replace(/\s/g, '')
    .replace('R$', '')
    .replace(/\./g, '')
    .replace(',', '.');

  const parsed = Number(normalized);

  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error('Valor monetário inválido.');
  }

  return Number(parsed.toFixed(2));
}

/**
 * Valida se valor é numérico e positivo
 */
export function isValidMonetaryValue(value: any): boolean {
  const num = Number(value);
  return Number.isFinite(num) && num >= 0;
}

/**
 * Converte string formatada para número (suporta múltiplos formatos)
 */
export function parseCurrency(value: string): number {
  if (!value) return 0;

  // Já é número
  if (typeof value === 'number') return value;

  // Remover símbolos de moeda
  let cleaned = String(value)
    .replace(/[R$€£¥]/g, '')
    .trim();

  // Detectar formato
  const hasCommaDecimal = cleaned.includes(',') && !cleaned.includes('.');
  const hasPeriodDecimal = cleaned.includes('.') && !cleaned.includes(',');
  const hasBoth = cleaned.includes(',') && cleaned.includes('.');

  if (hasBoth) {
    // Formato europeu/brasileiro: 1.000,50
    cleaned = cleaned.replace(/\./g, '').replace(',', '.');
  } else if (hasCommaDecimal) {
    // Decimal com vírgula: 1,50
    cleaned = cleaned.replace(',', '.');
  }

  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Calcula métricas financeiras básicas
 */
export function calculateFinancialMetrics({
  cost,
  sales,
  totalSales,
  clicks,
  impressions,
  orders,
}: {
  cost: number;
  sales: number;
  totalSales?: number;
  clicks: number;
  impressions: number;
  orders: number;
}): {
  acos: number;
  roas: number;
  cpc: number;
  ctr: number;
  conversionRate: number;
  tacos?: number;
} {
  const acos = sales > 0 ? (cost / sales) * 100 : 0;
  const roas = cost > 0 ? sales / cost : 0;
  const cpc = clicks > 0 ? cost / clicks : 0;
  const ctr = impressions > 0 ? (clicks / impressions) * 100 : 0;
  const conversionRate = clicks > 0 ? (orders / clicks) * 100 : 0;
  const tacos = totalSales && totalSales > 0 ? (cost / totalSales) * 100 : undefined;

  return { acos, roas, cpc, ctr, conversionRate, tacos };
}

/**
 * Formata porcentagem
 */
export function formatPercentage(value: number, decimals: number = 1): string {
  if (!Number.isFinite(value)) return '0%';
  return `${value.toFixed(decimals)}%`;
}

/**
 * Formata número grande com sufixos (K, M, B)
 */
export function formatCompactNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  
  const absValue = Math.abs(value);
  
  if (absValue >= 1e9) return (value / 1e9).toFixed(1) + 'B';
  if (absValue >= 1e6) return (value / 1e6).toFixed(1) + 'M';
  if (absValue >= 1e3) return (value / 1e3).toFixed(1) + 'K';
  
  return value.toFixed(0);
}