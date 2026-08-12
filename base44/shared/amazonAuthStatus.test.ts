import { assertEquals } from 'jsr:@std/assert@1';
import {
  classifyEffectiveAdsAuthStatus,
  classifyLwaFailure,
  safeOverallStatusAfterSpSuccess,
} from './amazonAuthStatus.ts';
import { ADS_TOKEN_REVOKED_REAUTH_REQUIRED } from './amazonCredentials.ts';

Deno.test('revogado nunca é efetivamente connected mesmo se campo legado disser connected', () => {
  const result = classifyEffectiveAdsAuthStatus({
    status: 'connected',
    ads_token_status: 'revoked',
    ads_requires_reauth: true,
    profile_validation_status: 'valid',
    profile_validated_at: '2026-08-08T00:00:00Z',
  });
  assertEquals(result.connected, false);
  assertEquals(result.overallStatus, 'error');
  assertEquals(result.errorCode, ADS_TOKEN_REVOKED_REAUTH_REQUIRED);
});

Deno.test('unauthorized_client força reautorização explícita', () => {
  const failure = classifyLwaFailure('unauthorized_client', 400);
  assertEquals(failure.tokenStatus, 'revoked');
  assertEquals(failure.requiresReauth, true);
  assertEquals(failure.errorCode, ADS_TOKEN_REVOKED_REAUTH_REQUIRED);
});

Deno.test('invalid_client é erro de credencial e não falso pedido de reautorização', () => {
  const failure = classifyLwaFailure('invalid_client', 400);
  assertEquals(failure.tokenStatus, 'credentials_error');
  assertEquals(failure.requiresReauth, false);
  assertEquals(failure.credentialsError, true);
});

Deno.test('connected exige token ativo e profile realmente validado', () => {
  const result = classifyEffectiveAdsAuthStatus({
    ads_token_status: 'active',
    ads_requires_reauth: false,
    profile_validation_status: 'valid',
    profile_validated_at: '2026-08-12T15:00:00Z',
  });
  assertEquals(result.connected, true);
  assertEquals(result.overallStatus, 'connected');
});

Deno.test('token ativo sem profile validado permanece pending', () => {
  const result = classifyEffectiveAdsAuthStatus({
    status: 'connected',
    ads_token_status: 'active',
    profile_validation_status: 'pending',
  });
  assertEquals(result.connected, false);
  assertEquals(result.overallStatus, 'pending');
});

Deno.test('sucesso SP não sobrescreve erro Ads revogado', () => {
  assertEquals(safeOverallStatusAfterSpSuccess({
    status: 'connected',
    ads_token_status: 'revoked',
    ads_requires_reauth: true,
  }), 'error');
});
