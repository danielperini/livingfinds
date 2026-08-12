import { assertEquals, assertNotEquals, assertThrows } from 'jsr:@std/assert@1';
import {
  adsBaseUrlForRegion,
  resolveAmazonAdsCredentials,
  resolveAmazonSpCredentials,
  resolveAdsOAuthRedirectUri,
  shortCredentialHash,
  validAmazonAdsRefreshToken,
} from './amazonCredentials.ts';

function env(values: Record<string, string | undefined>) {
  return (name: string) => values[name];
}

Deno.test('SP usa AMAZON_* como fonte canônica antes dos aliases SP_*', () => {
  const credentials = resolveAmazonSpCredentials(env({
    AMAZON_LWA_CLIENT_ID: 'canonical-client',
    SP_CLIENT_ID: 'legacy-client',
    AMAZON_LWA_CLIENT_SECRET: 'canonical-secret',
    SP_CLIENT_SECRET: 'legacy-secret',
    AMAZON_SP_REFRESH_TOKEN: 'canonical-refresh',
    SP_REFRESH_TOKEN: 'legacy-refresh',
  }));

  assertEquals(credentials.clientId.value, 'canonical-client');
  assertEquals(credentials.clientId.source, 'AMAZON_LWA_CLIENT_ID');
  assertEquals(credentials.clientSecret.value, 'canonical-secret');
  assertEquals(credentials.refreshToken.value, 'canonical-refresh');
  assertEquals(credentials.refreshToken.source, 'AMAZON_SP_REFRESH_TOKEN');
});

Deno.test('SP mantém aliases legados somente como fallback', () => {
  const credentials = resolveAmazonSpCredentials(env({
    SP_CLIENT_ID: 'legacy-client',
    SP_CLIENT_SECRET: 'legacy-secret',
    SP_REFRESH_TOKEN: 'legacy-refresh',
  }));

  assertEquals(credentials.clientId.source, 'SP_CLIENT_ID');
  assertEquals(credentials.clientSecret.source, 'SP_CLIENT_SECRET');
  assertEquals(credentials.refreshToken.source, 'SP_REFRESH_TOKEN');
});

Deno.test('Ads usa ADS_* como fonte canônica e região NA aponta para endpoint correto', () => {
  const credentials = resolveAmazonAdsCredentials(env({
    ADS_CLIENT_ID: 'ads-client',
    ADS_CLIENT_SECRET: 'ads-secret',
    ADS_REFRESH_TOKEN: 'ads-refresh',
    ADS_PROFILE_ID: '123',
    ADS_REGION: 'NA',
  }));

  assertEquals(credentials.clientId.source, 'ADS_CLIENT_ID');
  assertEquals(credentials.refreshToken.source, 'ADS_REFRESH_TOKEN');
  assertEquals(credentials.baseUrl, 'https://advertising-api.amazon.com');
  assertEquals(adsBaseUrlForRegion('EU'), 'https://advertising-api-eu.amazon.com');
  assertEquals(adsBaseUrlForRegion('FE'), 'https://advertising-api-fe.amazon.com');
});

Deno.test('Ads nunca reaproveita o aplicativo LWA da SP-API como fallback', () => {
  const credentials = resolveAmazonAdsCredentials(env({
    AMAZON_LWA_CLIENT_ID: 'sp-client-only',
    AMAZON_LWA_CLIENT_SECRET: 'sp-secret-only',
    AMAZON_SP_REFRESH_TOKEN: 'sp-refresh-only',
  }));
  assertEquals(credentials.clientId.configured, false);
  assertEquals(credentials.clientSecret.configured, false);
  assertEquals(credentials.refreshToken.configured, false);
});

Deno.test('redirect URI depende exclusivamente de APP_BASE_URL', () => {
  assertEquals(
    resolveAdsOAuthRedirectUri(env({ APP_BASE_URL: 'https://livingfinds.example/' })),
    'https://livingfinds.example/amazon-ads-callback',
  );
  assertThrows(() => resolveAdsOAuthRedirectUri(env({})), Error, 'APP_BASE_URL_REQUIRED');
});

Deno.test('fingerprint não expõe o valor original', () => {
  const secret = 'Atzr|valor-que-nao-pode-ser-exposto';
  const hash = shortCredentialHash(secret);
  assertNotEquals(hash, secret);
  assertEquals(hash?.startsWith('fnv1a:'), true);
  assertEquals(hash?.includes('Atzr'), false);
});

Deno.test('validação de formato de refresh token Ads não aceita valores curtos', () => {
  assertEquals(validAmazonAdsRefreshToken('Atzr|curto'), false);
  assertEquals(validAmazonAdsRefreshToken(`Atzr|${'x'.repeat(60)}`), true);
});
