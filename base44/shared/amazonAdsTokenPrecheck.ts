import {
  ADS_TOKEN_PRECHECK_FAILED,
  ADS_TOKEN_REVOKED_REAUTH_REQUIRED,
  getAmazonAdsAuthFailure,
} from './amazonAdsAuthPolicy.ts';

type AdsTokenPrecheckResult = {
  ok: boolean;
  error: string | null;
  httpStatus: number;
  authFailure: boolean;
  details: any;
};

function unwrapInvokeError(error: any): any {
  const remote = error?.response?.data;
  if (remote && typeof remote === 'object') {
    return {
      ...remote,
      status_code: remote.status_code ?? error?.response?.status ?? null,
    };
  }
  return {
    ok: false,
    status_code: error?.response?.status ?? null,
    error: error?.message || String(error),
  };
}

function alertPayload(accountId: string, sourceFunction: string, resolved = false) {
  return {
    amazon_account_id: accountId,
    alert_type: 'amazon_ads_token_revoked',
    alert_family: 'token',
    severity: 'high',
    entity_type: 'account',
    entity_id: accountId,
    title: 'Token Amazon Ads revogado',
    message: resolved
      ? 'A autorização Amazon Ads voltou a ser válida.'
      : 'O token Amazon Ads não pôde ser renovado. Reautorize a conta antes de executar o motor.',
    source_function: sourceFunction,
    resolved,
    resolution_reason: resolved ? 'amazon_ads_token_valid_again' : '',
  };
}

export async function upsertAmazonAdsTokenRevokedAlert(
  base44: any,
  accountId: string,
  sourceFunction: string,
  details?: unknown,
): Promise<void> {
  await base44.asServiceRole.functions.invoke('upsertOperationalAlert', {
    ...alertPayload(accountId, sourceFunction, false),
    details: JSON.stringify(details || {}).slice(0, 4000),
    _service_role: true,
  }).catch(() => {});
}

export async function resolveAmazonAdsTokenRevokedAlert(
  base44: any,
  accountId: string,
  sourceFunction: string,
): Promise<void> {
  await base44.asServiceRole.functions.invoke('upsertOperationalAlert', {
    ...alertPayload(accountId, sourceFunction, true),
    _service_role: true,
  }).catch(() => {});
}

export async function runAmazonAdsTokenPrecheck(
  base44: any,
  accountId: string,
  sourceFunction: string,
): Promise<AdsTokenPrecheckResult> {
  let details: any;
  try {
    const response = await base44.asServiceRole.functions.invoke('amazonAdsTokenManager', {
      amazon_account_id: accountId,
      _service_role: true,
      force_refresh: true,
      triggered_by: sourceFunction,
    });
    details = response?.data || response || {};
  } catch (error: any) {
    details = unwrapInvokeError(error);
  }

  const accessToken = String(details?.access_token || '').trim();
  if (details?.ok === true && accessToken.length > 20) {
    await resolveAmazonAdsTokenRevokedAlert(base44, accountId, sourceFunction);
    return { ok: true, error: null, httpStatus: 200, authFailure: false, details };
  }

  const authFailure = getAmazonAdsAuthFailure(details);
  if (authFailure) {
    await upsertAmazonAdsTokenRevokedAlert(base44, accountId, sourceFunction, details);
    return {
      ok: false,
      error: ADS_TOKEN_REVOKED_REAUTH_REQUIRED,
      httpStatus: 424,
      authFailure: true,
      details,
    };
  }

  return {
    ok: false,
    error: ADS_TOKEN_PRECHECK_FAILED,
    httpStatus: Number(details?.status_code || 503) >= 500 ? 503 : 424,
    authFailure: false,
    details,
  };
}

export async function logTokenPrecheckFailure(
  base44: any,
  params: {
    accountId: string;
    operation: string;
    triggerType: string;
    startedAt: string;
    startedMs: number;
    error: string;
    details?: unknown;
  },
): Promise<void> {
  const completedAt = new Date().toISOString();
  await base44.asServiceRole.entities.SyncExecutionLog.create({
    amazon_account_id: params.accountId,
    operation: params.operation,
    trigger_type: params.triggerType,
    status: 'failed',
    execution_date: completedAt.slice(0, 10),
    started_at: params.startedAt,
    completed_at: completedAt,
    duration_ms: Date.now() - params.startedMs,
    records_processed: 0,
    error_message: params.error,
    result_summary: JSON.stringify({ token_precheck: params.details || null }).slice(0, 4000),
  }).catch(() => {});
}

