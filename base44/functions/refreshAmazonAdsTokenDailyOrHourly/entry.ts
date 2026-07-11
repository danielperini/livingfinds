/**
 * refreshAmazonAdsTokenDailyOrHourly — watchdog de autorização Amazon Ads
 *
 * Mantém a integração operacional sem depender de usuário online.
 * - Executa por automação/service role.
 * - Processa contas com refresh_token válido mesmo após erro temporário.
 * - Prioriza AmazonAccount.ads_refresh_token; token de ambiente não é operacional.
 * - Repara lock de renovação preso.
 * - Faz retry com backoff somente para falhas temporárias.
 * - Nunca força reautorização por 429/5xx/timeouts.
 * - Registra heartbeat e diagnóstico sem apagar dados existentes.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const MAX_ACCOUNTS = 50;
const REFRESH_MARGIN_MINUTES = 15;
const STALE_LOCK_MS = 2 * 60 * 1000;
const RETRY_DELAYS_MS = [0, 2000, 6000];

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function hasValidRefreshToken(account: any): boolean {
  const token = String(account?.ads_refresh_token || '');
  return token.startsWith('Atzr|') && token.length >= 50;
}

function minutesUntil(dateValue: any): number | null {
  if (!dateValue) return null;
  const timestamp = new Date(dateValue).getTime();
  if (!Number.isFinite(timestamp)) return null;
  return (timestamp - Date.now()) / 60000;
}

function isTransient(result: any): boolean {
  const status = Number(result?.status_code || result?.status || 0);
  const type = String(result?.error_type || '');
  return result?.retryable === true
    || status === 429
    || status === 504
    || status === 524
    || status >= 500
    || type === 'temporary_network_error'
    || type === 'network_error'
    || type === 'timeout';
}

async function logWatchdog(base44: any, accountId: string, status: string, summary: any) {
  const now = new Date().toISOString();
  await base44.asServiceRole.entities.SyncExecutionLog.create({
    amazon_account_id: accountId,
    operation: 'amazon_ads:offline_auth_watchdog',
    status,
    trigger_type: 'automatic',
    started_at: now,
    completed_at: now,
    records_processed: status === 'success' ? 1 : 0,
    result_summary: status === 'success' ? JSON.stringify(summary).slice(0, 4000) : null,
    error_message: status === 'success' ? null : String(summary?.message || summary?.error || 'Falha no watchdog').slice(0, 500),
  }).catch(() => {});
}

Deno.serve(async (req) => {
  const startedAt = Date.now();

  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const isAutomation = req.headers.get('x-automation-trigger') === 'true';
    const isServiceRole = body._service_role === true;

    if (!isAutomation && !isServiceRole) {
      const user = await base44.auth.me().catch(() => null);
      if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    // Não filtrar apenas status=connected: uma falha temporária pode deixar a conta em error.
    // O refresh_token válido é a condição operacional para recuperação automática.
    const accounts = await base44.asServiceRole.entities.AmazonAccount.list('-updated_date', MAX_ACCOUNTS).catch(() => []);
    const eligibleAccounts = accounts.filter(hasValidRefreshToken);
    const results: any[] = [];

    for (const account of eligibleAccounts) {
      const accountId = account.id;
      const lockStartedAt = account.ads_token_refresh_started_at
        ? new Date(account.ads_token_refresh_started_at).getTime()
        : 0;
      const staleLock = account.ads_token_refresh_in_progress === true
        && (!Number.isFinite(lockStartedAt) || Date.now() - lockStartedAt > STALE_LOCK_MS);

      if (staleLock) {
        await base44.asServiceRole.entities.AmazonAccount.update(accountId, {
          ads_token_refresh_in_progress: false,
          ads_token_refresh_started_at: null,
          ads_token_status: 'checking',
          ads_token_last_error: null,
        }).catch(() => {});
      }

      const minutesLeft = minutesUntil(account.ads_access_token_expires_at);
      const needsRefresh = body.force_refresh === true
        || staleLock
        || minutesLeft === null
        || minutesLeft <= REFRESH_MARGIN_MINUTES
        || account.ads_token_status !== 'active'
        || account.status !== 'connected';

      if (!needsRefresh) {
        const heartbeatAt = new Date().toISOString();
        await base44.asServiceRole.entities.AmazonAccount.update(accountId, {
          ads_auth_watchdog_last_run_at: heartbeatAt,
          ads_auth_watchdog_status: 'healthy',
          ads_auth_watchdog_last_error: null,
        }).catch(() => {});

        results.push({
          account_id: accountId,
          ok: true,
          skipped: true,
          reason: 'token_still_valid',
          minutes_left: Math.round(minutesLeft || 0),
        });
        continue;
      }

      let finalResult: any = null;
      let attempts = 0;

      for (const delayMs of RETRY_DELAYS_MS) {
        if (delayMs > 0) await wait(delayMs);
        attempts += 1;

        try {
          const response = await base44.asServiceRole.functions.invoke('amazonAdsTokenManager', {
            amazon_account_id: accountId,
            force_refresh: true,
            _service_role: true,
          });
          finalResult = response?.data || response || {};
        } catch (error: any) {
          finalResult = {
            ok: false,
            error_type: 'invoke_error',
            retryable: true,
            message: String(error?.message || 'Falha ao invocar token manager').slice(0, 500),
          };
        }

        if (finalResult?.ok === true || !isTransient(finalResult)) break;
      }

      const now = new Date().toISOString();

      if (finalResult?.ok === true) {
        await base44.asServiceRole.entities.AmazonAccount.update(accountId, {
          status: 'connected',
          ads_token_status: 'active',
          ads_requires_reauth: false,
          ads_credentials_error: false,
          ads_auth_watchdog_last_run_at: now,
          ads_auth_watchdog_last_success_at: now,
          ads_auth_watchdog_status: 'healthy',
          ads_auth_watchdog_last_error: null,
          error_message: null,
        }).catch(() => {});

        const item = {
          account_id: accountId,
          ok: true,
          refreshed: true,
          attempts,
          expires_at: finalResult.expires_at,
          active_token_source: finalResult.active_token_source || 'database',
        };
        results.push(item);
        await logWatchdog(base44, accountId, 'success', item);
        continue;
      }

      const transient = isTransient(finalResult);
      const requiresReauth = finalResult?.requires_reauthorization === true;
      const credentialsError = finalResult?.credentials_error === true;
      const message = String(finalResult?.message || finalResult?.error_safe || finalResult?.error || 'Falha ao renovar autorização').slice(0, 500);

      const patch: any = {
        ads_auth_watchdog_last_run_at: now,
        ads_auth_watchdog_status: transient ? 'retry_pending' : requiresReauth ? 'reauthorization_required' : credentialsError ? 'credentials_error' : 'error',
        ads_auth_watchdog_last_error: message,
      };

      // Falha temporária não deve derrubar a integração nem exigir usuário online.
      if (!transient) {
        patch.ads_requires_reauth = requiresReauth;
        patch.ads_credentials_error = credentialsError;
        if (requiresReauth || credentialsError) {
          patch.status = 'error';
          patch.error_message = message;
        }
      }

      await base44.asServiceRole.entities.AmazonAccount.update(accountId, patch).catch(() => {});

      const item = {
        account_id: accountId,
        ok: false,
        attempts,
        transient,
        requires_reauthorization: requiresReauth,
        credentials_error: credentialsError,
        error_type: finalResult?.error_type,
        status_code: finalResult?.status_code,
        message,
      };
      results.push(item);
      await logWatchdog(base44, accountId, transient ? 'warning' : 'error', item);
    }

    const missingTokenAccounts = accounts.filter((account: any) => !hasValidRefreshToken(account)).length;
    const refreshed = results.filter((result) => result.ok && result.refreshed).length;
    const skipped = results.filter((result) => result.skipped).length;
    const retryPending = results.filter((result) => result.transient).length;
    const failed = results.filter((result) => !result.ok && !result.transient).length;

    return Response.json({
      ok: failed === 0,
      mode: 'offline_auth_watchdog',
      accounts_found: accounts.length,
      accounts_eligible: eligibleAccounts.length,
      accounts_without_valid_refresh_token: missingTokenAccounts,
      refreshed,
      skipped,
      retry_pending: retryPending,
      failed,
      results,
      duration_ms: Date.now() - startedAt,
    });
  } catch (error: any) {
    return Response.json({
      ok: false,
      error_type: 'internal_error',
      error: String(error?.message || 'Erro interno no watchdog Amazon Ads').slice(0, 500),
    }, { status: 500 });
  }
});