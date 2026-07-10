/**
 * amazonAdsTokenManager — Camada central de renovação automática de tokens Amazon Ads
 *
 * Responsabilidades:
 * - Ler refresh_token da entidade AmazonAccount
 * - Verificar validade do access_token (cache na entidade via expires_at)
 * - Renovar access_token automaticamente quando necessário (margem: 5 min)
 * - Lock distribuído para evitar refreshes simultâneos
 * - Classificar erros: invalid_grant, network, missing, etc.
 * - Registrar status na entidade (sem expor tokens)
 *
 * USO (interno — somente _service_role):
 * base44.asServiceRole.functions.invoke('amazonAdsTokenManager', {
 *   amazon_account_id: 'xxx',
 *   force_refresh: false,     // forçar renovação mesmo se ainda válido
 *   _service_role: true,
 * })
 *
 * RETORNO:
 * { ok: true, access_token: '...', expires_at: '...', from_cache: true|false }
 * { ok: false, error_type: 'invalid_grant'|'missing_refresh_token'|..., requires_reauthorization: true }
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

// ── Cache em memória por instância (fallback secundário ao cache persistente na entidade) ──
const memCache: Map<string, { access_token: string; expires_at: number }> = new Map();

// ── Helpers ──────────────────────────────────────────────────────────────────

function adsBase(region: string | undefined): string {
  const r = String(region || Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

function maskToken(token: string): string {
  if (!token || token.length < 8) return '****';
  return `${token.slice(0, 6)}...${token.slice(-4)}`;
}

function isExpiringSoon(expiresAt: string | undefined, marginSeconds = 300): boolean {
  if (!expiresAt) return true;
  const expMs = new Date(expiresAt).getTime();
  return expMs - Date.now() < marginSeconds * 1000;
}

async function fetchAccessToken(refreshToken: string): Promise<{ access_token: string; expires_in: number }> {
  const clientId = Deno.env.get('ADS_CLIENT_ID') || '';
  const clientSecret = Deno.env.get('ADS_CLIENT_SECRET') || '';
  if (!clientId || !clientSecret) {
    throw { error_type: 'missing_credentials', message: 'ADS_CLIENT_ID ou ADS_CLIENT_SECRET não configurados', retryable: false };
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
    const errCode = data.error || 'unknown';
    const isInvalidGrant = errCode === 'invalid_grant' || errCode === 'unauthorized_client';
    const isNetworkError = res.status >= 500 || res.status === 429;
    throw {
      error_type: isInvalidGrant ? 'invalid_grant' : isNetworkError ? 'temporary_network_error' : 'token_refresh_denied',
      message: data.error_description || data.error || `HTTP ${res.status}`,
      status_code: res.status,
      requires_reauthorization: isInvalidGrant,
      retryable: isNetworkError,
    };
  }

  if (!data.access_token) {
    throw { error_type: 'token_refresh_denied', message: 'access_token não retornado', retryable: false };
  }

  return { access_token: data.access_token, expires_in: data.expires_in || 3600 };
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
    error_message: event.error_message ? event.error_message.slice(0, 300) : null,
  }).catch(() => {});
}

// ── Handler principal ─────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  const t0 = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    // Apenas chamadas internas (service role)
    if (!body._service_role) {
      return Response.json({ ok: false, error: 'Uso interno apenas' }, { status: 403 });
    }

    const accountId = body.amazon_account_id;
    if (!accountId) {
      return Response.json({ ok: false, error_type: 'missing_account_id', error: 'amazon_account_id obrigatório' }, { status: 400 });
    }

    const forceRefresh = body.force_refresh === true;

    // ── 1. Buscar conta ──────────────────────────────────────────────────────
    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ id: accountId }, null, 1);
    const account = accounts[0];
    if (!account) {
      return Response.json({ ok: false, error_type: 'account_not_found', error: 'Conta Amazon não encontrada' }, { status: 404 });
    }

    // ── 2. Verificar refresh_token ───────────────────────────────────────────
    const refreshToken = account.ads_refresh_token;
    if (!refreshToken || !refreshToken.startsWith('Atzr|') || refreshToken.length < 50) {
      await base44.asServiceRole.entities.AmazonAccount.update(accountId, {
        ads_token_status: 'missing',
        ads_requires_reauth: true,
        ads_token_last_error: 'refresh_token ausente ou inválido',
      }).catch(() => {});
      return Response.json({
        ok: false,
        error_type: 'missing_refresh_token',
        requires_reauthorization: true,
        message: 'Sua autorização Amazon expirou ou foi revogada. Clique em Reconectar Amazon para continuar.',
      });
    }

    // ── 3. Verificar cache em memória (mais rápido) ──────────────────────────
    if (!forceRefresh) {
      const mem = memCache.get(accountId);
      if (mem && mem.expires_at > Date.now() + 300000) {
        return Response.json({
          ok: true,
          access_token: mem.access_token,
          expires_at: new Date(mem.expires_at).toISOString(),
          from_cache: true,
          source: 'memory',
        });
      }

      // ── 4. Verificar cache persistente (entidade) ────────────────────────
      if (!isExpiringSoon(account.ads_access_token_expires_at)) {
        // Token ainda válido segundo a entidade — mas não temos o access_token em memória
        // Precisa renovar de qualquer forma para ter o valor (não armazenamos o token na entidade)
        // Se temos no cache de memória (mesmo expirado), testar; caso contrário, renovar
        // Decisão: se expires_at no futuro > 5min, mas sem memCache, ainda renovar (necessário)
        // Este cenário ocorre após restart da instância Deno
        console.log(`[tokenManager] Cache persistente indica token válido até ${account.ads_access_token_expires_at}, mas sem cache em memória — renovando`);
      }
    }

    // ── 5. Lock contra refresh duplicado ─────────────────────────────────────
    const lockAge = account.ads_token_refresh_started_at
      ? Date.now() - new Date(account.ads_token_refresh_started_at).getTime()
      : Infinity;
    const lockActive = account.ads_token_refresh_in_progress === true && lockAge < 60000;

    if (lockActive) {
      // Outro refresh em andamento há < 60s — aguardar brevemente e reutilizar
      console.log(`[tokenManager] Lock ativo (${Math.round(lockAge / 1000)}s atrás). Aguardando...`);
      await new Promise(r => setTimeout(r, 3000));
      // Re-buscar a conta para ver se o refresh completou
      const refreshed = await base44.asServiceRole.entities.AmazonAccount.filter({ id: accountId }, null, 1);
      const updatedAccount = refreshed[0];
      // Se o refresh completou e token é válido
      if (updatedAccount && !isExpiringSoon(updatedAccount.ads_access_token_expires_at, 60)) {
        const mem2 = memCache.get(accountId);
        if (mem2 && mem2.expires_at > Date.now() + 60000) {
          return Response.json({
            ok: true,
            access_token: mem2.access_token,
            expires_at: new Date(mem2.expires_at).toISOString(),
            from_cache: true,
            source: 'memory_after_lock_wait',
          });
        }
      }
      // Se ainda em lock ou não resolveu, continuar tentando (lock pode ter travado)
    }

    // ── 6. Adquirir lock ─────────────────────────────────────────────────────
    await base44.asServiceRole.entities.AmazonAccount.update(accountId, {
      ads_token_refresh_in_progress: true,
      ads_token_refresh_started_at: new Date().toISOString(),
      ads_token_status: 'refreshing',
    }).catch(() => {});

    // ── 7. Renovar access_token ──────────────────────────────────────────────
    let tokenResult: { access_token: string; expires_in: number } | null = null;
    let refreshError: any = null;

    try {
      tokenResult = await fetchAccessToken(refreshToken);
    } catch (err: any) {
      refreshError = err;
    }

    // ── 8. Liberar lock e salvar resultado ───────────────────────────────────
    if (tokenResult) {
      // Sucesso — salvar metadados (sem o token em si)
      const expiresAt = new Date(Date.now() + (tokenResult.expires_in - 300) * 1000).toISOString();
      await base44.asServiceRole.entities.AmazonAccount.update(accountId, {
        ads_token_refresh_in_progress: false,
        ads_token_refresh_started_at: null,
        ads_token_status: 'active',
        ads_access_token_expires_at: expiresAt,
        ads_last_token_refresh_at: new Date().toISOString(),
        ads_token_last_error: null,
        ads_requires_reauth: false,
        status: 'connected',
        error_message: null,
      }).catch(() => {});

      // Salvar no cache de memória
      memCache.set(accountId, {
        access_token: tokenResult.access_token,
        expires_at: new Date(expiresAt).getTime(),
      });

      await logTokenEvent(base44, accountId, { success: true });

      console.log(`[tokenManager] ✓ Token renovado para conta ${accountId} | expira ${expiresAt} | duração: ${Date.now() - t0}ms`);
      return Response.json({
        ok: true,
        access_token: tokenResult.access_token,
        expires_at: expiresAt,
        from_cache: false,
        duration_ms: Date.now() - t0,
      });

    } else {
      // Falha — liberar lock e registrar erro
      const errType = refreshError?.error_type || 'token_refresh_failed';
      const safeMsg = refreshError?.message?.slice(0, 200) || 'Erro desconhecido';
      const requiresReauth = refreshError?.requires_reauthorization === true;

      await base44.asServiceRole.entities.AmazonAccount.update(accountId, {
        ads_token_refresh_in_progress: false,
        ads_token_refresh_started_at: null,
        ads_token_status: requiresReauth ? 'revoked' : 'error',
        ads_token_last_error: safeMsg,
        ads_requires_reauth: requiresReauth,
        ...(requiresReauth ? { status: 'error', error_message: 'Reautorização necessária: ' + safeMsg } : {}),
      }).catch(() => {});

      await logTokenEvent(base44, accountId, {
        success: false,
        error_type: errType,
        error_message: safeMsg,
        status_code: refreshError?.status_code,
      });

      console.error(`[tokenManager] ✗ Falha ao renovar token (${errType}): ${safeMsg}`);

      return Response.json({
        ok: false,
        error_type: errType,
        message: requiresReauth
          ? 'Sua autorização Amazon expirou ou foi revogada. Clique em Reconectar Amazon para continuar.'
          : 'Conexão com a Amazon instável. Vamos tentar novamente em instantes.',
        requires_reauthorization: requiresReauth,
        retryable: refreshError?.retryable === true,
        error_safe: safeMsg,
        duration_ms: Date.now() - t0,
      });
    }

  } catch (error: any) {
    return Response.json({
      ok: false,
      error_type: 'internal_error',
      error: error?.message?.slice(0, 200) || 'Erro interno no token manager',
    }, { status: 500 });
  }
});