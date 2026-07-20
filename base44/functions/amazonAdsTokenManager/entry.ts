/**
 * amazonAdsTokenManager v7 — fonte única de access token Amazon Ads.
 *
 * Hierarquia de refresh token:
 * 1. AmazonAccount.ads_refresh_token (DB)
 * 2. ADS_REFRESH_TOKEN do ambiente (fallback silencioso quando DB retorna unauthorized_client)
 *
 * Se o DB token falhar com invalid_grant/unauthorized_client E o ENV token for diferente,
 * tenta automaticamente o ENV token e, se funcionar, persiste ele no banco para ciclos futuros.
 * Intervenção humana apenas quando AMBOS falham.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const SAFETY_MARGIN_MS = 5 * 60 * 1000;
const LOCK_TTL_MS = 90 * 1000;
const RETRY_DELAYS_MS = [0, 2000, 6000];
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function validRefreshToken(value: any) {
  const token = String(value || '').trim();
  return token.startsWith('Atzr|') && token.length >= 50;
}

function validAccessToken(account: any, marginMs = SAFETY_MARGIN_MS) {
  const token = String(account?.ads_access_token || '').trim();
  const expires = new Date(account?.ads_access_token_expires_at || 0).getTime();
  return token.length > 20 && Number.isFinite(expires) && expires > Date.now() + marginMs;
}

function classifyLwaError(data: any, status: number) {
  const code = String(data?.error || 'unknown');
  const description = String(data?.error_description || data?.message || data?.error || `HTTP ${status}`);
  if (code === 'invalid_client') return { error_type: 'credentials_error', message: description, status_code: status, amazon_error_code: code, credentials_error: true, requires_reauthorization: false, retryable: false };
  if (['invalid_grant', 'unauthorized_client', 'access_denied', 'authorization_code_used'].includes(code)) return { error_type: 'invalid_grant', message: description, status_code: status, amazon_error_code: code, credentials_error: false, requires_reauthorization: true, retryable: false };
  if (status === 429 || status >= 500) return { error_type: 'temporary_network_error', message: description, status_code: status, amazon_error_code: code, credentials_error: false, requires_reauthorization: false, retryable: true };
  return { error_type: 'token_refresh_denied', message: description, status_code: status, amazon_error_code: code, credentials_error: false, requires_reauthorization: false, retryable: false };
}

async function requestAccessToken(refreshToken: string) {
  const clientId = String(Deno.env.get('ADS_CLIENT_ID') || '');
  const clientSecret = String(Deno.env.get('ADS_CLIENT_SECRET') || '');
  if (!clientId || !clientSecret) throw { error_type: 'missing_credentials', message: 'ADS_CLIENT_ID ou ADS_CLIENT_SECRET não configurados', credentials_error: true, requires_reauthorization: false, retryable: false };

  const response = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw classifyLwaError(data, response.status);
  if (!data?.access_token) throw { error_type: 'token_refresh_denied', message: 'Amazon LWA não retornou access_token', credentials_error: false, requires_reauthorization: false, retryable: false };
  return { access_token: String(data.access_token), expires_in: Math.max(600, Number(data.expires_in || 3600)) };
}

async function readAccount(base44: any, accountId: string) {
  const rows = await base44.asServiceRole.entities.AmazonAccount.filter({ id: accountId }, null, 1).catch(() => []);
  return rows[0] || null;
}

async function logEvent(base44: any, accountId: string, status: string, summary: any) {
  const now = new Date().toISOString();
  await base44.asServiceRole.entities.SyncExecutionLog.create({
    amazon_account_id: accountId,
    operation: 'amazon_ads:token_manager_v7',
    status,
    trigger_type: 'automatic',
    started_at: now,
    completed_at: now,
    records_processed: status === 'success' ? 1 : 0,
    result_summary: status === 'success' ? JSON.stringify(summary).slice(0, 4000) : null,
    error_message: status === 'success' ? null : String(summary?.message || summary?.error || 'Falha de token').slice(0, 500),
  }).catch(() => {});
}

async function persistSuccessfulToken(base44: any, accountId: string, tokenResult: any, source: string, envRefreshToken?: string) {
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + tokenResult.expires_in * 1000).toISOString();
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
    ads_active_token_source: source,
    status: 'connected',
    error_message: null,
  };
  // Se recuperado via ENV fallback, persistir o ENV token no banco para próximos ciclos
  if (source === 'environment_fallback' && envRefreshToken) {
    patch.ads_refresh_token = envRefreshToken;
    patch.ads_last_recovery_source = 'environment_fallback';
    patch.ads_last_recovery_at = now;
  }
  await base44.asServiceRole.entities.AmazonAccount.update(accountId, patch);
  return { access_token: tokenResult.access_token, expires_at: expiresAt };
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
    const forceRefresh = body.force_refresh === true;

    let account = await readAccount(base44, accountId);
    if (!account) return Response.json({ ok: false, error_type: 'account_not_found', error: 'Conta Amazon não encontrada' }, { status: 404 });

    const dbRefreshToken = String(account.ads_refresh_token || '').trim();
    const envRefreshToken = String(Deno.env.get('ADS_REFRESH_TOKEN') || '').trim();
    const hasDbToken = validRefreshToken(dbRefreshToken);
    const hasEnvToken = validRefreshToken(envRefreshToken);
    const envIsDifferentFromDb = hasEnvToken && dbRefreshToken !== envRefreshToken;

    const refreshToken = hasDbToken ? dbRefreshToken : hasEnvToken ? envRefreshToken : '';
    const activeTokenSource = hasDbToken ? 'database' : hasEnvToken ? 'environment_fallback' : 'missing';
    const tokenConflict = hasDbToken && hasEnvToken && dbRefreshToken !== envRefreshToken;

    if (!refreshToken) {
      await base44.asServiceRole.entities.AmazonAccount.update(accountId, {
        ads_token_status: 'missing', ads_requires_reauth: true,
        ads_token_last_error: 'refresh_token ausente ou inválido',
        ads_active_token_source: 'missing',
        ads_env_token_present: hasEnvToken,
        ads_token_source_conflict: tokenConflict,
      }).catch(() => {});
      return Response.json({ ok: false, error_type: 'missing_refresh_token', requires_reauthorization: true, active_token_source: 'missing', message: 'Refresh token Amazon Ads ausente. Reconecte a conta.' });
    }

    if (!forceRefresh && validAccessToken(account)) {
      return Response.json({ ok: true, access_token: account.ads_access_token, expires_at: account.ads_access_token_expires_at, from_cache: true, source: 'database', active_token_source: activeTokenSource, token_source_conflict: tokenConflict });
    }

    // Gerenciar lock
    const lockStarted = new Date(account.ads_token_refresh_started_at || 0).getTime();
    const lockActive = account.ads_token_refresh_in_progress === true && Number.isFinite(lockStarted) && Date.now() - lockStarted < LOCK_TTL_MS;
    if (lockActive) {
      for (let attempt = 0; attempt < 5; attempt++) {
        await wait(1200);
        account = await readAccount(base44, accountId);
        if (account && validAccessToken(account, 60_000)) {
          return Response.json({ ok: true, access_token: account.ads_access_token, expires_at: account.ads_access_token_expires_at, from_cache: true, source: 'database_after_lock_wait', active_token_source: activeTokenSource });
        }
        if (!account?.ads_token_refresh_in_progress) break;
      }
      if (account?.ads_token_refresh_in_progress) return Response.json({ ok: false, error_type: 'refresh_in_progress', retryable: true, status_code: 409, message: 'Renovação de token já está em andamento.' }, { status: 409 });
    }

    // Adquirir lock
    await base44.asServiceRole.entities.AmazonAccount.update(accountId, {
      ads_token_refresh_in_progress: true,
      ads_token_refresh_started_at: new Date().toISOString(),
      ads_token_status: 'refreshing',
      ads_active_token_source: activeTokenSource,
      ads_env_token_present: hasEnvToken,
      ads_token_source_conflict: tokenConflict,
    });
    lockOwned = true;

    // Releitura após lock
    account = await readAccount(base44, accountId);
    if (!forceRefresh && validAccessToken(account)) {
      await base44.asServiceRole.entities.AmazonAccount.update(accountId, { ads_token_refresh_in_progress: false, ads_token_refresh_started_at: null, ads_token_status: 'active' }).catch(() => {});
      lockOwned = false;
      return Response.json({ ok: true, access_token: account.ads_access_token, expires_at: account.ads_access_token_expires_at, from_cache: true, source: 'database_after_lock', active_token_source: activeTokenSource });
    }

    // ── TENTATIVA 1: token primário (DB ou ENV conforme hierarquia) ───────
    let tokenResult: any = null;
    let refreshError: any = null;
    for (const delay of RETRY_DELAYS_MS) {
      if (delay) await wait(delay);
      try {
        tokenResult = await requestAccessToken(refreshToken);
        refreshError = null;
        break;
      } catch (error: any) {
        refreshError = error;
        if (error?.retryable !== true) break;
      }
    }

    if (tokenResult) {
      const { access_token, expires_at } = await persistSuccessfulToken(base44, accountId, tokenResult, activeTokenSource);
      lockOwned = false;
      await logEvent(base44, accountId, 'success', { source: activeTokenSource, expires_at, duration_ms: Date.now() - startedAt });
      return Response.json({ ok: true, access_token, expires_at, from_cache: false, source: 'lwa_refresh', active_token_source: activeTokenSource, token_source_conflict: tokenConflict, duration_ms: Date.now() - startedAt });
    }

    // ── TENTATIVA 2 (FALLBACK SILENCIOSO): se o token do DB falhou com invalid_grant
    //    E o ENV token está disponível e é diferente → tentar sem intervenção humana ──
    const isRevocationError = refreshError?.error_type === 'invalid_grant' || refreshError?.amazon_error_code === 'unauthorized_client';
    const shouldTryEnvFallback = isRevocationError && hasDbToken && hasEnvToken && envIsDifferentFromDb;

    if (shouldTryEnvFallback) {
      console.log('[TokenManager] DB token rejeitado com unauthorized_client. Tentando fallback ENV automaticamente...');
      let envTokenResult: any = null;
      let envRefreshError: any = null;

      for (const delay of RETRY_DELAYS_MS) {
        if (delay) await wait(delay);
        try {
          envTokenResult = await requestAccessToken(envRefreshToken);
          envRefreshError = null;
          break;
        } catch (error: any) {
          envRefreshError = error;
          if (error?.retryable !== true) break;
        }
      }

      if (envTokenResult) {
        // Fallback funcionou — persistir e retornar sucesso silencioso
        const { access_token, expires_at } = await persistSuccessfulToken(base44, accountId, envTokenResult, 'environment_fallback', envRefreshToken);
        lockOwned = false;
        await logEvent(base44, accountId, 'success', {
          source: 'environment_fallback',
          recovered_from_env_fallback: true,
          original_error: refreshError?.amazon_error_code || refreshError?.error_type,
          expires_at,
          duration_ms: Date.now() - startedAt,
        });
        // Limpar alertas de token ativos
        base44.asServiceRole.entities.Alert.filter({ amazon_account_id: accountId, status: 'active' }, '-created_at', 10)
          .then((alerts: any[]) => alerts.forEach((a: any) => {
            if (a.alert_type === 'token_expired' || a.alert_type === 'token_revoked') {
              base44.asServiceRole.entities.Alert.update(a.id, { status: 'resolved', resolved_at: new Date().toISOString() }).catch(() => {});
            }
          })).catch(() => {});
        return Response.json({ ok: true, access_token, expires_at, from_cache: false, source: 'lwa_refresh', active_token_source: 'environment_fallback', recovered_from_env_fallback: true, duration_ms: Date.now() - startedAt });
      }

      // Ambos falharam — usar o erro mais recente (do ENV) para diagnosticar
      refreshError = envRefreshError || refreshError;
    }

    // ── Ambos os tokens falharam — registrar e retornar erro ─────────────
    const requiresReauth = refreshError?.requires_reauthorization === true;
    const credentialsError = refreshError?.credentials_error === true;
    const transient = refreshError?.retryable === true;
    const safeMessage = String(refreshError?.message || 'Falha ao renovar token Amazon Ads').slice(0, 500);
    const stillUsable = validAccessToken(account, 30_000);

    await base44.asServiceRole.entities.AmazonAccount.update(accountId, {
      ads_token_refresh_in_progress: false,
      ads_token_refresh_started_at: null,
      ads_token_status: transient && stillUsable ? 'active' : credentialsError ? 'credentials_error' : requiresReauth ? 'revoked' : 'error',
      ads_token_last_error: safeMessage,
      ads_last_lwa_error_code: refreshError?.amazon_error_code || refreshError?.error_type || 'token_refresh_failed',
      ads_last_lwa_status_code: refreshError?.status_code || null,
      ads_requires_reauth: requiresReauth,
      ads_credentials_error: credentialsError,
      ...(requiresReauth || credentialsError ? { status: 'error', error_message: safeMessage } : {}),
    }).catch(() => {});
    lockOwned = false;
    await logEvent(base44, accountId, transient ? 'warning' : 'error', refreshError || { message: safeMessage });

    if (transient && stillUsable) {
      return Response.json({ ok: true, access_token: account.ads_access_token, expires_at: account.ads_access_token_expires_at, from_cache: true, degraded: true, source: 'database_fallback_after_transient_error', retryable: true, warning: safeMessage });
    }

    return Response.json({ ok: false, error_type: refreshError?.error_type || 'token_refresh_failed', status_code: refreshError?.status_code, requires_reauthorization: requiresReauth, credentials_error: credentialsError, retryable: transient, active_token_source: activeTokenSource, env_fallback_attempted: shouldTryEnvFallback, message: safeMessage }, { status: transient ? 503 : 400 });

  } catch (error: any) {
    if (base44 && accountId && lockOwned) {
      await base44.asServiceRole.entities.AmazonAccount.update(accountId, { ads_token_refresh_in_progress: false, ads_token_refresh_started_at: null, ads_token_status: 'error', ads_token_last_error: String(error?.message || error).slice(0, 500) }).catch(() => {});
    }
    return Response.json({ ok: false, error_type: 'internal_error', error: String(error?.message || 'Erro interno no token manager').slice(0, 500) }, { status: 500 });
  }
});