/**
 * testAuthHealth — verificação ao vivo de autenticação Amazon Ads e SP-API.
 *
 * Regras:
 * - Ads: refresh token do banco é a fonte primária; env só quando DB não possui token.
 * - SP: AMAZON_LWA_* / AMAZON_SP_REFRESH_TOKEN são canônicos; SP_* são aliases legados.
 * - Ads só é considerado saudável após GET /v2/profiles confirmar o profile esperado.
 * - Nenhum token/secret é retornado ou logado.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import {
  adsBaseUrlForRegion,
  credentialDiagnostic,
  resolveAmazonAdsCredentials,
  resolveAmazonSpCredentials,
} from '../../shared/amazonCredentials.ts';
import { classifyLwaFailure } from '../../shared/amazonAuthStatus.ts';

type TokenResult = {
  ok: boolean;
  accessToken?: string;
  expiresIn?: number;
  error?: string;
  errorCode?: string;
  httpStatus?: number;
};

async function fetchToken(clientId: string, clientSecret: string, refreshToken: string): Promise<TokenResult> {
  if (!clientId || !clientSecret || !refreshToken) {
    return { ok: false, error: 'Credenciais incompletas', errorCode: 'not_configured' };
  }
  try {
    const res = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const code = String(data?.error || `http_${res.status}`);
      let hint = String(data?.error_description || data?.message || 'Token fetch failed');
      if (code === 'unauthorized_client') hint = 'Refresh token revogado — reautorize em /amazon-oauth-setup';
      if (code === 'invalid_client') hint = 'Client ID ou Client Secret incorretos — verifique a fonte canônica de credenciais';
      if (code === 'invalid_grant') hint = 'Refresh token expirado ou inválido — reautorize a conta';
      return { ok: false, error: hint, errorCode: code, httpStatus: res.status };
    }
    if (!data?.access_token) {
      return { ok: false, error: 'Amazon LWA não retornou access_token', errorCode: 'missing_access_token', httpStatus: res.status };
    }
    return { ok: true, accessToken: String(data.access_token), expiresIn: Number(data.expires_in || 0), httpStatus: res.status };
  } catch (error: any) {
    return { ok: false, error: error?.message || String(error), errorCode: 'network_error' };
  }
}

async function validateAdsProfile(accessToken: string, clientId: string, region: string, expectedProfileId: string) {
  if (!expectedProfileId) {
    return { ok: false, errorCode: 'ADS_PROFILE_ID_MISSING', message: 'ads_profile_id não configurado', httpStatus: 0, profilesCount: 0 };
  }
  try {
    const response = await fetch(`${adsBaseUrlForRegion(region)}/v2/profiles`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Amazon-Advertising-API-ClientId': clientId,
      },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        ok: false,
        errorCode: String(payload?.code || payload?.error || `http_${response.status}`),
        message: String(payload?.details || payload?.message || payload?.error_description || `Amazon Ads HTTP ${response.status}`).slice(0, 500),
        httpStatus: response.status,
        profilesCount: 0,
      };
    }
    const profiles = Array.isArray(payload) ? payload : [];
    const found = profiles.some((profile: any) => String(profile?.profileId || '') === String(expectedProfileId));
    return {
      ok: found,
      errorCode: found ? undefined : 'ADS_EXPECTED_PROFILE_NOT_FOUND',
      message: found ? undefined : `Profile esperado ${expectedProfileId} não foi encontrado na autorização atual`,
      httpStatus: response.status,
      profilesCount: profiles.length,
    };
  } catch (error: any) {
    return { ok: false, errorCode: 'ADS_PROFILE_VALIDATION_NETWORK_ERROR', message: error?.message || String(error), httpStatus: 0, profilesCount: 0 };
  }
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const mode = Deno.env.get('OPERATION_MODE') || 'real';
    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ user_id: user.id }, '-updated_date', 1).catch(() => [] as any[]);
    const account = accounts[0] || null;
    const adsCredentials = resolveAmazonAdsCredentials();
    const spCredentials = resolveAmazonSpCredentials();

    const dbAdsRefreshToken = String(account?.ads_refresh_token || '').trim();
    const adsRefreshToken = dbAdsRefreshToken || adsCredentials.refreshToken.value;
    const adsTokenSource = dbAdsRefreshToken ? 'database' : (adsCredentials.refreshToken.source || 'missing');

    const [adsTokenSettled, spTokenSettled] = await Promise.allSettled([
      fetchToken(adsCredentials.clientId.value, adsCredentials.clientSecret.value, adsRefreshToken),
      fetchToken(spCredentials.clientId.value, spCredentials.clientSecret.value, spCredentials.refreshToken.value),
    ]);

    const adsToken = adsTokenSettled.status === 'fulfilled'
      ? adsTokenSettled.value
      : { ok: false, error: (adsTokenSettled as PromiseRejectedResult).reason?.message, errorCode: 'exception' };
    const spToken = spTokenSettled.status === 'fulfilled'
      ? spTokenSettled.value
      : { ok: false, error: (spTokenSettled as PromiseRejectedResult).reason?.message, errorCode: 'exception' };

    let adsProfile = { ok: false, errorCode: 'ADS_TOKEN_UNAVAILABLE', message: 'Token Ads indisponível', httpStatus: 0, profilesCount: 0 } as any;
    if (adsToken.ok && adsToken.accessToken) {
      const expectedProfileId = String(account?.ads_profile_id || adsCredentials.profileId.value || '');
      adsProfile = await validateAdsProfile(
        adsToken.accessToken,
        adsCredentials.clientId.value,
        String(account?.region || adsCredentials.region || 'NA'),
        expectedProfileId,
      );
    }

    const adsOk = adsToken.ok === true && adsProfile.ok === true;
    const now = new Date().toISOString();

    if (account) {
      const envRefreshConfigured = adsCredentials.refreshToken.configured;
      const tokenConflict = Boolean(dbAdsRefreshToken && adsCredentials.refreshToken.value && dbAdsRefreshToken !== adsCredentials.refreshToken.value);
      let patch: any = {
        ads_last_verified_at: now,
        ads_env_token_present: envRefreshConfigured,
        ads_token_source_conflict: tokenConflict,
        ads_active_token_source: dbAdsRefreshToken ? 'database' : (envRefreshConfigured ? 'environment_fallback' : 'missing'),
      };

      if (!adsToken.ok) {
        const failure = classifyLwaFailure(adsToken.errorCode, adsToken.httpStatus);
        patch = {
          ...patch,
          ads_token_status: failure.tokenStatus,
          ads_requires_reauth: failure.requiresReauth,
          ads_credentials_error: failure.credentialsError,
          ads_last_lwa_error_code: adsToken.errorCode || null,
          ads_last_lwa_status_code: adsToken.httpStatus || null,
          ads_token_last_error: String(adsToken.error || 'Falha de autenticação Ads').slice(0, 500),
          profile_validation_status: 'error',
          status: 'error',
          error_message: String(adsToken.error || 'Falha de autenticação Amazon Ads').slice(0, 500),
        };
      } else if (!adsProfile.ok) {
        patch = {
          ...patch,
          ads_token_status: 'active',
          ads_requires_reauth: false,
          ads_credentials_error: false,
          ads_last_lwa_error_code: null,
          ads_last_lwa_status_code: null,
          ads_token_last_error: null,
          profile_validation_status: adsProfile.errorCode === 'ADS_EXPECTED_PROFILE_NOT_FOUND' ? 'invalid' : 'error',
          status: 'error',
          error_message: String(adsProfile.message || 'Falha ao validar profile Amazon Ads').slice(0, 500),
        };
      } else {
        patch = {
          ...patch,
          ads_token_status: 'active',
          ads_requires_reauth: false,
          ads_credentials_error: false,
          ads_last_lwa_error_code: null,
          ads_last_lwa_status_code: null,
          ads_token_last_error: null,
          profile_validation_status: 'valid',
          profile_validated_at: now,
          status: 'connected',
          error_message: null,
        };
      }
      await base44.asServiceRole.entities.AmazonAccount.update(account.id, patch).catch(() => {});
    }

    return Response.json({
      ok: adsOk && spToken.ok === true,
      mode,
      account_id: account?.id || null,
      credentials: {
        ads_client_id: credentialDiagnostic(adsCredentials.clientId),
        ads_client_secret: credentialDiagnostic(adsCredentials.clientSecret),
        ads_refresh_token: dbAdsRefreshToken
          ? { configured: true, source: 'database', fingerprint: null }
          : credentialDiagnostic(adsCredentials.refreshToken),
        sp_client_id: credentialDiagnostic(spCredentials.clientId),
        sp_client_secret: credentialDiagnostic(spCredentials.clientSecret),
        sp_refresh_token: credentialDiagnostic(spCredentials.refreshToken),
      },
      services: {
        ads: {
          ok: adsOk,
          service: 'ads',
          status: adsOk ? 'active' : 'error',
          token_source: adsTokenSource,
          error_code: adsToken.ok ? adsProfile.errorCode : adsToken.errorCode,
          message: adsToken.ok ? adsProfile.message : adsToken.error,
          expires_in: adsToken.expiresIn,
          profile_validated: adsProfile.ok === true,
          profiles_count: adsProfile.profilesCount || 0,
        },
        sp: {
          ok: spToken.ok === true,
          service: 'sp',
          status: spToken.ok ? 'active' : 'error',
          error_code: spToken.errorCode,
          message: spToken.error,
          expires_in: spToken.expiresIn,
        },
      },
    });
  } catch (error: any) {
    return Response.json({ ok: false, message: error?.message || 'Health check failed' }, { status: 500 });
  }
});
