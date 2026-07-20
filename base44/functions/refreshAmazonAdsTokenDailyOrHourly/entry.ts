/**
 * refreshAmazonAdsTokenDailyOrHourly — watchdog de autorização Amazon Ads
 *
 * Agendamento obrigatório no Base44: a cada 40 minutos.
 * Cada execução programada força um refresh real do access token.
 * O refresh token persistido em AmazonAccount.ads_refresh_token continua sendo
 * a autorização duradoura; intervenção humana só ocorre quando a Amazon retorna
 * revogação real/invalid_grant ou quando as credenciais do aplicativo são inválidas.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const MAX_ACCOUNTS = 50;
const STALE_LOCK_MS = 2 * 60 * 1000;
const RETRY_DELAYS_MS = [0, 2000, 6000];
const SCHEDULE_INTERVAL_MINUTES = 40;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function hasValidRefreshToken(account: any): boolean {
  const token = String(account?.ads_refresh_token || '');
  return token.startsWith('Atzr|') && token.length >= 50;
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
    || type === 'timeout'
    || type === 'invoke_error';
}

async function logWatchdog(base44: any, accountId: string, success: boolean, summary: any) {
  const now = new Date().toISOString();
  await base44.asServiceRole.entities.SyncExecutionLog.create({
    amazon_account_id: accountId,
    operation: 'amazon_ads:offline_auth_watchdog_40m',
    status: success ? 'success' : 'error',
    trigger_type: 'automatic',
    started_at: now,
    completed_at: now,
    records_processed: success ? 1 : 0,
    result_summary: success ? JSON.stringify(summary).slice(0, 4000) : null,
    error_message: success
      ? null
      : String(summary?.message || summary?.error || 'Falha no watchdog Amazon Ads').slice(0, 500),
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
      if (!user) {
        return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
      }
    }

    // Nunca limitar a status=connected. Uma falha temporária não pode remover a
    // conta dos ciclos futuros e obrigar o usuário a abrir o aplicativo.
    const accounts = await base44.asServiceRole.entities.AmazonAccount
      .list('-updated_date', MAX_ACCOUNTS)
      .catch(() => []);
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

      // Toda execução de 40 minutos renova de verdade. Não confiar apenas no
      // horário salvo do access token, pois instâncias diferentes não compartilham cache.
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
          ads_last_verified_at: now,
          ads_token_last_error: null,
          error_message: null,
        }).catch(() => {});

        // AUTO-RECOVERY: limpar alertas ativos de token para esta conta
        try {
          const tokenAlerts = await base44.asServiceRole.entities.Alert.filter({
            amazon_account_id: accountId,
            status: 'active',
          }, '-created_at', 10);
          for (const a of tokenAlerts) {
            if (a.alert_type === 'token_expired' || a.alert_type === 'token_revoked') {
              await base44.asServiceRole.entities.Alert.update(a.id, {
                status: 'resolved',
                resolved_at: now,
              }).catch(() => {});
            }
          }
        } catch { /* não bloquear o fluxo */ }

        const item = {
          account_id: accountId,
          ok: true,
          refreshed: true,
          attempts,
          expires_at: finalResult.expires_at,
          active_token_source: finalResult.active_token_source || 'database',
          next_refresh_recommended_at: new Date(Date.now() + SCHEDULE_INTERVAL_MINUTES * 60000).toISOString(),
        };
        results.push(item);
        await logWatchdog(base44, accountId, true, item);
        continue;
      }

      const transient = isTransient(finalResult);
      const requiresReauth = finalResult?.requires_reauthorization === true;
      const credentialsError = finalResult?.credentials_error === true;
      const message = String(
        finalResult?.message
        || finalResult?.error_safe
        || finalResult?.error
        || 'Falha ao renovar autorização Amazon Ads',
      ).slice(0, 500);

      const patch: any = {
        ads_last_verified_at: now,
        ads_token_last_error: message,
      };

      // 429, 5xx, 504, 524 e timeout não revogam a conexão. O próximo ciclo
      // automático tentará novamente sem depender de intervenção humana.
      if (!transient) {
        // Se requiresReauth mas o token ENV está disponível, o tokenManager já
        // tentou o fallback. Se ele retornou ok=false, significa que ambos
        // falharam e aí sim marcar reauth. Se a conta já tem env token presente,
        // aguardar o resultado real do tokenManager antes de forçar reauth.
        const envTokenPresent = account?.ads_env_token_present === true || !!String(Deno.env.get('ADS_REFRESH_TOKEN') || '').trim().startsWith('Atzr|');
        const skipReauthFlag = requiresReauth && envTokenPresent && finalResult?.recovered_from_env_fallback !== true;

        patch.ads_requires_reauth = skipReauthFlag ? false : requiresReauth;
        patch.ads_credentials_error = credentialsError;
        patch.ads_token_status = credentialsError
          ? 'credentials_error'
          : requiresReauth
            ? 'revoked'
            : 'error';

        if ((requiresReauth && !skipReauthFlag) || credentialsError) {
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
        human_intervention_required: requiresReauth || credentialsError,
        error_type: finalResult?.error_type,
        status_code: finalResult?.status_code,
        message,
      };
      results.push(item);
      await logWatchdog(base44, accountId, false, item);
    }

    const missingTokenAccounts = accounts.filter((account: any) => !hasValidRefreshToken(account)).length;
    const refreshed = results.filter((result) => result.ok && result.refreshed).length;
    const retryPending = results.filter((result) => result.transient).length;
    const humanInterventionRequired = results.filter((result) => result.human_intervention_required).length;
    const failed = results.filter((result) => !result.ok && !result.transient).length;

    return Response.json({
      ok: failed === 0,
      mode: 'offline_auth_watchdog_40m',
      schedule_interval_minutes: SCHEDULE_INTERVAL_MINUTES,
      accounts_found: accounts.length,
      accounts_eligible: eligibleAccounts.length,
      accounts_without_valid_refresh_token: missingTokenAccounts,
      refreshed,
      retry_pending: retryPending,
      human_intervention_required: humanInterventionRequired,
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