import { ADS_TOKEN_REVOKED_REAUTH_REQUIRED } from './amazonCredentials.ts';

const REAUTH_CODES = new Set(['invalid_grant', 'unauthorized_client', 'access_denied', 'authorization_code_used']);

export type EffectiveAdsAuthStatus = {
  connected: boolean;
  overallStatus: 'connected' | 'pending' | 'error' | 'disconnected';
  tokenStatus: string;
  requiresReauth: boolean;
  credentialsError: boolean;
  errorCode: string | null;
};

export function isAdsReauthRequired(account: any): boolean {
  const lwaCode = String(account?.ads_last_lwa_error_code || '');
  return account?.ads_requires_reauth === true ||
    String(account?.ads_token_status || '') === 'revoked' ||
    REAUTH_CODES.has(lwaCode);
}

export function classifyEffectiveAdsAuthStatus(account: any): EffectiveAdsAuthStatus {
  const tokenStatus = String(account?.ads_token_status || 'missing');
  const credentialsError = account?.ads_credentials_error === true || tokenStatus === 'credentials_error';
  const requiresReauth = isAdsReauthRequired(account);

  if (requiresReauth) {
    return {
      connected: false,
      overallStatus: 'error',
      tokenStatus: 'revoked',
      requiresReauth: true,
      credentialsError: false,
      errorCode: ADS_TOKEN_REVOKED_REAUTH_REQUIRED,
    };
  }

  if (credentialsError) {
    return {
      connected: false,
      overallStatus: 'error',
      tokenStatus: 'credentials_error',
      requiresReauth: false,
      credentialsError: true,
      errorCode: String(account?.ads_last_lwa_error_code || 'ADS_CREDENTIALS_ERROR'),
    };
  }

  const profileValidated = account?.profile_validation_status === 'valid' && Boolean(account?.profile_validated_at);
  const tokenActive = tokenStatus === 'active';
  if (tokenActive && profileValidated) {
    return {
      connected: true,
      overallStatus: 'connected',
      tokenStatus: 'active',
      requiresReauth: false,
      credentialsError: false,
      errorCode: null,
    };
  }

  if (tokenStatus === 'missing' || tokenStatus === 'expired') {
    return {
      connected: false,
      overallStatus: 'disconnected',
      tokenStatus,
      requiresReauth: false,
      credentialsError: false,
      errorCode: null,
    };
  }

  return {
    connected: false,
    overallStatus: 'pending',
    tokenStatus,
    requiresReauth: false,
    credentialsError: false,
    errorCode: null,
  };
}

export function safeOverallStatusAfterSpSuccess(account: any): 'connected' | 'pending' | 'error' | 'disconnected' {
  const ads = classifyEffectiveAdsAuthStatus(account);
  if (ads.requiresReauth || ads.credentialsError) return 'error';
  if (ads.connected) return 'connected';
  return String(account?.status || '') === 'disconnected' ? 'disconnected' : 'pending';
}

export function classifyLwaFailure(errorCode: string | undefined, status: number | undefined) {
  const code = String(errorCode || 'unknown');
  if (code === 'invalid_client') {
    return {
      tokenStatus: 'credentials_error',
      requiresReauth: false,
      credentialsError: true,
      overallStatus: 'error' as const,
      errorCode: code,
    };
  }
  if (REAUTH_CODES.has(code)) {
    return {
      tokenStatus: 'revoked',
      requiresReauth: true,
      credentialsError: false,
      overallStatus: 'error' as const,
      errorCode: ADS_TOKEN_REVOKED_REAUTH_REQUIRED,
    };
  }
  return {
    tokenStatus: status === 429 || Number(status || 0) >= 500 ? 'error' : 'error',
    requiresReauth: false,
    credentialsError: false,
    overallStatus: 'error' as const,
    errorCode: code,
  };
}
