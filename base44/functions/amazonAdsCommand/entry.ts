/**
 * amazonAdsCommand v6 — Gateway centralizado Amazon Ads
 *
 * Melhorias v6:
 * - Retry automático em 502/503 com backoff exponencial (até 3 tentativas)
 * - max_attempts padrão = 3 (antes era 1)
 * - Content-Type preservado exatamente como enviado (sem override silencioso)
 * - Resposta normalizada sempre inclui request_id no nível raiz
 * - Log de erro apenas em falha real (não em 429 esperado)
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const ALLOWED_PATHS = [
  '/sp/campaigns', '/sp/campaigns/list',
  '/sp/adGroups', '/sp/adGroups/list',
  '/sp/productAds', '/sp/productAds/list',
  '/sp/keywords', '/sp/keywords/list',
  '/v2/sp/campaigns', '/v2/sp/adGroups', '/v2/sp/keywords', '/v2/sp/negativeKeywords',
  '/sp/negativeKeywords', '/sp/negativeKeywords/list',
  '/sp/targets', '/sp/targets/list', '/v2/sp/targets',
  '/adsApi/v1/create/targets',
  '/v2/profiles',
  '/reporting/reports',
];
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE']);

function adsBase(region: string | undefined): string {
  const r = String(region || Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function callAmazonApi(
  url: string,
  method: string,
  headers: Record<string, string>,
  payload: any,
  maxAttempts = 3,
): Promise<{ ok: boolean; status: number; payload: any; errors: any[]; request_id: string | null }> {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let lastResult: any = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
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

      const ok = response.status >= 200 && response.status < 300;
      const retryable = response.status === 503 || response.status === 502;
      const request_id = response.headers.get('x-amzn-RequestId') || response.headers.get('x-amz-request-id') || null;

      lastResult = {
        ok,
        status: response.status,
        payload: parsed,
        request_id,
        retry_after: response.headers.get('Retry-After'),
        rate_limit: response.headers.get('x-amzn-RateLimit-Limit'),
        errors: ok ? [] : [{ code: String(response.status), message: text.slice(0, 500) }],
      };

      if (ok || !retryable || attempt === maxAttempts - 1) break;
      console.log(`[adsCommand] ${response.status} retryable — tentativa ${attempt + 1}/${maxAttempts}`);
      await wait(Math.min(1000 * Math.pow(2, attempt), 15000));
    } catch (err: any) {
      lastResult = {
        ok: false, status: 0, payload: null, request_id: null,
        errors: [{ code: 'NETWORK_ERROR', message: err?.message || String(err) }],
      };
      if (attempt === maxAttempts - 1) break;
      await wait(2000);
    }
  }
  return lastResult;
}

Deno.serve(async (request) => {
  const t0 = Date.now();
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));

    if (!body._service_role) {
      return Response.json({ ok: false, error: 'Uso interno' }, { status: 403 });
    }
    if (!body.amazon_account_id || !body.path) {
      return Response.json({ ok: false, error: 'amazon_account_id e path obrigatórios' }, { status: 400 });
    }

    const method = String(body.method || 'GET').toUpperCase();
    const path = String(body.path || '');

    if (!ALLOWED_METHODS.has(method)) {
      return Response.json({ ok: false, error: 'Método não permitido' }, { status: 400 });
    }
    if (!ALLOWED_PATHS.some((a) => path === a || path.startsWith(`${a}?`) || path.startsWith(`${a}/`))) {
      return Response.json({ ok: false, error: 'Endpoint Ads não permitido' }, { status: 403 });
    }

    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter(
      { id: body.amazon_account_id }, null, 1,
    );
    const account = accounts[0];
    if (!account) {
      return Response.json({ ok: false, error: 'Conta Amazon não encontrada' }, { status: 404 });
    }

    const profileId = body.profile_id || account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID');
    if (!profileId && path !== '/v2/profiles') {
      return Response.json({ ok: false, error: 'ads_profile_id não configurado' }, { status: 400 });
    }

    const baseUrl = adsBase(account.region);
    const url = `${baseUrl}${path}`;
    const clientId = Deno.env.get('ADS_CLIENT_ID') || '';
    // ADS_ACCOUNT_ID é opcional — não bloqueia execução se ausente
    const adsAccountId = body.ads_account_id || account.ads_account_id || account.advertiser_account_id || Deno.env.get('ADS_ACCOUNT_ID') || null;
    const maxAttempts = Number(body.max_attempts || 3);

    async function buildHeaders(forceRefresh = false): Promise<Record<string, string>> {
      const tokenResult = await base44.asServiceRole.functions.invoke('amazonAdsTokenManager', {
        amazon_account_id: body.amazon_account_id,
        force_refresh: forceRefresh,
        _service_role: true,
      });

      const tData = tokenResult?.data || tokenResult || {};
      if (!tData.ok || !tData.access_token) {
        throw {
          tokenError: true,
          error_type: tData.error_type || 'token_unavailable',
          amazon_error_code: tData.amazon_error_code,
          message: tData.message || 'Falha ao obter token Amazon Ads',
          requires_reauthorization: tData.requires_reauthorization,
          credentials_error: tData.credentials_error,
          retryable: tData.retryable,
        };
      }

      const headers: Record<string, string> = {
        Authorization: `Bearer ${tData.access_token}`,
        'Amazon-Advertising-API-ClientId': clientId,
        'Content-Type': body.content_type || 'application/json',
        Accept: body.accept || body.content_type || 'application/json',
      };
      if (profileId) headers['Amazon-Advertising-API-Scope'] = String(profileId);
      if (adsAccountId) headers['Amazon-Ads-AccountId'] = String(adsAccountId);
      return headers;
    }

    // Primeira tentativa
    let headers = await buildHeaders(false);
    let result = await callAmazonApi(url, method, headers, body.payload ?? null, maxAttempts);

    // Em 401/403: força refresh e tenta uma vez mais
    if (result.status === 401 || result.status === 403) {
      console.log(`[adsCommand] ${result.status} — forçando refresh de token`);
      try {
        headers = await buildHeaders(true);
        result = await callAmazonApi(url, method, headers, body.payload ?? null, 1);
        if (result.status === 401 || result.status === 403) {
          await base44.asServiceRole.entities.AmazonAccount.update(account.id, {
            ads_token_status: 'revoked',
            ads_requires_reauth: true,
            ads_token_last_error: `401/403 após refresh em ${method} ${path}`,
            status: 'error',
            error_message: 'Reautorização necessária: Amazon Ads retornou 401/403 após refresh do token.',
          }).catch(() => {});
          return Response.json({
            ok: false,
            status: result.status,
            error: 'token_invalid_after_refresh',
            requires_reauthorization: true,
            message: 'Sua autorização Amazon expirou ou foi revogada. Clique em Reconectar Amazon para continuar.',
          });
        }
      } catch (tokenErr: any) {
        if (tokenErr.tokenError) {
          return Response.json({
            ok: false,
            error_type: tokenErr.error_type,
            amazon_error_code: tokenErr.amazon_error_code,
            message: tokenErr.message,
            requires_reauthorization: tokenErr.requires_reauthorization,
            credentials_error: tokenErr.credentials_error,
            retryable: tokenErr.retryable,
          }, { status: tokenErr.credentials_error ? 400 : 401 });
        }
        throw tokenErr;
      }
    }

    // Rate limit 429
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
        message: 'Comando recebido. A Amazon limitou a taxa de requisições, então a ação será efetivada em alguns instantes.',
      });
    }

    // Erro real — loga
    if (!result.ok) {
      await base44.asServiceRole.entities.SyncExecutionLog.create({
        amazon_account_id: account.id,
        operation: `amazon_api:${body.operation || `${method}:${path}`}`,
        status: 'error',
        trigger_type: 'gateway',
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        records_processed: 0,
        error_message: String(result.errors?.[0]?.message || '').slice(0, 500),
        result_summary: JSON.stringify({ status: result.status, request_id: result.request_id }).slice(0, 1000),
      }).catch(() => {});
    }

    return Response.json({
      ok: result.ok,
      status: result.status,
      payload: result.payload,
      request_id: result.request_id,
      errors: result.errors,
      duration_ms: Date.now() - t0,
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
    return Response.json({
      ok: false,
      error: error?.message?.slice(0, 300) || 'Erro no comando Amazon Ads',
    }, { status: 500 });
  }
});