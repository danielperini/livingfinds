/**
 * Utilitários centralizados para formatação e validação de moeda
 * Foco: BRL para Amazon Brasil, sem conversão cambial
 */

import { getMarketplaceConfig, AMAZON_MARKETPLACE_CONFIG } from './marketplaceConfig';

/**
 * Formata valor monetário usando Intl.NumberFormat
 * Para Brasil: R$ 1.499,90
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
 * Formata valor monetário brasileiro (atalho)
 * R$ 1.499,90
 */
export function formatBRL(value: number | string): string {
  return formatCurrency(value, 'BRL', 'pt-BR');
}

/**
 * Normaliza input monetário para número (sem símbolo, sem formatação)
 * Entrada: "R$ 1.259,90" ou "1,259.90" ou 1259.90
 * Saída: 1259.90 (número)
 */
export function normalizeCurrencyInput(value: string | number): number {
  if (typeof value === 'number') {
    return Number(value.toFixed(2));
  }

  const normalized = String(value)
    .trim()
    .replace(/\s/g, '')
    .replace('R$', '')
    .replace('$', '')
    .replace('€', '')
    .replace('£', '')
    .replace(',', '.');

  const parsed = Number(normalized);

  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Valor monetário inválido: ${value}`);
  }

  return Number(parsed.toFixed(2));
}

/**
 * Normaliza input brasileiro (atalho)
 */
export function normalizeBRLInput(value: string | number): number {
  return normalizeCurrencyInput(value);
}

/**
 * Valida contexto da conta Amazon antes de operações
 * Lança erro se houver incompatibilidade de moeda/marketplace
 */
export function validateAmazonAccountContext(params: {
  profileId?: string;
  marketplaceId?: string;
  countryCode?: string;
  currencyCode?: string;
}): {
  valid: boolean;
  profileId: string;
  marketplaceId: string;
  countryCode: string;
  currencyCode: string;
  currencySymbol: string;
  locale: string;
} {
  const { profileId, marketplaceId, countryCode, currencyCode } = params;

  // ProfileId é obrigatório
  if (!profileId) {
    throw new Error('profileId não informado. Perfil Amazon Ads é obrigatório.');
  }

  // Resolver configuração do marketplace
  const config = getMarketplaceConfig({ marketplaceId, countryCode });

  if (!config) {
    throw new Error(
      `Marketplace não configurado. marketplaceId: ${marketplaceId || 'N/A'}, countryCode: ${countryCode || 'N/A'}`
    );
  }

  // Validação crítica: Brasil deve usar BRL
  if (config.countryCode === 'BR' && currencyCode && currencyCode !== 'BRL') {
    throw new Error(
      `Moeda inválida para Amazon Brasil: ${currencyCode}. Esperado: BRL. ` +
      'Operação bloqueada para segurança financeira.'
    );
  }

  // Validação de marketplaceId
  if (marketplaceId && marketplaceId !== config.marketplaceId) {
    throw new Error(
      `marketplaceId incompatível: ${marketplaceId}. Esperado: ${config.marketplaceId}`
    );
  }

  return {
    valid: true,
    profileId,
    marketplaceId: config.marketplaceId,
    countryCode: config.countryCode,
    currencyCode: config.currencyCode,
    currencySymbol: config.currencySymbol,
    locale: config.locale,
  };
}

/**
 * Cache de perfil em memória (válido por 24h)
 * Estrutura: { profileId, marketplaceId, countryCode, currencyCode, validatedAt, validationStatus }
 */
interface ProfileCache {
  profileId: string;
  marketplaceId: string;
  countryCode: string;
  currencyCode: string;
  validatedAt: number;
  validationStatus: 'VALID' | 'INVALID' | 'ERROR';
  error?: string;
}

const profileCache: Map<string, ProfileCache> = new Map();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 horas

/**
 * Obtém perfil do cache (se válido)
 */
export function getCachedProfile(profileId: string): ProfileCache | null {
  const cached = profileCache.get(profileId);
  
  if (!cached) {
    return null;
  }

  const isExpired = Date.now() - cached.validatedAt > CACHE_TTL_MS;
  
  if (isExpired) {
    profileCache.delete(profileId);
    return null;
  }

  return cached;
}

/**
 * Salva perfil no cache
 */
export function cacheProfile(cache: ProfileCache): void {
  profileCache.set(cache.profileId, cache);
}

/**
 * Limpa cache de um perfil (útil após erro ou troca de conta)
 */
export function clearProfileCache(profileId: string): void {
  profileCache.delete(profileId);
}

/**
 * Limpa todo o cache (útil em auditoria)
 */
export function clearAllProfileCache(): void {
  profileCache.clear();
}

/**
 * Validação rápida usando cache
 * Retorna true se perfil já foi validado e cache está válido
 */
export function isProfileCachedValid(profileId: string): boolean {
  const cached = getCachedProfile(profileId);
  return cached?.validationStatus === 'VALID';
}

/**
 * Retorna símbolo da moeda para exibição
 */
export function getCurrencySymbol(currencyCode: string): string {
  const symbols: Record<string, string> = {
    BRL: 'R$',
    USD: '$',
    EUR: '€',
    GBP: '£',
    JPY: '¥',
    CAD: '$',
    AUD: '$',
    MXN: '$',
  };
  
  return symbols[currencyCode] || currencyCode;
}

/**
 * Verifica se valor é monetário (número finito positivo)
 */
export function isMonetaryValue(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Garante que valor monetário está no formato correto (2 casas decimais)
 */
export function ensureMonetaryPrecision(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Number(value.toFixed(2));
}

/**
 * Calcula métricas financeiras sem IA
 */
export function calculateFinancialMetrics(params: {
  spend: number;
  sales: number;
  clicks?: number;
  impressions?: number;
  orders?: number;
  margin?: number;
}): {
  acos: number;
  roas: number;
  cpc: number;
  ctr: number;
  conversionRate: number;
  tacos?: number;
  profit?: number;
  breakEvenAcos?: number;
} {
  const { spend, sales, clicks, impressions, orders, margin } = params;

  const safeDivide = (a: number, b: number): number => {
    if (!b || b === 0) return 0;
    return a / b;
  };

  const acos = safeDivide(spend, sales) * 100;
  const roas = safeDivide(sales, spend);
  const cpc = safeDivide(spend, clicks || 0);
  const ctr = safeDivide(clicks || 0, impressions || 0) * 100;
  const conversionRate = safeDivide(orders || 0, clicks || 0) * 100;

  const result: any = {
    acos: Number(acos.toFixed(2)),
    roas: Number(roas.toFixed(2)),
    cpc: Number(cpc.toFixed(2)),
    ctr: Number(ctr.toFixed(2)),
    conversionRate: Number(conversionRate.toFixed(2)),
  };

  if (margin) {
    result.breakEvenAcos = Number((margin * 100).toFixed(2));
    result.profit = Number((sales * (margin / 100) - spend).toFixed(2));
  }

  return result;
}

/**
 * Formata porcentagem (para ACoS, ROAS, CTR, etc.)
 */
export function formatPercentage(value: number, decimals: number = 1): string {
  if (!Number.isFinite(value)) {
    return '0%';
  }
  return `${value.toFixed(decimals)}%`;
}

/**
 * Formata número grande com K, M, B
 */
export function formatCompactNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return '0';
  }
  
  const absValue = Math.abs(value);
  
  if (absValue >= 1e9) {
    return (value / 1e9).toFixed(1) + 'B';
  }
  if (absValue >= 1e6) {
    return (value / 1e6).toFixed(1) + 'M';
  }
  if (absValue >= 1e3) {
    return (value / 1e3).toFixed(1) + 'K';
  }
  
  return value.toFixed(0);
}