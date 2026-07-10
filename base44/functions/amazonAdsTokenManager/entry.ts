/**
 * amazonAdsTokenManager v5 — Renovação profissional de tokens Amazon Ads
 *
 * Fonte única do refresh_token: AmazonAccount.ads_refresh_token.
 * ADS_REFRESH_TOKEN no ambiente é apenas migração/diagnóstico; não é usado operacionalmente.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const memCache: Map<string, { access_token: string; expires_at: number }> = new Map();

function isExpiringSoon(expiresAt: string | undefined | null, marginSeconds = 300): boolean {
  if (!expiresAt) return true;
  const expMs = new Date(expiresAt).getTime();
  if (!Number.isFinite(expMs)) return true;
  return expMs - Date.now() < marginSeconds * 1000;
}

function tokenGeneration(account: any): string {
  return String(account.ads_token_generation || account.ads_refresh_token_updated_at || account.updated_at || 'legacy');
}

function cacheKey(accountId: string, generation: string): string {
  return `${accountId}:${generation}`;
}

function classifyLwaError(data: any, status: number) {
  const code = String(data?.error || 'unknown');
  const description = String(data?.error_description || data?.message || data?.error || `HTTP ${status}`);

  if (code === 'invalid_client') {
    return {
      error_type: 'credentials_error',
      message: 'ADS_CLIENT_ID ou ADS_CLIENT_SECRET inválidos para este refresh_token',
      amazon_error_code: code,
      status_code: status,
      requires_reauthorization: false,
      credentials_error: true,
      retryable: false,
      safe_message: description,
    };
  }

  if (['invalid_grant', 'unauthorized_client', 'access_denied', 'authorization_code_used'].includes(code)) {
    return {
      error_type: 'invalid_grant',
      message: description,
      amazon_error_code: code,
      status_code: status,
      requires_reauthorization: true,
      credentials_error: false,
      retryable: false,
      safe_message: description,
    };
  }

  if (status === 429 || status >= 500) {
    return {
      error_type: 'temporary_network_error',
      message: description,
      amazon_error_code: code,
      status_code: status,
      requires_reauthorization: false,
      credentials_error: false,
      retryable: true,
      safe_message: description,
    };
  }

  return {
    error_type: 'token_refresh_denied',
    message: description,
    amazon_error_code: code,
    status_code: status,
    requires_reauthorization: false,
    credentials_error: false,
    retryable: false,
    safe_message: description,
  };
}

async function fetchAccessToken(refreshToken: string): Promise<{ access_token: string; expires_in: number }> {
  const clientId = Deno.env.get('ADS_CLIENT_ID') || '';
  const clientSecret = Deno.env.get('ADS_CLIENT_SECRET') || '';

  if (!clientId || !clientSecret) {
    throw {
      error_type: 'missing_credentials',
      message: 'ADS_CLIENT_ID ou ADS_CLIENT_SECRET não configurados',
      requires_reauthorization: false,
      credentials_error: true,
      retryable: false,
    };
  }

  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const classified = classifyLwaError(data, res.status);
    console.error(`[tokenManager] Amazon LWA error: ${classified.amazon_error_code} | HTTP ${res.status} | ${classified.safe_message}`);
    throw classified;
  }

  if (!data?.access_token) {
    throw {
      error_type: 'token_refresh_denied',
      message: 'Amazon LWA não retornou access_token',
      requires_reauthorization: false,
      credentials_error: false,
      retryable: false,
    };
  }

  return { access_token: data.access_token, expires_in: Number(data.expires_in || 3600) };
}

async function logTokenEvent(base44: any, accountId: string, event: {
  success: boolean;
  error_type?: string;
  error_message?: string;
  status_code?: number;
}) {
  await base44.asServiceRole.entities.SyncExecutionLog.create({
    amazon_account_id: accountId,
    operation: `token:${event.success ? 'token_refresh_success' : (event.error_type || 'token_refresh_failed')}`,
    status: event.success ? 'success' : 'error',
    trigger_type: 'automatic',
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    records_processed: event.success ? 1 : 0,
    error_message: event.error_message ? event.error_message.slice(0, 500) : null,
  }).catch(() => {});
}

Deno.serve(async (req) => {
  const t0 = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    if (!body._service_role) {
      return Response.json({ ok: false, error: 'Uso interno apenas' }, { status: 403 });
    }

    const accountId = body.amazon_account_id;
    if (!accountId) {
      return Response.json({ ok: false, error_type: 'missing_account_id', error: 'amazon_account_id obrigatório' }, { status: 400 });
    }

    const forceRefresh = body.force_refresh === true;
    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ id: accountId }, null, 1);
    const account = accounts[0];

    if (!account) {
      return Response.json({ ok: false, error_type: 'account_not_found', error: 'Conta Amazon não encontrada' }, { status: 404 });
    }

    const dbRefreshToken = String(account.ads_refresh_token || '');
    const envRefreshToken = String(Deno.env.get('ADS_REFRESH_TOKEN') || '');
    const activeTokenSource = dbRefreshToken ? 'database' : 'missing';
    const tokenConflict = !!(dbRefreshToken && envRefreshToken && dbRefreshToken !== envRefreshToken);
    const generation = tokenGeneration(account);
    const key = cacheKey(accountId, generation);

    if (!dbRefreshToken || !dbRefreshToken.startsWith('Atzr|') || dbRefreshToken.length < 50) {
      await base44.asServiceRole.entities.AmazonAccount.update(accountId, {
        ads_token_status: 'missing',
        ads_requires_reauth: true,
        ads_token_last_error: 'refresh_token ausente ou inválido no banco',
        ads_active_token_source: activeTokenSource,
        ads_env_token_present: !!envRefreshToken,
        ads_token_source_conflict: tokenConflict,
      }).catch(() => {});

      return Response.json({
        ok: false,
        error_type: 'missing_refresh_token',
        requires_reauthorization: true,
        active_token_source: activeTokenSource,
        env_token_present: !!envRefreshToken,
        token_source_conflict: tokenConflict,
        message: 'Sua autorização Amazon expirou, foi revogada ou não há refresh_token válido no banco. Clique em Reconectar Amazon Ads.',
      });
    }

    if (!forceRefresh) {
      const mem = memCache.get(key);
      if (mem && mem.expires_at > Date.now() + 300000) {
        return Response.json({
          ok: true,
          access_token: mem.access_token,
          expires_at: new Date(mem.expires_at).toISOString(),
          from_cache: true,
          source: 'memory',
          token_generation: generation,
          active_token_source: activeTokenSource,
          env_token_present: !!envRefreshToken,
          token_source_conflict: tokenConflict,
        });
      }
    }

    const lockAge = account.ads_token_refresh_started_at
      ? Date.now() - new Date(account.ads_token_refresh_started_at).getTime()
      : Infinity;
    const lockActive = account.ads_token_refresh_in_progress === true && lockAge < 60000;

    if (lockActive && !forceRefresh) {
      await new Promise((r) => setTimeout(r, 3000));
      const refreshed = await base44.asServiceRole.entities.AmazonAccount.filter({ id: accountId }, null, 1);
      const updatedAccount = refreshed[0];
      const updatedGeneration = tokenGeneration(updatedAccount || account);
      const updatedKey = cacheKey(accountId, updatedGeneration);
      const mem2 = memCache.get(updatedKey);

      if (updatedAccount && mem2 && mem2.expires_at > Date.now() + 60000 && !isExpiringSoon(updatedAccount.ads_access_token_expires_at, 60)) {
        return Response.json({
          ok: true,
          access_token: mem2.access_token,
          expires_at: new Date(mem2.expires_at).toISOString(),
          from_cache: true,
          source: 'memory_after_lock_wait',
          token_generation: updatedGeneration,
        });
      }
    }

    await base44.asServiceRole.entities.AmazonAccount.update(accountId, {
      ads_token_refresh_in_progress: true,
      ads_token_refresh_started_at: new Date().toISOString(),
      ads_token_status: 'refreshing',
      ads_active_token_source: activeTokenSource,
      ads_env_token_present: !!envRefreshToken,
      ads_token_source_conflict: tokenConflict,
    }).catch(() => {});

    let tokenResult: { access_token: string; expires_in: number } | null = null;
    let refreshError: any = null;

    try {
      tokenResult = await fetchAccessToken(dbRefreshToken);
    } catch (err: any) {
      refreshError = err;
    }

    if (tokenResult) {
      const expiresAt = new Date(Date.now() + (Math.max(tokenResult.expires_in, 600) - 300) * 1000).toISOString();

      await base44.asServiceRole.entities.AmazonAccount.update(accountId, {
        ads_token_refresh_in_progress: false,
        ads_token_refresh_started_at: null,
        ads_token_status: 'active',
        ads_access_token_expires_at: expiresAt,
        ads_last_token_refresh_at: new Date().toISOString(),
        ads_token_last_error: null,
        ads_requires_reauth: false,
        ads_credentials_error: false,
        ads_last_lwa_error_code: null,
        ads_active_token_source: activeTokenSource,
        ads_env_token_present: !!envRefreshToken,
        ads_token_source_conflict: tokenConflict,
        status: 'connected',
        error_message: null,
      }).catch(() => {});

      memCache.set(key, {
        access_token: tokenResult.access_token,
        expires_at: new Date(expiresAt).getTime(),
      });

      await logTokenEvent(base44, accountId, { success: true });

      return Response.json({
        ok: true,
        access_token: tokenResult.access_token,
        expires_at: expiresAt,
        from_cache: false,
        duration_ms: Date.now() - t0,
        token_generation: generation,
        active_token_source: activeTokenSource,
        env_token_present: !!envRefreshToken,
        token_source_conflict: tokenConflict,
      });
    }

    const errType = refreshError?.error_type || 'token_refresh_failed';
    const safeMsg = String(refreshError?.safe_message || refreshError?.message || 'Erro desconhecido').slice(0, 300);
    const requiresReauth = refreshError?.requires_reauthorization === true;
    const credentialsError = refreshError?.credentials_error === true;

    await base44.asServiceRole.entities.AmazonAccount.update(accountId, {
      ads_token_refresh_in_progress: false,
      ads_token_refresh_started_at: null,
      ads_token_status: credentialsError ? 'credentials_error' : requiresReauth ? 'revoked' : 'error',
      ads_token_last_error: safeMsg,
      ads_last_lwa_error_code: refreshError?.amazon_error_code || errType,
      ads_last_lwa_status_code: refreshError?.status_code || null,
      ads_requires_reauth: requiresReauth,
      ads_credentials_error: credentialsError,
      ads_active_token_source: activeTokenSource,
      ads_env_token_present: !!envRefreshToken,
      ads_token_source_conflict: tokenConflict,
      ...(requiresReauth || credentialsError
        ? { status: 'error', error_message: (credentialsError ? 'Erro de credenciais: ' : 'Reautorização necessária: ') + safeMsg }
        : {}),
    }).catch(() => {});

    await logTokenEvent(base44, accountId, {
      success: false,
      error_type: errType,
      error_message: `[${refreshError?.amazon_error_code || errType}] ${safeMsg}`,
      status_code: refreshError?.status_code,
    });

    return Response.json({
      ok: false,
      error_type: errType,
      amazon_error_code: refreshError?.amazon_error_code,
      status_code: refreshError?.status_code,
      requires_reauthorization: requiresReauth,
      credentials_error: credentialsError,
      retryable: refreshError?.retryable === true,
      active_token_source: activeTokenSource,
      env_token_present: !!envRefreshToken,
      token_source_conflict: tokenConflict,
      message: credentialsError
        ? 'Credenciais Amazon Ads inválidas. Corrija ADS_CLIENT_ID e ADS_CLIENT_SECRET nos Secrets.'
        : requiresReauth
          ? 'Sua autorização Amazon expirou ou foi revogada. Clique em Reconectar Amazon Ads.'
          : 'Conexão com a Amazon instável. Vamos tentar novamente em instantes.',
      error_safe: safeMsg,
      duration_ms: Date.now() - t0,
    });

  } catch (error: any) {
    return Response.json({
      ok: false,
      error_type: 'internal_error',
      error: String(error?.message || 'Erro interno no token manager').slice(0, 300),
    }, { status: 500 });
  }
});
