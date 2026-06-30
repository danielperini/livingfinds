/**
 * Configuração central de marketplaces Amazon
 * Mantém marketplaceId, currencyCode, countryCode e locale de forma centralizada
 */

export interface MarketplaceConfig {
  marketplaceId: string;
  countryCode: string;
  currencyCode: string;
  currencySymbol: string;
  locale: string;
}

export const AMAZON_MARKETPLACE_CONFIG: Record<string, MarketplaceConfig> = {
  BR: {
    marketplaceId: 'A2Q3Y263D00KWC',
    countryCode: 'BR',
    currencyCode: 'BRL',
    currencySymbol: 'R$',
    locale: 'pt-BR',
  },
  US: {
    marketplaceId: 'ATVPDKIKX0DER',
    countryCode: 'US',
    currencyCode: 'USD',
    currencySymbol: '$',
    locale: 'en-US',
  },
  UK: {
    marketplaceId: 'A1F83G8C2ARO7P',
    countryCode: 'UK',
    currencyCode: 'GBP',
    currencySymbol: '£',
    locale: 'en-GB',
  },
  DE: {
    marketplaceId: 'A1PA6795UKMFR9',
    countryCode: 'DE',
    currencyCode: 'EUR',
    currencySymbol: '€',
    locale: 'de-DE',
  },
  FR: {
    marketplaceId: 'A13V1IB3VIYZZH',
    countryCode: 'FR',
    currencyCode: 'EUR',
    currencySymbol: '€',
    locale: 'fr-FR',
  },
  IT: {
    marketplaceId: 'APJ6JRA9NG5V4',
    countryCode: 'IT',
    currencyCode: 'EUR',
    currencySymbol: '€',
    locale: 'it-IT',
  },
  ES: {
    marketplaceId: 'A1RKKUPIHCS9HS',
    countryCode: 'ES',
    currencyCode: 'EUR',
    currencySymbol: '€',
    locale: 'es-ES',
  },
  CA: {
    marketplaceId: 'A2EUQ1WTGCTBG2',
    countryCode: 'CA',
    currencyCode: 'CAD',
    currencySymbol: '$',
    locale: 'en-CA',
  },
  MX: {
    marketplaceId: 'A1AM78C64UM0Y8',
    countryCode: 'MX',
    currencyCode: 'MXN',
    currencySymbol: '$',
    locale: 'es-MX',
  },
  JP: {
    marketplaceId: 'A1VC38T7YXB528',
    countryCode: 'JP',
    currencyCode: 'JPY',
    currencySymbol: '¥',
    locale: 'ja-JP',
  },
  AU: {
    marketplaceId: 'A39IBJ37TRP1C6',
    countryCode: 'AU',
    currencyCode: 'AUD',
    currencySymbol: '$',
    locale: 'en-AU',
  },
  IN: {
    marketplaceId: 'A21TJRUUN4KGV',
    countryCode: 'IN',
    currencyCode: 'INR',
    currencySymbol: '₹',
    locale: 'en-IN',
  },
};

/**
 * Resolve configuração do marketplace por marketplaceId ou countryCode
 */
export function getMarketplaceConfig({
  marketplaceId,
  countryCode,
}: {
  marketplaceId?: string;
  countryCode?: string;
}): MarketplaceConfig | null {
  if (!marketplaceId && !countryCode) {
    return null;
  }

  const config = Object.values(AMAZON_MARKETPLACE_CONFIG).find(
    (item) =>
      item.marketplaceId === marketplaceId ||
      item.countryCode === countryCode
  );

  return config || null;
}

/**
 * Valida contexto da conta Amazon antes de operações críticas
 * Lança erro se houver incompatibilidade de moeda ou marketplace
 */
export function validateAmazonAccountContext({
  profileId,
  marketplaceId,
  countryCode,
  currencyCode,
}: {
  profileId: string;
  marketplaceId?: string;
  countryCode?: string;
  currencyCode?: string;
}): {
  valid: true;
  profileId: string;
  marketplaceId: string;
  countryCode: string;
  currencyCode: string;
  currencySymbol: string;
  locale: string;
} {
  if (!profileId) {
    throw new Error('profileId não informado.');
  }

  const config = getMarketplaceConfig({ marketplaceId, countryCode });

  if (!config) {
    throw new Error(
      `Marketplace não configurado. marketplaceId: ${marketplaceId || 'N/A'}, countryCode: ${countryCode || 'N/A'}`
    );
  }

  if (config.countryCode === 'BR' && currencyCode && currencyCode !== 'BRL') {
    throw new Error(
      `Moeda inválida para Amazon Brasil: ${currencyCode}. Esperado: BRL.`
    );
  }

  if (marketplaceId && marketplaceId !== config.marketplaceId) {
    throw new Error('marketplaceId incompatível com o perfil.');
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