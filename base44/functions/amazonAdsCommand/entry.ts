/**
 * amazonAdsCommand v9 — Gateway centralizado Amazon Ads.
 *
 * Mantém os guardrails econômicos e de pausa existentes. Credenciais passam pelo
 * resolvedor canônico. O token manager nunca retorna token em JSON; este gateway
 * lê o access token persistido via service-role somente em memória.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { findPauseLockedProduct } from '../../shared/productCampaignPauseGuard.ts';
import { enforceBidCeilingOnPayload } from '../../shared/amazonBidCeiling.ts';
import { resolveWinnerKeywordCeilings } from '../../shared/winnerBidPolicy.ts';
import { loadConfiguredBidPolicy } from '../../shared/configuredBidPolicy.ts';
import {
  ADS_TOKEN_REVOKED_REAUTH_REQUIRED,
  adsBaseUrlForRegion,
  resolveAmazonAdsCredentials,
} from '../../shared/amazonCredentials.ts';

const ALLOWED_PATHS = [
  '/sp/campaigns', '/sp/campaigns/list', '/sp/adGroups', '/sp/adGroups/list',
  '/sp/productAds', '/sp/productAds/list', '/sp/keywords', '/sp/keywords/list',
  '/v2/sp/campaigns', '/v2/sp/adGroups', '/v2/sp/keywords', '/v2/sp/negativeKeywords',
  '/sp/negativeKeywords', '/sp/negativeKeywords/list', '/sp/targets', '/sp/targets/list',
  '/v2/sp/targets', '/adsApi/v1/create/targets', '/v2/profiles', '/reporting/reports',
];
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE']);
const SUCCESS_CODES = new Set(['SUCCESS', 'CREATED', 'UPDATED', 'OK', 'ACCEPTED', '200', '201', '202', '204']);

function normalizeAmazonError(value: any, fallbackCode = 'AMAZON_ITEM_ERROR'): any {
  if (typeof value === 'string') return { code: fallbackCode, message: value };
  if (!value || typeof value !== 'object') return { code: fallbackCode, message: String(value || fallbackCode) };
  return {
    code: String(value.code || value.errorCode || value.status || fallbackCode),
    message: String(value.description || value.message || value.error || JSON.stringify(value)).slice(0, 1000),
    index: value.index,
    details: value.details || null,
  };
}

function collectAmazonItemErrors(payload: any): any[] {
  if (!payload || typeof payload !== 'object') return [];
  const errors: any[] = [];
  const roots = ['campaigns', 'adGroups', 'productAds', 'keywords', 'negativeKeywords', 'targets', 'items'];
  const add = (value: any, fallbackCode?: string) => {
    if (Array.isArray(value)) {
      for (const item of value) add(item, fallbackCode);
      return;
    }
    if (value != null) errors.push(normalizeAmazonError(value, fallbackCode));
  };
  add(payload.errors, 'AMAZON_ERRORS');
  add(payload.error, 'AMAZON_ERROR');
  for (const root of roots) {
    const container = payload[root];
    if (!container) continue;
    if (Array.isArray(container)) {
      for (const item of container) {
        if (!item || typeof item !== 'object') continue;
        const code = String(item.code || item.status || '').toUpperCase();
        const hasExplicitError = Boolean(item.error || item.errors || item.errorCode);
        if (hasExplicitError || (code && !SUCCESS_CODES.has(code))) add(item, `${root.toUpperCase()}_ITEM_ERROR`);
      }
      continue;
    }
    if (typeof container === 'object') {
      add(container.errors, `${root.toUpperCase()}_ERRORS`);
      add(container.error, `${root.toUpperCase()}_ERROR`);
      add(container.failed, `${root.toUpperCase()}_FAILED`);
      if (Array.isArray(container.items)) {
        for (const item of container.items) {
          const code = String(item?.code || item?.status || '').toUpperCase();
          const hasExplicitError = Boolean(item?.error || item?.errors || item?.errorCode);
          if (hasExplicitError || (code && !SUCCESS_CODES.has(code))) add(item, `${root.toUpperCase()}_ITEM_ERROR`);
        }
      }
    }
  }
  const unique = new Map<string, any>();
  for (const error of errors) {
    const key = `${error.code}|${error.message}|${error.index ?? ''}`;
    if (!unique.has(key)) unique.set(key, error);
  }
  return [...unique.values()];
}

async function callAmazonApi(url: string, method: string, headers: Record<string, string>, payload: any, maxAttempts = 3) {
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  let lastResult: any = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      const response = await fetch(url, {
        method,
        headers,
        signal: controller.signal,
        body: payload == null || method === 'GET' ? undefined : JSON.stringify(payload),
      }).finally(() => clearTimeout(timeout));
      const text = await response.text().catch(() => '');
      let parsed: any = null;
      try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
      const httpOk = response.status >= 200 && response.status < 300;
      const itemErrors = httpOk ? collectAmazonItemErrors(parsed) : [];
      const ok = httpOk && itemErrors.length === 0;
      const retryable = [500, 502, 503].includes(response.status);
      const requestId = response.headers.get('x-amzn-RequestId') || response.headers.get('x-amz-request-id') || null;
      const errors = ok ? [] : itemErrors.length
        ? itemErrors
        : [{ code: String(response.status), message: text.slice(0, 1000) || `Amazon HTTP ${response.status}` }];
      lastResult = {
        ok,
        status: response.status,
        payload: parsed,
        request_id: requestId,
        retry_after: response.headers.get('Retry-After'),
        rate_limit: response.headers.get('x-amzn-RateLimit-Limit'),
        errors,
      };
      if (ok || itemErrors.length > 0 || !retryable || attempt === maxAttempts - 1) break;
      console.log(`[adsCommand] ${response.status} retryable — tentativa ${attempt + 1}/${maxAttempts}`);
      await wait(Math.min(1000 * Math.pow(2, attempt), 15000));
    } catch (error: any) {
      lastResult = { ok: false, status: 0, payload: null, request_id: null, errors: [{ code: 'NETWORK_ERROR', message: error?.message || String(error) }] };
      if (attempt === maxAttempts - 1) break;
      await wait(Math.min(2000 * Math.pow(2, attempt), 15000));
    }
  }
  return lastResult;
}

Deno.serve(async (request) => {
  const startedAt = Date.now();
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    if (!body._service_role) return Response.json({ ok: false, error: 'Uso interno' }, { status: 403 });
    if (!body.amazon_account_id || !body.path) return Response.json({ ok: false, error: 'amazon_account_id e path obrigatórios' }, { status: 400 });

    const method = String(body.method || 'GET').toUpperCase();
    const path = String(body.path || '');
    if (!ALLOWED_METHODS.has(method)) return Response.json({ ok: false, error: 'Método não permitido' }, { status: 400 });
    if (!ALLOWED_PATHS.some((allowed) => path === allowed || path.startsWith(`${allowed}?`) || path.startsWith(`${allowed}/`))) {
      return Response.json({ ok: false, error: 'Endpoint Ads não permitido' }, { status: 403 });
    }

    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1);
    const account = accounts[0];
    if (!account) return Response.json({ ok: false, error: 'Conta Amazon não encontrada' }, { status: 404 });

    const credentials = resolveAmazonAdsCredentials();
    const profileId = body.profile_id || account.ads_profile_id || credentials.profileId.value;
    if (!profileId && path !== '/v2/profiles') return Response.json({ ok: false, error: 'ads_profile_id não configurado' }, { status: 400 });
    const clientId = credentials.clientId.value;
    if (!clientId) return Response.json({ ok: false, error: 'ADS_CLIENT_ID não configurado na fonte canônica' }, { status: 500 });

    const url = `${adsBaseUrlForRegion(String(account.region || credentials.region || 'NA'))}${path}`;
    const adsAccountId = body.ads_account_id || account.ads_account_id || account.advertiser_account_id || credentials.accountId.value || null;
    const maxAttempts = Math.max(1, Math.min(5, Number(body.max_attempts || 3) || 3));

    const isBidMutation = ['POST', 'PUT'].includes(method) && ['/sp/keywords', '/sp/adGroups', 'targets'].some((segment) => path.includes(segment));
    const [winnerBid, configuredBid] = isBidMutation
      ? await Promise.all([
          resolveWinnerKeywordCeilings(base44, body.amazon_account_id, path, method, body.payload ?? null),
          loadConfiguredBidPolicy(base44, body.amazon_account_id),
        ])
      : [{ ceilings: {}, evidence: [] }, { ceiling: undefined, source: null }];
    let guardedPayload = enforceBidCeilingOnPayload(path, method, body.payload ?? null, winnerBid.ceilings, configuredBid.ceiling);

    if (path === '/sp/campaigns' && ['PUT', 'POST'].includes(method) && Array.isArray(guardedPayload?.campaigns)) {
      const enabling = guardedPayload.campaigns.filter((item: any) => String(item?.state || '').toUpperCase() === 'ENABLED' && item?.campaignId);
      if (enabling.length > 0) {
        const [localCampaigns, products] = await Promise.all([
          base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: body.amazon_account_id }, null, 3000).catch(() => []),
          base44.asServiceRole.entities.Product.filter({ amazon_account_id: body.amazon_account_id }, null, 2000).catch(() => []),
        ]);
        const blockedIds = new Set<string>();
        for (const item of enabling) {
          const local = localCampaigns.find((campaign: any) =>
            String(campaign.campaign_id || '') === String(item.campaignId) || String(campaign.amazon_campaign_id || '') === String(item.campaignId)
          ) || { campaign_id: String(item.campaignId) };
          if (findPauseLockedProduct(products, local)) blockedIds.add(String(item.campaignId));
        }
        if (blockedIds.size > 0) {
          guardedPayload = { ...guardedPayload, campaigns: guardedPayload.campaigns.filter((item: any) => !blockedIds.has(String(item?.campaignId))) };
          if (guardedPayload.campaigns.length === 0) {
            return Response.json({
              ok: false,
              status: 409,
              blocked: true,
              error: 'PRODUCT_CAMPAIGN_PAUSE_LOCK',
              blocked_campaign_ids: [...blockedIds],
              message: 'Reativação bloqueada: o produto permanece pausado.',
            }, { status: 409 });
          }
        }
      }
    }

    async function buildHeaders(forceRefresh = false): Promise<Record<string, string>> {
      const tokenResponse = await base44.asServiceRole.functions.invoke('amazonAdsTokenManager', {
        amazon_account_id: body.amazon_account_id,
        force_refresh: forceRefresh,
        _service_role: true,
        triggered_by: 'amazonAdsCommand',
      });
      const tokenState = tokenResponse?.data || tokenResponse || {};
      if (!tokenState.ok || tokenState.token_available !== true) {
        const reauth = tokenState.requires_reauthorization === true || tokenState.error_type === ADS_TOKEN_REVOKED_REAUTH_REQUIRED;
        throw {
          tokenError: true,
          error_type: reauth ? ADS_TOKEN_REVOKED_REAUTH_REQUIRED : (tokenState.error_type || 'token_unavailable'),
          amazon_error_code: tokenState.amazon_error_code,
          message: tokenState.message || 'Falha ao preparar token Amazon Ads',
          requires_reauthorization: reauth,
          credentials_error: tokenState.credentials_error,
          retryable: tokenState.retryable,
        };
      }

      const freshAccounts = await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1).catch(() => []);
      const accessToken = String(freshAccounts[0]?.ads_access_token || '').trim();
      if (!accessToken) {
        throw {
          tokenError: true,
          error_type: 'ADS_ACCESS_TOKEN_STORE_EMPTY',
          message: 'Token manager confirmou disponibilidade, mas o access token não foi encontrado no armazenamento interno.',
          requires_reauthorization: false,
          credentials_error: false,
          retryable: true,
        };
      }

      const headers: Record<string, string> = {
        Authorization: `Bearer ${accessToken}`,
        'Amazon-Advertising-API-ClientId': clientId,
        'Content-Type': body.content_type || 'application/json',
        Accept: body.accept || body.content_type || 'application/json',
      };
      if (profileId) headers['Amazon-Advertising-API-Scope'] = String(profileId);
      if (adsAccountId) headers['Amazon-Ads-AccountId'] = String(adsAccountId);
      return headers;
    }

    const tokenExpiresAt = account.ads_access_token_expires_at ? new Date(account.ads_access_token_expires_at).getTime() : 0;
    if (tokenExpiresAt > 0 && tokenExpiresAt - Date.now() < 10 * 60 * 1000) {
      await base44.asServiceRole.functions.invoke('amazonAdsTokenManager', {
        amazon_account_id: body.amazon_account_id,
        force_refresh: true,
        _service_role: true,
        triggered_by: 'amazonAdsCommand_proactive_refresh',
      }).catch(() => {});
    }

    let headers = await buildHeaders(false);
    let result = await callAmazonApi(url, method, headers, guardedPayload, maxAttempts);
    if (result.status === 401 || result.status === 403) {
      try {
        headers = await buildHeaders(true);
        result = await callAmazonApi(url, method, headers, guardedPayload, 1);
        if (result.status === 401 || result.status === 403) {
          await base44.asServiceRole.entities.AmazonAccount.update(account.id, {
            ads_token_status: 'revoked',
            ads_requires_reauth: true,
            ads_credentials_error: false,
            ads_token_last_error: `401/403 após refresh em ${method} ${path}`,
            status: 'error',
            error_message: 'Reautorização necessária: Amazon Ads retornou 401/403 após refresh do token.',
          }).catch(() => {});
          return Response.json({
            ok: false,
            status: result.status,
            error: ADS_TOKEN_REVOKED_REAUTH_REQUIRED,
            error_type: ADS_TOKEN_REVOKED_REAUTH_REQUIRED,
            requires_reauthorization: true,
            message: 'Sua autorização Amazon Ads expirou ou foi revogada. Reautorize em /amazon-oauth-setup.',
          }, { status: 401 });
        }
      } catch (tokenError: any) {
        if (tokenError.tokenError) {
          return Response.json({
            ok: false,
            error_type: tokenError.error_type,
            amazon_error_code: tokenError.amazon_error_code,
            message: tokenError.message,
            requires_reauthorization: tokenError.requires_reauthorization,
            credentials_error: tokenError.credentials_error,
            retryable: tokenError.retryable,
          }, { status: tokenError.credentials_error ? 400 : 401 });
        }
        throw tokenError;
      }
    }

    if (result.status === 429) {
      const retryAfter = Number(result.retry_after || body.retry_after_seconds || 60) || 60;
      await base44.asServiceRole.entities.SyncExecutionLog.create({
        amazon_account_id: account.id,
        operation: `amazon_api:rate_limit:${method}:${path}`,
        status: 'skipped_limit',
        trigger_type: 'automatic',
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        records_processed: 0,
        error_message: `Rate limit Amazon Ads (429). Retry-After=${retryAfter}`,
      }).catch(() => {});
      return Response.json({
        ok: false,
        status: 429,
        rate_limited: true,
        retryable: true,
        request_id: result.request_id,
        retry_after_seconds: retryAfter,
        message: 'A Amazon limitou a taxa de requisições; a ação deve ser reagendada.',
      });
    }

    if (result.status === 504 || result.status === 524) {
      await base44.asServiceRole.entities.SyncExecutionLog.create({
        amazon_account_id: account.id,
        operation: `amazon_api:async_reschedule:${method}:${path}`,
        status: 'pending',
        trigger_type: 'gateway',
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        records_processed: 0,
        error_message: `Amazon timeout HTTP ${result.status}; reagendamento assíncrono necessário`,
        result_summary: JSON.stringify({ endpoint: path, request_id: result.request_id, retry_after_seconds: 300 }).slice(0, 1000),
      }).catch(() => {});
      return Response.json({
        ok: false,
        status: result.status,
        retryable: true,
        reschedule_async: true,
        retry_after_seconds: 300,
        request_id: result.request_id,
        message: `Amazon retornou timeout ${result.status}; a operação deve ser reagendada sem bloquear o ciclo.`,
      });
    }

    if (!result.ok) {
      await base44.asServiceRole.entities.SyncExecutionLog.create({
        amazon_account_id: account.id,
        operation: `amazon_api:${body.operation || `${method}:${path}`}`,
        status: 'error',
        trigger_type: 'gateway',
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        records_processed: 0,
        error_message: String(result.errors?.[0]?.message || `Amazon HTTP ${result.status}`).slice(0, 1000),
        result_summary: JSON.stringify({ status: result.status, request_id: result.request_id, item_errors: result.errors }).slice(0, 4000),
      }).catch(() => {});
    }

    return Response.json({
      ok: result.ok,
      status: result.status,
      payload: result.payload,
      request_id: result.request_id,
      errors: result.errors,
      multi_status_validated: result.status === 207,
      winner_bid_exceptions: winnerBid.evidence,
      configured_bid_ceiling: configuredBid.ceiling,
      settings_source: configuredBid.source,
      duration_ms: Date.now() - startedAt,
    });
  } catch (error: any) {
    if (error?.tokenError) {
      return Response.json({
        ok: false,
        error_type: error.error_type,
        amazon_error_code: error.amazon_error_code,
        message: error.message,
        requires_reauthorization: error.requires_reauthorization,
        credentials_error: error.credentials_error,
        retryable: error.retryable,
      }, { status: error.credentials_error ? 400 : 401 });
    }
    return Response.json({ ok: false, error: error?.message?.slice(0, 500) || 'Erro no comando Amazon Ads' }, { status: 500 });
  }
});
