import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';

/**
 * Gateway restrito para Sponsored Products Optimization Rules.
 *
 * Não usa SP-API: estas operações pertencem à Amazon Ads API.
 * Aceita somente os endpoints de regras necessários ao dayparting nativo.
 */
const MIME = 'application/vnd.spoptimizationrules.v1+json';
const TRANSIENT = new Set([429, 500, 502, 503, 504, 524]);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function adsBase(region: string | undefined): string {
  const value = String(region || Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
  if (value.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (value.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

function resolvePath(operation: string, campaignId?: string): { method: string; path: string } {
  if (operation === 'search_rules') return { method: 'POST', path: '/sp/rules/optimization/search' };
  if (operation === 'create_rules') return { method: 'POST', path: '/sp/rules/optimization' };
  if (operation === 'update_rules') return { method: 'PUT', path: '/sp/rules/optimization' };
  if (operation === 'associate_rules') {
    const cid = String(campaignId || '').trim();
    if (!cid || !/^[A-Za-z0-9_-]+$/.test(cid)) throw new Error('campaign_id inválido para associação da regra');
    return { method: 'POST', path: `/sp/campaigns/${cid}/optimizationRules` };
  }
  throw new Error(`Operação de Optimization Rules não permitida: ${operation}`);
}

function bodyMessage(payload: any): string {
  return String(
    payload?.message ||
    payload?.error ||
    payload?.errors?.[0]?.message ||
    payload?.responses?.find?.((x: any) => String(x?.code || '').toUpperCase() !== 'SUCCESS')?.details ||
    'Resposta Amazon inválida',
  ).slice(0, 800);
}

function multiStatusOk(status: number, payload: any): boolean {
  if (status !== 207) return status >= 200 && status < 300;
  const collections = [
    payload?.responses,
    payload?.optimizationRules?.success,
    payload?.optimizationRules,
    payload?.success,
  ].filter(Array.isArray);
  if (collections.length === 0) return String(payload?.code || '').toUpperCase() === 'SUCCESS';
  const rows = collections.flat();
  return rows.length > 0 && rows.some((row: any) => {
    const code = String(row?.code || row?.status || '').toUpperCase();
    return ['SUCCESS', 'CREATED', 'UPDATED', 'ASSOCIATED'].includes(code) || Boolean(row?.optimizationRuleId);
  });
}

async function callAmazon(params: {
  url: string;
  method: string;
  headers: Record<string, string>;
  payload: any;
  maxAttempts: number;
}) {
  let last: any = null;
  for (let attempt = 1; attempt <= params.maxAttempts; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      const response = await fetch(params.url, {
        method: params.method,
        headers: params.headers,
        body: JSON.stringify(params.payload || {}),
        signal: controller.signal,
      }).finally(() => clearTimeout(timeout));
      const text = await response.text().catch(() => '');
      let payload: any = {};
      try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text }; }
      const requestId = response.headers.get('x-amzn-requestid') || response.headers.get('x-amz-request-id') || '';
      const ok = response.status === 409 || multiStatusOk(response.status, payload);
      const retryAfter = Math.max(1, Number(response.headers.get('Retry-After') || 0) || 0);
      last = {
        ok,
        status: response.status,
        payload,
        request_id: requestId,
        retry_after_seconds: retryAfter || null,
        conflict_existing: response.status === 409,
        retryable: TRANSIENT.has(response.status),
        error: ok ? null : bodyMessage(payload),
      };
      if (ok || !TRANSIENT.has(response.status) || attempt === params.maxAttempts) return last;
      const backoffMs = response.status === 429 && retryAfter > 0
        ? Math.min(retryAfter * 1000, 30000)
        : Math.min(1000 * Math.pow(2, attempt - 1), 15000);
      await wait(backoffMs);
    } catch (error: any) {
      last = {
        ok: false,
        status: 0,
        payload: null,
        request_id: '',
        retryable: true,
        error: error?.name === 'AbortError' ? 'Timeout Amazon Ads após 30s' : (error?.message || String(error)),
      };
      if (attempt < params.maxAttempts) await wait(Math.min(2000 * attempt, 10000));
    }
  }
  return last;
}

Deno.serve(async (request) => {
  const startedAt = Date.now();
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    if (!body._service_role) return Response.json({ ok: false, error: 'Uso interno' }, { status: 403 });
    if (!body.amazon_account_id || !body.operation) {
      return Response.json({ ok: false, error: 'amazon_account_id e operation obrigatórios' }, { status: 400 });
    }

    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1);
    const account = accounts[0];
    if (!account) return Response.json({ ok: false, error: 'Conta Amazon não encontrada' }, { status: 404 });

    const profileId = body.profile_id || account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID');
    if (!profileId) return Response.json({ ok: false, error: 'ads_profile_id ausente' }, { status: 400 });

    const endpoint = resolvePath(String(body.operation), body.campaign_id);
    const tokenResponse = await base44.asServiceRole.functions.invoke('amazonAdsTokenManager', {
      amazon_account_id: account.id,
      force_refresh: false,
      _service_role: true,
    });
    let tokenData = tokenResponse?.data || tokenResponse || {};
    if (!tokenData?.ok || !tokenData?.access_token) {
      return Response.json({
        ok: false,
        error: tokenData?.message || 'Token Amazon Ads indisponível',
        retryable: tokenData?.retryable === true,
        requires_reauthorization: tokenData?.requires_reauthorization === true,
      }, { status: 401 });
    }

    const headers = (token: string) => ({
      Authorization: `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID') || '',
      'Amazon-Advertising-API-Scope': String(profileId),
      'Content-Type': MIME,
      Accept: MIME,
    });

    const url = `${adsBase(account.region)}${endpoint.path}`;
    const maxAttempts = Math.min(4, Math.max(1, Number(body.max_attempts || 3)));
    let result = await callAmazon({
      url,
      method: endpoint.method,
      headers: headers(tokenData.access_token),
      payload: body.payload || {},
      maxAttempts,
    });

    // 401 é autenticação. 403 pode ser permissão/feature não disponível e não deve revogar OAuth.
    if (result.status === 401) {
      const refreshed = await base44.asServiceRole.functions.invoke('amazonAdsTokenManager', {
        amazon_account_id: account.id,
        force_refresh: true,
        _service_role: true,
      }).catch(() => null);
      tokenData = refreshed?.data || refreshed || {};
      if (tokenData?.ok && tokenData?.access_token) {
        result = await callAmazon({
          url,
          method: endpoint.method,
          headers: headers(tokenData.access_token),
          payload: body.payload || {},
          maxAttempts: 1,
        });
      }
    }

    const unsupported = [400, 403, 404, 415].includes(Number(result.status)) && /not supported|unsupported|not available|forbidden|invalid.*rule|marketplace/i.test(
      `${result.error || ''} ${JSON.stringify(result.payload || {})}`,
    );

    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: account.id,
      operation: `amazon_ads_optimization_rules:${body.operation}`,
      trigger_type: body.trigger_type || 'automatic',
      status: result.ok ? 'success' : result.retryable ? 'partial' : 'error',
      execution_date: new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10),
      started_at: new Date(startedAt).toISOString(),
      completed_at: new Date().toISOString(),
      duration_ms: Date.now() - startedAt,
      records_processed: result.ok ? 1 : 0,
      error_message: result.ok ? null : String(result.error || '').slice(0, 500),
      result_summary: JSON.stringify({ status: result.status, request_id: result.request_id, unsupported }).slice(0, 1000),
    }).catch(() => {});

    return Response.json({
      ...result,
      unsupported,
      operation: body.operation,
      path: endpoint.path,
      duration_ms: Date.now() - startedAt,
    });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || 'Falha no gateway de Optimization Rules' }, { status: 500 });
  }
});
