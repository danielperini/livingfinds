/**
 * getOAuthSetupInfo — diagnóstico ao vivo e configuração OAuth Amazon Ads.
 * Banco é fonte primária do refresh token; ADS_REFRESH_TOKEN é fallback apenas
 * quando o banco não possui token. Nenhum token/secret é retornado.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import {
  ADS_OAUTH_SCOPE,
  adsBaseUrlForRegion,
  credentialDiagnostic,
  resolveAdsOAuthRedirectUri,
  resolveAmazonAdsCredentials,
  shortCredentialHash,
  validAmazonAdsRefreshToken,
} from '../../shared/amazonCredentials.ts';
import { classifyLwaFailure } from '../../shared/amazonAuthStatus.ts';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

    const credentials = resolveAmazonAdsCredentials();
    const accounts = await base44.entities.AmazonAccount.filter({ user_id: user.id }, '-updated_date', 1).catch(() => [] as any[]);
    const account = accounts[0] || null;
    const entityRefreshToken = String(account?.ads_refresh_token || '').trim();
    const envRefreshToken = credentials.refreshToken.value;
    const dbTokenValid = validAmazonAdsRefreshToken(entityRefreshToken);
    const envTokenValid = validAmazonAdsRefreshToken(envRefreshToken);
    const refreshToken = dbTokenValid ? entityRefreshToken : (envTokenValid ? envRefreshToken : '');
    const tokenSource = dbTokenValid ? 'database' : (envTokenValid ? credentials.refreshToken.source : null);
    const tokenConflict = dbTokenValid && envTokenValid && entityRefreshToken !== envRefreshToken;
    const expectedProfileId = String(account?.ads_profile_id || credentials.profileId.value || '').trim();
    const region = String(account?.region || credentials.region || 'NA');

    let redirectUri: string | null = null;
    let redirectError: string | null = null;
    try {
      redirectUri = resolveAdsOAuthRedirectUri();
    } catch (error: any) {
      redirectError = error?.message || String(error);
    }

    const authUrl = redirectUri && credentials.clientId.value
      ? `https://www.amazon.com/ap/oa?client_id=${encodeURIComponent(credentials.clientId.value)}&scope=${encodeURIComponent(ADS_OAUTH_SCOPE)}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}`
      : null;

    let tokenStatus = 'not_configured';
    let tokenError: string | null = null;
    let tokenErrorCode: string | null = null;
    let tokenHttpStatus: number | null = null;
    let accessToken = '';

    if (!credentials.clientId.value || !credentials.clientSecret.value) {
      tokenStatus = 'not_configured';
      tokenError = !credentials.clientId.value ? 'ADS_CLIENT_ID não configurado' : 'ADS_CLIENT_SECRET não configurado';
    } else if (!refreshToken) {
      tokenStatus = 'not_configured';
      tokenError = 'Refresh token Amazon Ads não configurado';
    } else {
      try {
        const response = await fetch('https://api.amazon.com/auth/o2/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: credentials.clientId.value,
            client_secret: credentials.clientSecret.value,
          }).toString(),
        });
        const data = await response.json().catch(() => ({}));
        tokenHttpStatus = response.status;
        if (response.ok && data?.access_token) {
          tokenStatus = 'valid';
          accessToken = String(data.access_token);
        } else {
          tokenStatus = 'invalid';
          tokenErrorCode = String(data?.error || `http_${response.status}`);
          tokenError = String(data?.error_description || data?.message || data?.error || `HTTP ${response.status}`);
        }
      } catch (error: any) {
        tokenStatus = 'error';
        tokenErrorCode = 'network_error';
        tokenError = error?.message || String(error);
      }
    }

    let profiles: any[] = [];
    let profilesError: string | null = null;
    let profilesErrorCode: string | null = null;
    let expectedProfileValidated = false;
    if (accessToken) {
      try {
        const response = await fetch(`${adsBaseUrlForRegion(region)}/v2/profiles`, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Amazon-Advertising-API-ClientId': credentials.clientId.value,
            Accept: 'application/json',
          },
        });
        const data = await response.json().catch(() => ({}));
        if (response.ok) {
          profiles = Array.isArray(data) ? data : [];
          expectedProfileValidated = Boolean(expectedProfileId) && profiles.some((p: any) => String(p?.profileId || '') === expectedProfileId);
          if (!expectedProfileId) {
            profilesErrorCode = 'ADS_PROFILE_ID_MISSING';
            profilesError = 'ads_profile_id não configurado';
          } else if (!expectedProfileValidated) {
            profilesErrorCode = 'ADS_EXPECTED_PROFILE_NOT_FOUND';
            profilesError = `Profile esperado ${expectedProfileId} não foi encontrado na autorização atual`;
          }
        } else {
          profilesErrorCode = String(data?.code || data?.error || `http_${response.status}`);
          profilesError = String(data?.details || data?.message || data?.error_description || `HTTP ${response.status}`).slice(0, 500);
        }
      } catch (error: any) {
        profilesErrorCode = 'ADS_PROFILE_VALIDATION_NETWORK_ERROR';
        profilesError = error?.message || String(error);
      }
    }

    if (account) {
      const now = new Date().toISOString();
      let patch: any = {
        ads_last_verified_at: now,
        ads_env_token_present: envTokenValid,
        ads_token_source_conflict: tokenConflict,
        ads_active_token_source: dbTokenValid ? 'database' : (envTokenValid ? 'environment_fallback' : 'missing'),
      };
      if (tokenStatus !== 'valid') {
        const failure = classifyLwaFailure(tokenErrorCode || undefined, tokenHttpStatus || undefined);
        patch = {
          ...patch,
          ads_token_status: tokenStatus === 'not_configured' ? 'missing' : failure.tokenStatus,
          ads_requires_reauth: tokenStatus === 'not_configured' ? true : failure.requiresReauth,
          ads_credentials_error: tokenStatus === 'not_configured' ? false : failure.credentialsError,
          ads_last_lwa_error_code: tokenErrorCode,
          ads_last_lwa_status_code: tokenHttpStatus,
          ads_token_last_error: tokenError,
          profile_validation_status: 'error',
          status: 'error',
          error_message: tokenError || 'Amazon Ads não autenticada',
        };
      } else if (!expectedProfileValidated) {
        patch = {
          ...patch,
          ads_token_status: 'active',
          ads_requires_reauth: false,
          ads_credentials_error: false,
          ads_last_lwa_error_code: null,
          ads_last_lwa_status_code: null,
          ads_token_last_error: null,
          profile_validation_status: profilesErrorCode === 'ADS_EXPECTED_PROFILE_NOT_FOUND' ? 'invalid' : 'error',
          status: 'error',
          error_message: profilesError || 'Profile Amazon Ads não validado',
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

    const effectiveTokenStatus = tokenStatus === 'valid' && expectedProfileValidated ? 'valid' : (tokenStatus === 'valid' ? 'invalid' : tokenStatus);
    const activeRefreshFingerprint = shortCredentialHash(refreshToken);
    const safeClientLabel = credentials.clientId.configured
      ? `${credentials.clientId.source || 'ADS_CLIENT_ID'} · ${credentials.clientId.fingerprint || 'hash-indisponível'}`
      : null;
    const safeRefreshLabel = refreshToken
      ? `${tokenSource || 'configured'} · ${activeRefreshFingerprint || 'hash-indisponível'}`
      : null;
    const safeEnvLabel = envTokenValid
      ? `${credentials.refreshToken.source || 'ADS_REFRESH_TOKEN'} · ${credentials.refreshToken.fingerprint || 'hash-indisponível'}`
      : null;

    return Response.json({
      ok: true,
      config: {
        client_id: credentialDiagnostic(credentials.clientId),
        client_secret: credentialDiagnostic(credentials.clientSecret),
        env_refresh_token: credentialDiagnostic(credentials.refreshToken),
        db_refresh_token: {
          configured: dbTokenValid,
          source: dbTokenValid ? 'database' : null,
          fingerprint: shortCredentialHash(entityRefreshToken),
        },
        // Compatibilidade de UI: são labels source+fingerprint, não previews de secrets.
        client_id_preview: safeClientLabel,
        refresh_token_preview: safeRefreshLabel,
        env_token_preview: safeEnvLabel,
        profile_id: expectedProfileId || null,
        region,
        ads_base_url: adsBaseUrlForRegion(region),
        redirect_uri: redirectUri,
        redirect_uri_error: redirectError,
        oauth_scope: ADS_OAUTH_SCOPE,
        token_source: tokenSource,
        account_id: account?.id || null,
        account_status: account?.status || null,
        has_entity_token: dbTokenValid,
        has_secret_token: envTokenValid,
        env_token_present: envTokenValid,
        db_token_present: dbTokenValid,
        last_recovery_source: account?.ads_last_recovery_source || null,
        last_recovery_at: account?.ads_last_recovery_at || null,
        tokens_are_different: tokenConflict,
        environment_update_required: tokenConflict || (dbTokenValid && !envTokenValid),
      },
      token_status: effectiveTokenStatus,
      token_error: tokenStatus === 'valid' ? profilesError : tokenError,
      token_error_code: tokenStatus === 'valid' ? profilesErrorCode : tokenErrorCode,
      auth_url: authUrl,
      expected_profile_validated: expectedProfileValidated,
      profiles: profiles.map((p: any) => ({
        profileId: p.profileId,
        name: p.accountInfo?.name || null,
        marketplace: p.countryCode || null,
        type: p.accountInfo?.type || null,
      })),
      profiles_error: profilesError,
      environment_warning: tokenConflict
        ? 'O refresh token do banco difere do ADS_REFRESH_TOKEN carregado pela VPS.'
        : (dbTokenValid && !envTokenValid ? 'O banco possui refresh token, mas ADS_REFRESH_TOKEN não está configurado na VPS.' : null),
    });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || String(error) }, { status: 500 });
  }
});
