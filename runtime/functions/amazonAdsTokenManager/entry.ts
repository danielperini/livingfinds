/**
 * amazonAdsTokenManager v8 — fonte única de access token Amazon Ads.
 *
 * Hierarquia de refresh token:
 * 1. AmazonAccount.ads_refresh_token (DB)
 * 2. ADS_REFRESH_TOKEN do ambiente (fallback silencioso quando DB retorna unauthorized_client)
 *
 * Lock de concorrência via ads_token_refresh_in_progress + ads_token_refresh_started_at:
 * - Se outro processo iniciou refresh há menos de 60s → wait-and-retry 3x com 3s de delay
 * - Se token foi renovado por outro processo durante a espera → usar o novo token sem chamar LWA
 *
 * Buffer de 10min ao persistir expires_at para forçar renovação proativa antes do vencimento real.
 * Renovação proativa: renovar se expires_at - now < 15 minutos.
 * Fallback automático para ENV token antes de marcar como revogado.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const ACCESS_TOKEN_BUFFER_MS    = 10 * 60 * 1000; // subtrair 10min do expires_in ao persistir
const PROACTIVE_REFRESH_THRESHOLD_MS = 15 * 60 * 1000; // renovar proativamente se faltam <15min
const SAFETY_MARGIN_MS          = 2 * 60 * 1000;  // margem mínima para servir da cache
const LOCK_TTL_MS               = 60 * 1000;       // lock considerado morto após 60s
const CONCURRENCY_WAIT_MS       = 3000;            // delay entre tentativas de wait-and-retry
const CONCURRENCY_MAX_RETRIES   = 3;               // máximo 3 tentativas (9s total)
const RETRY_DELAYS_MS           = [0, 2000, 6000]; // retry LWA para erros transitórios

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function validRefreshToken(value: any) {
  const token = String(value || '').trim();
  return token.startsWith('Atzr|') && token.length >= 50;
}

function validAccessToken(account: any, marginMs = SAFETY_MARGIN_MS) {
  const token   = String(account?.ads_access_token || '').trim();
  const expires = new Date(account?.ads_access_token_expires_at || 0).getTime();
  return token.length > 20 && Number.isFinite(expires) && expires > Date.now() + marginMs;
}

import { sendDiscordAlert } from '../../shared/notify.ts';

function classifyLwaError(data: any, status: number) {
  const code        = String(data?.error || 'unknown');
  const description = String(data?.error_description || data?.message || data?.error || `HTTP ${status}`);
  if (code === 'invalid_client')
    return { error_type: 'credentials_error', message: description, status_code: status, amazon_error_code: code, credentials_error: true, requires_reauthorization: false, retryable: false };
  if (['invalid_grant', 'unauthorized_client', 'access_denied', 'authorization_code_used'].includes(code))
    return { error_type: 'invalid_grant', message: description, status_code: status, amazon_error_code: code, credentials_error: false, requires_reauthorization: true, retryable: false };
  if (status === 429 || status >= 500)
    return { error_type: 'temporary_network_error', message: description, status_code: status, amazon_error_code: code, credentials_error: false, requires_reauthorization: false, retryable: true };
  return { error_type: 'token_refresh_denied', message: description, status_code: status, amazon_error_code: code, credentials_error: false, requires_reauthorization: false, retryable: false };
}

async function requestAccessToken(refreshToken: string) {
  const clientId     = String(Deno.env.get('ADS_CLIENT_ID') || '');
  const clientSecret = String(Deno.env.get('ADS_CLIENT_SECRET') || '');
  if (!clientId || !clientSecret)
    throw { error_type: 'missing_credentials', message: 'ADS_CLIENT_ID ou ADS_CLIENT_SECRET não configurados', credentials_error: true, requires_reauthorization: false, retryable: false };

  const response = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw classifyLwaError(data, response.status);
  if (!data?.access_token)
    throw { error_type: 'token_refresh_denied', message: 'Amazon LWA não retornou access_token', credentials_error: false, requires_reauthorization: false, retryable: false };
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
    operation:         'amazon_ads:token_manager_v8',
    status,
    trigger_type:      'automatic',
    started_at:        now,
    completed_at:      now,
    records_processed: status === 'success' ? 1 : 0,
    result_summary:    status === 'success' ? JSON.stringify(summary).slice(0, 4000) : null,
    error_message:     status === 'success' ? null : String(summary?.message || summary?.error || 'Falha de token').slice(0, 500),
  }).catch(() => {});
}

async function persistSuccessfulToken(base44: any, accountId: string, tokenResult: any, source: string, envRefreshToken?: string) {
  const now = new Date().toISOString();
  // Buffer de 10min: salvar expires_at como (now + expires_in - 10min)
  const effectiveExpiresMs = tokenResult.expires_in * 1000 - ACCESS_TOKEN_BUFFER_MS;
  const expiresAt = new Date(Date.now() + Math.max(effectiveExpiresMs, 5 * 60 * 1000)).toISOString();
  const patch: any = {
    ads_access_token:             tokenResult.access_token,
    ads_access_token_expires_at:  expiresAt,
    ads_last_token_refresh_at:    now,
    ads_last_verified_at:         now,
    ads_token_refresh_in_progress: false,
    ads_token_refresh_started_at: null,
    ads_token_status:             'active',
    ads_token_last_error:         null,
    ads_requires_reauth:          false,
    ads_credentials_error:        false,
    ads_last_lwa_error_code:      null,
    ads_last_lwa_status_code:     null,
    ads_active_token_source:      source,
    status:                       'connected',
    error_message:                null,
  };
  if (source === 'environment_fallback' && envRefreshToken) {
    patch.ads_refresh_token       = envRefreshToken;
    patch.ads_last_recovery_source = 'environment_fallback';
    patch.ads_last_recovery_at    = now;
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
    if (body._service_role !== true)
      return Response.json({ ok: false, error: 'Uso interno apenas' }, { status: 403 });

    accountId = String(body.amazon_account_id || '');
    if (!accountId)
      return Response.json({ ok: false, error_type: 'missing_account_id', error: 'amazon_account_id obrigatório' }, { status: 400 });

    const forceRefresh = body.force_refresh === true;

    let account = await readAccount(base44, accountId);
    if (!account)
      return Response.json({ ok: false, error_type: 'account_not_found', error: 'Conta Amazon não encontrada' }, { status: 404 });

    const dbRefreshToken  = String(account.ads_refresh_token || '').trim();
    const envRefreshToken = String(Deno.env.get('ADS_REFRESH_TOKEN') || '').trim();
    const hasDbToken      = validRefreshToken(dbRefreshToken);
    const hasEnvToken     = validRefreshToken(envRefreshToken);
    const envIsDifferentFromDb = hasEnvToken && dbRefreshToken !== envRefreshToken;

    const refreshToken        = hasDbToken ? dbRefreshToken : hasEnvToken ? envRefreshToken : '';
    const activeTokenSource   = hasDbToken ? 'database' : hasEnvToken ? 'environment_fallback' : 'missing';
    const tokenConflict       = hasDbToken && hasEnvToken && dbRefreshToken !== envRefreshToken;

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

    // ── 1. Servir da cache se token ainda é válido com margem proativa ───────
    // (apenas quando NÃO é force_refresh)
    if (!forceRefresh && validAccessToken(account)) {
      const msUntilExpiry = new Date(account.ads_access_token_expires_at || 0).getTime() - Date.now();
      if (msUntilExpiry > PROACTIVE_REFRESH_THRESHOLD_MS) {
        // Token saudável — retornar direto da cache
        return Response.json({ ok: true, access_token: account.ads_access_token, expires_at: account.ads_access_token_expires_at, from_cache: true, source: 'database', active_token_source: activeTokenSource, token_source_conflict: tokenConflict });
      }
      // Faltam menos de 15min → prosseguir para renovação proativa
      console.log(`[TokenManager v8] Renovação proativa: faltam ${Math.round(msUntilExpiry / 60000)}min`);
    }

    // ── 2. Lock de concorrência via flags da entidade ─────────────────────────
    // Atua MESMO com force_refresh=true para evitar que instâncias paralelas do
    // watchdog chamem o LWA simultaneamente (a Amazon invalida o token anterior
    // a cada novo access_token, gerando "Not authorized" nas demais).
    const inProgress  = account.ads_token_refresh_in_progress === true;
    const startedAtLock = account.ads_token_refresh_started_at
      ? new Date(account.ads_token_refresh_started_at).getTime()
      : 0;
    const lockAge = Date.now() - startedAtLock;
    const lockIsAlive = inProgress && lockAge < LOCK_TTL_MS;

    if (lockIsAlive) {
      console.log(`[TokenManager v8] Outro refresh em andamento (${Math.round(lockAge / 1000)}s atrás). Aguardando...`);
      // Wait-and-retry: até 3 tentativas de 3s cada
      for (let attempt = 0; attempt < CONCURRENCY_MAX_RETRIES; attempt++) {
        await wait(CONCURRENCY_WAIT_MS);
        account = await readAccount(base44, accountId);
        // Com force_refresh: aceitar token renovado nos últimos 30s como suficiente
        const lastRefreshMs = account.ads_last_token_refresh_at
          ? Date.now() - new Date(account.ads_last_token_refresh_at).getTime()
          : Infinity;
        const freshEnough = lastRefreshMs < 30_000;
        if (validAccessToken(account, 60_000) && (freshEnough || !forceRefresh)) {
          console.log(`[TokenManager v8] Token renovado por outro processo na tentativa ${attempt + 1} (${Math.round(lastRefreshMs / 1000)}s atrás). Usando.`);
          return Response.json({ ok: true, access_token: account.ads_access_token, expires_at: account.ads_access_token_expires_at, from_cache: true, source: 'database_after_concurrent_wait', active_token_source: activeTokenSource });
        }
        // Verificar se o lock foi liberado
        const stillLocked = account.ads_token_refresh_in_progress === true
          && new Date(account.ads_token_refresh_started_at || 0).getTime() > startedAtLock - 1000;
        if (!stillLocked) break; // lock liberado — prosseguir normalmente
      }
      // Após espera: re-verificar cache uma última vez
      if (!forceRefresh && validAccessToken(account, 30_000)) {
        return Response.json({ ok: true, access_token: account.ads_access_token, expires_at: account.ads_access_token_expires_at, from_cache: true, source: 'database_after_wait_timeout', active_token_source: activeTokenSource });
      }
    }

    // ── 3. Adquirir lock: marcar refresh em andamento ─────────────────────────
    // Releitura final antes de marcar (evitar race entre o if acima e o update)
    account = await readAccount(base44, accountId);
    const stillInProgress   = account.ads_token_refresh_in_progress === true;
    const freshLockAge      = account.ads_token_refresh_started_at
      ? Date.now() - new Date(account.ads_token_refresh_started_at).getTime()
      : Infinity;
    if (stillInProgress && freshLockAge < LOCK_TTL_MS && !forceRefresh) {
      // Outro processo acabou de adquirir o lock → mais uma espera rápida
      await wait(CONCURRENCY_WAIT_MS);
      account = await readAccount(base44, accountId);
      if (validAccessToken(account, 30_000)) {
        return Response.json({ ok: true, access_token: account.ads_access_token, expires_at: account.ads_access_token_expires_at, from_cache: true, source: 'database_late_wait', active_token_source: activeTokenSource });
      }
    }

    await base44.asServiceRole.entities.AmazonAccount.update(accountId, {
      ads_token_refresh_in_progress: true,
      ads_token_refresh_started_at:  new Date().toISOString(),
    }).catch(() => {});
    lockOwned = true;

    // ── 4. Tentativa 1: token primário (DB ou ENV conforme hierarquia) ────────
    let tokenResult: any   = null;
    let refreshError: any  = null;

    for (const delay of RETRY_DELAYS_MS) {
      if (delay) await wait(delay);
      try {
        tokenResult   = await requestAccessToken(refreshToken);
        refreshError  = null;
        break;
      } catch (error: any) {
        refreshError = error;
        if (error?.retryable !== true) break;
      }
    }

    if (tokenResult) {
      const { access_token, expires_at } = await persistSuccessfulToken(base44, accountId, tokenResult, activeTokenSource);
      lockOwned = false;
      const msLeft = new Date(account.ads_access_token_expires_at || 0).getTime() - Date.now();
      await logEvent(base44, accountId, 'success', {
        source: msLeft > 0 ? 'proactive_refresh' : activeTokenSource,
        expires_at,
        margin_minutes: 10,
        triggered_by:   body.triggered_by || 'token_manager_v8',
        duration_ms:    Date.now() - startedAt,
      });
      return Response.json({ ok: true, access_token, expires_at, from_cache: false, source: 'lwa_refresh', active_token_source: activeTokenSource, token_source_conflict: tokenConflict, duration_ms: Date.now() - startedAt });
    }

    // ── 5. Tentativa 2: fallback silencioso para ENV token ────────────────────
    // Apenas quando DB falhou com invalid_grant E ENV é diferente do DB
    const isRevocationError   = refreshError?.error_type === 'invalid_grant' || refreshError?.amazon_error_code === 'unauthorized_client';
    const shouldTryEnvFallback = isRevocationError && hasDbToken && hasEnvToken && envIsDifferentFromDb;

    if (shouldTryEnvFallback) {
      console.log('[TokenManager v8] DB token rejeitado. Tentando fallback ENV automaticamente...');
      let envTokenResult: any  = null;
      let envRefreshError: any = null;

      for (const delay of RETRY_DELAYS_MS) {
        if (delay) await wait(delay);
        try {
          envTokenResult  = await requestAccessToken(envRefreshToken);
          envRefreshError = null;
          break;
        } catch (error: any) {
          envRefreshError = error;
          if (error?.retryable !== true) break;
        }
      }

      if (envTokenResult) {
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
            if (a.alert_type === 'token_expired' || a.alert_type === 'token_revoked')
              base44.asServiceRole.entities.Alert.update(a.id, { status: 'resolved', resolved_at: new Date().toISOString() }).catch(() => {});
          })).catch(() => {});
        return Response.json({ ok: true, access_token, expires_at, from_cache: false, source: 'lwa_refresh', active_token_source: 'environment_fallback', recovered_from_env_fallback: true, duration_ms: Date.now() - startedAt });
      }

      // Ambos falharam — usar o erro mais recente para diagnosticar
      refreshError = envRefreshError || refreshError;
    }

    // ── 6. Ambos os tokens falharam — registrar e retornar erro ──────────────
    const requiresReauth  = refreshError?.requires_reauthorization === true;
    const credentialsError = refreshError?.credentials_error === true;
    const transient       = refreshError?.retryable === true;
    const safeMessage     = String(refreshError?.message || 'Falha ao renovar token Amazon Ads').slice(0, 500);
    const stillUsable     = validAccessToken(account, 30_000);

    await base44.asServiceRole.entities.AmazonAccount.update(accountId, {
      ads_token_refresh_in_progress: false,
      ads_token_refresh_started_at:  null,
      ads_token_status:              transient && stillUsable ? 'active' : credentialsError ? 'credentials_error' : requiresReauth ? 'revoked' : 'error',
      ads_token_last_error:          safeMessage,
      ads_last_lwa_error_code:       refreshError?.amazon_error_code || refreshError?.error_type || 'token_refresh_failed',
      ads_last_lwa_status_code:      refreshError?.status_code || null,
      // Somente invalid_grant real seta reauth — erros transitórios nunca ativam
      ads_requires_reauth:           requiresReauth,
      ads_credentials_error:         credentialsError,
      ...(requiresReauth || credentialsError ? { status: 'error', error_message: safeMessage } : {}),
    }).catch(() => {});
    lockOwned = false;
    await logEvent(base44, accountId, transient ? 'warning' : 'error', refreshError || { message: safeMessage });

    // Alerta de reconexão (entregável #5: nunca cair "sem aviso"). Debounce: só na transição ok→reauth.
    if ((requiresReauth || credentialsError) && account?.ads_requires_reauth !== true) {
      await sendDiscordAlert({
        title: 'Amazon Ads exige reconexão',
        level: 'error',
        message: 'O token da API da Amazon Ads não pôde ser renovado automaticamente. ' +
          'É preciso reconectar a conta (reautorizar o app / atualizar o segredo LWA).',
        fields: [
          { name: 'Conta', value: String(account?.name || accountId) },
          { name: 'Erro', value: safeMessage.slice(0, 200) },
          { name: 'Código', value: String(refreshError?.amazon_error_code || refreshError?.error_type || 'n/d') },
        ],
        source: 'amazonAdsTokenManager',
      });
    }

    if (transient && stillUsable) {
      return Response.json({ ok: true, access_token: account.ads_access_token, expires_at: account.ads_access_token_expires_at, from_cache: true, degraded: true, source: 'database_fallback_after_transient_error', retryable: true, warning: safeMessage });
    }

    return Response.json({ ok: false, error_type: refreshError?.error_type || 'token_refresh_failed', status_code: refreshError?.status_code, requires_reauthorization: requiresReauth, credentials_error: credentialsError, retryable: transient, active_token_source: activeTokenSource, env_fallback_attempted: shouldTryEnvFallback, message: safeMessage }, { status: transient ? 503 : 400 });

  } catch (error: any) {
    if (base44 && accountId && lockOwned) {
      await base44.asServiceRole.entities.AmazonAccount.update(accountId, {
        ads_token_refresh_in_progress: false,
        ads_token_refresh_started_at:  null,
        ads_token_status:              'error',
        ads_token_last_error:          String(error?.message || error).slice(0, 500),
      }).catch(() => {});
    }
    return Response.json({ ok: false, error_type: 'internal_error', error: String(error?.message || 'Erro interno no token manager').slice(0, 500) }, { status: 500 });
  }
});