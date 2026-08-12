export type EnvReader = (name: string) => string | undefined;

export type ResolvedCredential = {
  value: string;
  source: string | null;
  fingerprint: string | null;
  configured: boolean;
};

export type AmazonAdsCredentials = {
  clientId: ResolvedCredential;
  clientSecret: ResolvedCredential;
  refreshToken: ResolvedCredential;
  profileId: ResolvedCredential;
  accountId: ResolvedCredential;
  region: string;
  regionSource: string;
  baseUrl: string;
};

export type AmazonSpCredentials = {
  clientId: ResolvedCredential;
  clientSecret: ResolvedCredential;
  refreshToken: ResolvedCredential;
  marketplaceId: ResolvedCredential;
  sellerId: ResolvedCredential;
  appId: ResolvedCredential;
};

export const ADS_OAUTH_SCOPE = 'advertising::campaign_management';
export const ADS_TOKEN_REVOKED_REAUTH_REQUIRED = 'ADS_TOKEN_REVOKED_REAUTH_REQUIRED';

const denoEnv: EnvReader = (name) => Deno.env.get(name);

function normalize(value: string | undefined): string {
  return String(value || '').trim();
}

export function shortCredentialHash(value: string | undefined): string | null {
  const normalized = normalize(value);
  if (!normalized) return null;
  // FNV-1a 32-bit: fingerprint diagnóstico, não mecanismo criptográfico.
  let hash = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i += 1) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a:${hash.toString(16).padStart(8, '0')}`;
}

function resolveOne(env: EnvReader, names: string[]): ResolvedCredential {
  for (const name of names) {
    const value = normalize(env(name));
    if (value) {
      return {
        value,
        source: name,
        fingerprint: shortCredentialHash(value),
        configured: true,
      };
    }
  }
  return { value: '', source: null, fingerprint: null, configured: false };
}

export function adsBaseUrlForRegion(region: string | undefined): string {
  const normalized = normalize(region || 'NA').toUpperCase();
  if (normalized.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (normalized.includes('FE') || normalized.includes('ASIA') || normalized.includes('JAPAN')) {
    return 'https://advertising-api-fe.amazon.com';
  }
  return 'https://advertising-api.amazon.com';
}

export function resolveAmazonAdsCredentials(env: EnvReader = denoEnv): AmazonAdsCredentials {
  const clientId = resolveOne(env, ['ADS_CLIENT_ID', 'AMAZON_LWA_CLIENT_ID']);
  const clientSecret = resolveOne(env, ['ADS_CLIENT_SECRET', 'AMAZON_LWA_CLIENT_SECRET']);
  const refreshToken = resolveOne(env, ['ADS_REFRESH_TOKEN']);
  const profileId = resolveOne(env, ['ADS_PROFILE_ID']);
  const accountId = resolveOne(env, ['ADS_ACCOUNT_ID']);
  const regionValue = resolveOne(env, ['ADS_REGION']);
  const region = regionValue.value || 'NA';

  return {
    clientId,
    clientSecret,
    refreshToken,
    profileId,
    accountId,
    region,
    regionSource: regionValue.source || 'DEFAULT_NA',
    baseUrl: adsBaseUrlForRegion(region),
  };
}

export function resolveAmazonSpCredentials(env: EnvReader = denoEnv): AmazonSpCredentials {
  return {
    // AMAZON_* é a fonte canônica. SP_* existe apenas como alias legado.
    clientId: resolveOne(env, ['AMAZON_LWA_CLIENT_ID', 'SP_CLIENT_ID']),
    clientSecret: resolveOne(env, ['AMAZON_LWA_CLIENT_SECRET', 'SP_CLIENT_SECRET']),
    refreshToken: resolveOne(env, ['AMAZON_SP_REFRESH_TOKEN', 'SP_REFRESH_TOKEN']),
    marketplaceId: resolveOne(env, ['AMAZON_MARKETPLACE_ID']),
    sellerId: resolveOne(env, ['AMAZON_SELLER_ID']),
    appId: resolveOne(env, ['AMAZON_SP_APP_ID']),
  };
}

export function resolveAdsOAuthRedirectUri(env: EnvReader = denoEnv): string {
  const appBaseUrl = normalize(env('APP_BASE_URL')).replace(/\/+$/, '');
  if (!appBaseUrl) {
    throw new Error('APP_BASE_URL_REQUIRED: configure APP_BASE_URL para gerar a redirect_uri Amazon Ads');
  }
  return `${appBaseUrl}/amazon-ads-callback`;
}

export function credentialDiagnostic(credential: ResolvedCredential) {
  return {
    configured: credential.configured,
    source: credential.source,
    fingerprint: credential.fingerprint,
  };
}

export function logCredentialSelection(label: string, credential: ResolvedCredential) {
  const diag = credentialDiagnostic(credential);
  console.info(`[AmazonCredentials] ${label}: source=${diag.source || 'missing'} hash=${diag.fingerprint || 'none'} configured=${diag.configured}`);
}

export function validAmazonAdsRefreshToken(value: unknown): boolean {
  const token = normalize(String(value || ''));
  return token.startsWith('Atzr|') && token.length >= 50;
}
