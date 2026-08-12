/**
 * amazonAdsTokenManager v10 — fonte canônica de autenticação Amazon Ads.
 *
 * O access token é persistido em AmazonAccount e nunca é incluído na resposta HTTP.
 * Gateways internos invocam este manager para garantir frescor/validade e depois
 * leem ads_access_token via service-role diretamente do banco.
 *
 * Hierarquia do refresh token:
 * 1. AmazonAccount.ads_refresh_token (DB, canônico em runtime após OAuth)
 * 2. ADS_REFRESH_TOKEN apenas quando o banco não possui token.
 *
 * Token existente no DB que esteja revogado NUNCA cai silenciosamente para ENV.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import {
  ADS_TOKEN_REVOKED_REAUTH_REQUIRED,
  adsBaseUrlForRegion,
  resolveAmazonAdsCredentials,
  shortCredentialHash,
  validAmazonAdsRefreshToken,
} from '../../shared/amazonCredentials.ts';
import { classifyLwaFailure } from '../../shared/amazonAuthStatus.ts';

const ACCESS_TOKEN_BUFFER_MS = 10 * 60 * 1000;
const PROACTIVE_REFRESH_THRESHOLD_MS = 15 * 60 * 1000;
const SAFETY_MARGIN_MS = 2 * 60 * 1000;
const LOCK_TTL_MS = 60 * 1000;
const CONCURRENCY_WAIT_MS = 2500;
const CONCURRENCY_MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [0, 2000, 6000];

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function validAccessToken(account: any, marginMs = SAFETY_MARGIN_MS) {
  const token = String(account?.ads_access_token || '').trim();
  const expires = new Date(account?.ads_access_token_expires_at || 0).getTime();
  return token.length > 20 && Number.isFinite(expires) && expires > Date.now() + marginMs;
}

async function readAccount(base44: any, accountId: string) {
  const rows = await base44.asServiceRole.entities.AmazonAccount.filter({ id: accountId }, null, 1).catch(() => []);
  return rows[0] || null;
}

async function logEvent(base44: any, accountId: string, status: string, summary: any) {
  const now = new Date().toISOString();
  await base44.asServiceRole.entities.SyncExecutionLog.create({
    amazon_account_id: accountId,
    operation: 'amazon_ads:token_manager_v10',
    status,
    trigger_type: 'automatic',
    started_at: now,
    completed_at: now,
    records_processed: status === 'success' ? 1 : 0,
    result_summary: status === 'success' ? JSON.stringify(summary).slice(0, 4000) : null,
    error_message: status === 'success' ? null : String(summary?.message || summary?.error || 'Falha de token').slice(0, 500),
  }).catch(() => {});
}

async function requestAccessToken(refreshToken: string, clientId: string, clientSecret: string) {
  if (!clientId || !clientSecret) {
    throw {
      error_type: 'missing_credentials',
      message: 'ADS_CLIENT_ID ou ADS_CLIENT_SECRET não configurados na fonte canônica',
      credentials_error: true,
      requires_reauthorization: false,
      retryable: false,
    };
  }
  const response = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const failure = classifyLwaFailure(String(data?.error || `http_${response.status}`), response.status);
    throw {
      error_type: failure.credentialsError ? 'credentials_error' : (failure.requiresReauth ? 'invalid_grant' : 'token_refresh_denied'),
      message: String(data?.error_description || data?.message || data?.error || `HTTP ${response.status}`),
      status_code: response.status,
      amazon_error_code: data?.error || null,
      credentials_error: failure.credentialsError,
      requires_reauthorization: failure.requiresReauth,
      retryable: response.status === 429 || response.status >= 500,
    };
  }
  if (!data?.access_token) {
    throw {
      error_type: 'token_refresh_denied',
      message: 'Amazon LWA não retornou access_token',
      credentials_error: false,
      requires_reauthorization: false,
      retryable: false,
    };
  }
  return {
    access_token: String(data.access_token),
    expires_in: Math.max(600, Number(data.expires_in || 3600)),
  };
}

async function validateExpectedProfile(accessToken: string, clientId: string, region: string, expectedProfileId: string) {
  if (!expectedProfileId) return { ok: false, code: 'ADS_PROFILE_ID_MISSING', status: 0, message: 'ads_profile_id não configurado', count: 0 };
  try {
    const response = await fetch(`${adsBaseUrlForRegion(region)}/v2/profiles`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Amazon-Advertising-API-ClientId': clientId,
      },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        ok: false,
        code: String(data?.code || data?.error || `http_${response.status}`),
        status: response.status,
        message: String(data?.details || data?.message || data?.error_description || `Amazon Ads HTTP ${response.status}`).slice(0, 500),
        count: 0,
      };
    }
    const profiles = Array.isArray(data) ? data : [];
    const found = profiles.some((profile: any) => String(profile?.profileId || '') === String(expectedProfileId));
    return {
      ok: found,
      code: found ? null : 'ADS_EXPECTED_PROFILE_NOT_FOUND',
      status: response.status,
      message: found ? null : `Profile esperado ${expectedProfileId} não encontrado na autorização atual`,
      count: profiles.length,
    };
  } catch (error: any) {
    return { ok: false, code: 'ADS_PROFILE_VALIDATION_NETWORK_ERROR', status: 0, message: error?.message || String(error), count: 0 };
  }
}

async function releaseLock(base44: any, accountId: string) {
  await base44.asServiceRole.entities.AmazonAccount.update(accountId, {
    ads_token_refresh_in_progress: false,
    ads_token_refresh_started_at: null,
  }).catch(() => {});
}

Deno.serve(async (req) => {
  const startedAt = Date.now();
  let base44: any = null;
  let accountId = '';
  let lockOwned = false;
  try {
    base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    if (body._service_role !== true) return Response.json({ ok: false, error: 'Uso interno apenas' }, { status: 403 });

    accountId = String(body.amazon_account_id || '');
    if (!accountId) return Response.json({ ok: false, error_type: 'missing_account_id', error: 'amazon_account_id obrigatório' }, { status: 400 });
    let account = await readAccount(base44, accountId);
    if (!account) return Response.json({ ok: false, error_type: 'account_not_found', error: 'Conta Amazon não encontrada' }, { status: 404 });

    const credentials = resolveAmazonAdsCredentials();
    const dbRefreshToken = String(account.ads_refresh_token || '').trim();
    const envRefreshToken = credentials.refreshToken.value;
    const hasDbToken = validAmazonAdsRefreshToken(dbRefreshToken);
    const hasEnvToken = validAmazonAdsRefreshToken(envRefreshToken);
    const tokenConflict = hasDbToken && hasEnvToken && dbRefreshToken !== envRefreshToken;
    const activeTokenSource = hasDbToken ? 'database' : (hasEnvToken ? 'environment_fallback' : 'missing');
    const refreshToken = hasDbToken ? dbRefreshToken : (hasEnvToken ? envRefreshToken : '');

    await base44.asServiceRole.entities.AmazonAccount.update(accountId, {
      ads_env_token_present: hasEnvToken,
      ads_token_source_conflict: tokenConflict,
      ads_active_token_source: activeTokenSource,
    }).catch(() => {});

    if (tokenConflict) {
      console.warn(`[TokenManager v10] DB/ENV divergem: db_hash=${shortCredentialHash(dbRefreshToken)} env_hash=${shortCredentialHash(envRefreshToken)}; DB permanece canônico.`);
    }

    if (!refreshToken) {
      await base44.asServiceRole.entities.AmazonAccount.update(accountId, {
        ads_token_status: 'missing',
        ads_requires_reauth: true,
        ads_credentials_error: false,
        ads_token_last_error: 'Refresh token Amazon Ads ausente ou inválido',
        ads_active_token_source: 'missing',
        status: 'error',
        error_message: 'Reautorização Amazon Ads necessária.',
      }).catch(() => {});
      return Response.json({
        ok: false,
        error_type: ADS_TOKEN_REVOKED_REAUTH_REQUIRED,
        requires_reauthorization: true,
        active_token_source: 'missing',
        message: 'Refresh token Amazon Ads ausente. Reautorize em /amazon-oauth-setup.',
      }, { status: 401 });
    }

    if (account.ads_requires_reauth === true || String(account.ads_token_status || '') === 'revoked') {
      return Response.json({
        ok: false,
        error_type: ADS_TOKEN_REVOKED_REAUTH_REQUIRED,
        amazon_error_code: account.ads_last_lwa_error_code || 'unauthorized_client',
        requires_reauthorization: true,
        credentials_error: false,
        active_token_source: activeTokenSource,
        token_source_conflict: tokenConflict,
        message: 'Autorização Amazon Ads revogada. Reautorize em /amazon-oauth-setup.',
      }, { status: 401 });
    }

    const forceRefresh = body.force_refresh === true;
    if (!forceRefresh && validAccessToken(account)) {
      const msUntilExpiry = new Date(account.ads_access_token_expires_at || 0).getTime() - Date.now();
      if (msUntilExpiry > PROACTIVE_REFRESH_THRESHOLD_MS) {
        return Response.json({
          ok: true,
          token_available: true,
          expires_at: account.ads_access_token_expires_at,
          from_cache: true,
          source: 'database_access_token_cache',
          active_token_source: activeTokenSource,
          token_source_conflict: tokenConflict,
        });
      }
    }

    const lockStarted = account.ads_token_refresh_started_at ? new Date(account.ads_token_refresh_started_at).getTime() : 0;
    const lockAlive = account.ads_token_refresh_in_progress === true && Date.now() - lockStarted < LOCK_TTL_MS;
    if (lockAlive) {
      for (let attempt = 0; attempt < CONCURRENCY_MAX_RETRIES; attempt += 1) {
        await wait(CONCURRENCY_WAIT_MS);
        account = await readAccount(base44, accountId);
        if (validAccessToken(account, 60_000)) {
          return Response.json({
            ok: true,
            token_available: true,
            expires_at: account.ads_access_token_expires_at,
            from_cache: true,
            source: 'database_after_concurrent_wait',
            active_token_source: activeTokenSource,
            token_source_conflict: tokenConflict,
          });
        }
        const stillAlive = account?.ads_token_refresh_in_progress === true &&
          Date.now() - new Date(account?.ads_token_refresh_started_at || 0).getTime() < LOCK_TTL_MS;
        if (!stillAlive) break;
      }
    }

    await base44.asServiceRole.entities.AmazonAccount.update(accountId, {
      ads_token_refresh_in_progress: true,
      ads_token_refresh_started_at: new Date().toISOString(),
      ads_token_status: 'refreshing',
    });
    lockOwned = true;

    let tokenResult: any = null;
    let refreshError: any = null;
    for (const delay of RETRY_DELAYS_MS) {
      if (delay) await wait(delay);
      try {
        tokenResult = await requestAccessToken(refreshToken, credentials.clientId.value, credentials.clientSecret.value);
        refreshError = null;
        break;
      } catch (error: any) {
        refreshError = error;
        if (error?.retryable !== true) break;
      }
    }

    if (!tokenResult) {
      const failure = classifyLwaFailure(refreshError?.amazon_error_code, refreshError?.status_code);
      const now = new Date().toISOString();
      const patch: any = {
        ads_token_refresh_in_progress: false,
        ads_token_refresh_started_at: null,
        ads_token_status: failure.tokenStatus,
        ads_requires_reauth: failure.requiresReauth,
        ads_credentials_error: failure.credentialsError,
        ads_last_lwa_error_code: refreshError?.amazon_error_code || null,
        ads_last_lwa_status_code: refreshError?.status_code || null,
        ads_token_last_error: String(refreshError?.message || 'Falha ao renovar token Amazon Ads').slice(0, 500),
        ads_last_verified_at: now,
        status: 'error',
        error_message: String(refreshError?.message || 'Falha de autenticação Amazon Ads').slice(0, 500),
      };
      await base44.asServiceRole.entities.AmazonAccount.update(accountId, patch).catch(() => {});
      lockOwned = false;
      await logEvent(base44, accountId, 'error', {
        message: patch.ads_token_last_error,
        amazon_error_code: refreshError?.amazon_error_code || null,
        active_token_source: activeTokenSource,
        token_source_conflict: tokenConflict,
      });
      const explicitCode = failure.requiresReauth ? ADS_TOKEN_REVOKED_REAUTH_REQUIRED : (refreshError?.error_type || 'token_refresh_failed');
      return Response.json({
        ok: false,
        error_type: explicitCode,
        amazon_error_code: refreshError?.amazon_error_code || null,
        status_code: refreshError?.status_code || null,
        requires_reauthorization: failure.requiresReauth,
        credentials_error: failure.credentialsError,
        retryable: refreshError?.retryable === true,
        active_token_source: activeTokenSource,
        env_fallback_attempted: false,
        token_source_conflict: tokenConflict,
        message: failure.requiresReauth
          ? 'Refresh token Amazon Ads revogado. Reautorize em /amazon-oauth-setup.'
          : String(refreshError?.message || 'Falha ao renovar token Amazon Ads'),
      }, { status: failure.requiresReauth ? 401 : (refreshError?.retryable ? 503 : 400) });
    }

    const expectedProfileId = String(account.ads_profile_id || credentials.profileId.value || '');
    const region = String(account.region || credentials.region || 'NA');
    const profileValidation = await validateExpectedProfile(tokenResult.access_token, credentials.clientId.value, region, expectedProfileId);
    if (!profileValidation.ok) {
      await releaseLock(base44, accountId);
      lockOwned = false;
      await base44.asServiceRole.entities.AmazonAccount.update(accountId, {
        ads_token_status: 'active',
        ads_requires_reauth: false,
        ads_credentials_error: false,
        ads_last_lwa_error_code: null,
        ads_last_lwa_status_code: null,
        ads_token_last_error: null,
        ads_last_verified_at: new Date().toISOString(),
        profile_validation_status: profileValidation.code === 'ADS_EXPECTED_PROFILE_NOT_FOUND' ? 'invalid' : 'error',
        status: 'error',
        error_message: String(profileValidation.message || 'Falha ao validar profile Amazon Ads').slice(0, 500),
      }).catch(() => {});
      await logEvent(base44, accountId, 'error', profileValidation);
      return Response.json({
        ok: false,
        error_type: profileValidation.code,
        status_code: profileValidation.status,
        requires_reauthorization: false,
        message: profileValidation.message,
      }, { status: 409 });
    }

    const now = new Date().toISOString();
    const effectiveExpiresMs = tokenResult.expires_in * 1000 - ACCESS_TOKEN_BUFFER_MS;
    const expiresAt = new Date(Date.now() + Math.max(effectiveExpiresMs, 5 * 60 * 1000)).toISOString();
    const patch: any = {
      ads_access_token: tokenResult.access_token,
      ads_access_token_expires_at: expiresAt,
      ads_last_token_refresh_at: now,
      ads_last_verified_at: now,
      ads_token_refresh_in_progress: false,
      ads_token_refresh_started_at: null,
      ads_token_status: 'active',
      ads_token_last_error: null,
      ads_requires_reauth: false,
      ads_credentials_error: false,
      ads_last_lwa_error_code: null,
      ads_last_lwa_status_code: null,
      ads_active_token_source: activeTokenSource,
      ads_env_token_present: hasEnvToken,
      ads_token_source_conflict: tokenConflict,
      profile_validation_status: 'valid',
      profile_validated_at: now,
      status: 'connected',
      error_message: null,
    };
    if (!hasDbToken && hasEnvToken) {
      patch.ads_refresh_token = envRefreshToken;
      patch.ads_refresh_token_updated_at = now;
      patch.ads_last_recovery_source = 'environment_fallback_db_missing';
      patch.ads_last_recovery_at = now;
    }
    await base44.asServiceRole.entities.AmazonAccount.update(accountId, patch);
    lockOwned = false;

    await logEvent(base44, accountId, 'success', {
      source: activeTokenSource,
      env_source: credentials.refreshToken.source,
      env_fingerprint: credentials.refreshToken.fingerprint,
      db_fingerprint: shortCredentialHash(dbRefreshToken),
      token_source_conflict: tokenConflict,
      profile_id: expectedProfileId,
      profiles_count: profileValidation.count,
      expires_at: expiresAt,
      duration_ms: Date.now() - startedAt,
    });

    return Response.json({
      ok: true,
      token_available: true,
      expires_at: expiresAt,
      from_cache: false,
      source: 'lwa_refresh',
      active_token_source: activeTokenSource,
      token_source_conflict: tokenConflict,
      profile_validated: true,
      duration_ms: Date.now() - startedAt,
    });
  } catch (error: any) {
    if (base44 && accountId && lockOwned) await releaseLock(base44, accountId);
    return Response.json({
      ok: false,
      error_type: error?.error_type || 'token_manager_internal_error',
      message: error?.message || String(error),
      requires_reauthorization: error?.requires_reauthorization === true,
      credentials_error: error?.credentials_error === true,
    }, { status: 500 });
  }
});
