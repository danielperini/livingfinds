/**
 * amazonAdsCommand v4 — Gateway centralizado Amazon Ads com renovação automática de token
 *
 * Fluxo:
 * 1. Obter access_token via amazonAdsTokenManager (cache + renovação automática)
 * 2. Executar chamada Amazon Ads
 * 3. Se 401/403: force_refresh + retry único
 * 4. Se 429: registrar rate limit, retornar mensagem amigável
 * 5. Logar resultado (sem tokens)
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
  maxAttempts = 3
): Promise<{ ok: boolean; status: number; payload: any; errors: any[] }> {
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
      lastResult = {
        ok,
        status: response.status,
        payload: parsed,
        errors: ok ? [] : [{ code: String(response.status), message: text.slice(0, 300) }],
      };

      if (ok || !retryable || attempt === maxAttempts - 1) break;
      await wait(Math.min(1000 * Math.pow(2, attempt), 15000));
    } catch (err: any) {
      lastResult = {
        ok: false,
        status: 0,
        payload: null,
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

    // ── Buscar conta ─────────────────────────────────────────────────────────
    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter(
      { id: body.amazon_account_id }, null, 1
    );
    const account = accounts[0];
    if (!account) {
      return Response.json({ ok: false, error: 'Conta Amazon não encontrada' }, { status: 404 });
    }

    const profileId = body.profile_id || account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID');
    if (!profileId) {
      return Response.json({ ok: false, error: 'ads_profile_id não configurado' }, { status: 400 });
    }
    const baseUrl = adsBase(account.region);
    const url = `${baseUrl}${path}`;
    const clientId = Deno.env.get('ADS_CLIENT_ID') || '';

    // ── Função interna: montar headers com token ─────────────────────────────
    async function buildHeaders(forceRefresh = false): Promise<{ headers: Record<string, string>; tokenResult: any }> {
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
          message: tData.message || 'Falha ao obter token Amazon Ads',
          requires_reauthorization: tData.requires_reauthorization,
        };
      }

      return {
        tokenResult: tData,
        headers: {
          Authorization: `Bearer ${tData.access_token}`,
          'Amazon-Advertising-API-ClientId': clientId,
          'Amazon-Advertising-API-Scope': String(profileId),
          'Content-Type': body.content_type || 'application/json',
          Accept: body.accept || body.content_type || 'application/json',
        },
      };
    }

    // ── Primeira tentativa ───────────────────────────────────────────────────
    let { headers } = await buildHeaders(false);
    let result = await callAmazonApi(url, method, headers, body.payload ?? null, Number(body.max_attempts || 1));

    // ── Retry único em 401/403 (token expirado mid-request) ─────────────────
    if ((result.status === 401 || result.status === 403)) {
      console.log(`[adsCommand] ${result.status} recebido — forçando refresh e retentando uma vez`);
      try {
        const { headers: headers2 } = await buildHeaders(true); // force_refresh
        result = await callAmazonApi(url, method, headers2, body.payload ?? null, 1);
        if (result.status === 401 || result.status === 403) {
          // Falhou mesmo após refresh — reautorização necessária
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
            message: tokenErr.message,
            requires_reauthorization: tokenErr.requires_reauthorization,
          });
        }
        throw tokenErr;
      }
    }

    // ── Rate limit (429) ─────────────────────────────────────────────────────
    if (result.status === 429) {
      console.warn(`[adsCommand] 429 rate limit em ${path}`);
      await base44.asServiceRole.entities.SyncExecutionLog.create({
        amazon_account_id: account.id,
        operation: `amazon_api:rate_limit:${method}:${path}`,
        status: 'skipped_limit',
        trigger_type: 'automatic',
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        records_processed: 0,
        error_message: 'Rate limit Amazon Ads (429)',
      }).catch(() => {});

      return Response.json({
        ok: false,
        status: 429,
        rate_limited: true,
        message: 'Comando recebido. A Amazon limitou a taxa de requisições, então a ação será efetivada em alguns instantes.',
        retry_after_seconds: 60,
      });
    }

    // ── Log de auditoria (sem tokens) ────────────────────────────────────────
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
      }).catch(() => {});
    }

    return Response.json({ ...result, duration_ms: Date.now() - t0 });

  } catch (error: any) {
    if (error?.tokenError) {
      return Response.json({
        ok: false,
        error_type: error.error_type,
        message: error.message,
        requires_reauthorization: error.requires_reauthorization,
      }, { status: 401 });
    }
    return Response.json({
      ok: false,
      error: error?.message?.slice(0, 300) || 'Erro no comando Amazon Ads',
    }, { status: 500 });
  }
});