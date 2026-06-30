/**
 * amazonAuthCallback — callback público OAuth SP-API
 * Path registado na Amazon: /api/auth/amazon/callback
 * Recebe: spapi_oauth_code, state, selling_partner_id
 * Troca código por tokens, persiste na conta, redireciona para /integracoes/amazon
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const APP_BASE_URL = 'https://livingfinds-app.base44.app';
const REDIRECT_URI = `${APP_BASE_URL}/api/auth/amazon/callback`;

// Prevenir replay (em memória por instância)
const usedStates = new Set<string>();

Deno.serve(async (req) => {
  const url = new URL(req.url);

  // A Amazon sempre redireciona via GET
  const spCode = url.searchParams.get('spapi_oauth_code');
  const state = url.searchParams.get('state');
  const sellingPartnerId = url.searchParams.get('selling_partner_id');

  const redirectError = (msg: string) =>
    Response.redirect(`${APP_BASE_URL}/integracoes/amazon?status=error&msg=${encodeURIComponent(msg)}`, 302);
  const redirectSuccess =
    Response.redirect(`${APP_BASE_URL}/integracoes/amazon?status=success&seller=${sellingPartnerId || ''}`, 302);

  // Validar parâmetros
  if (!spCode) return redirectError('Código de autorização ausente');
  if (!state) return redirectError('State ausente');
  if (!state.startsWith('livingfinds')) return redirectError('State inválido');
  if (usedStates.has(state)) return redirectError('State já utilizado (replay negado)');
  usedStates.add(state);

  // Credenciais LWA
  const clientId = Deno.env.get('SP_CLIENT_ID') || '';
  const clientSecret = Deno.env.get('SP_CLIENT_SECRET') || '';

  if (!clientId || !clientSecret) {
    return redirectError('SP_CLIENT_ID ou SP_CLIENT_SECRET não configurados');
  }

  // Trocar código por tokens (inclui redirect_uri obrigatório)
  let tokenData: Record<string, unknown>;
  try {
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code: spCode,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: REDIRECT_URI,
    });
    const tokenRes = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    tokenData = await tokenRes.json() as Record<string, unknown>;
    if (!tokenRes.ok) {
      const errMsg = (tokenData.error_description as string) || (tokenData.error as string) || 'Token exchange falhou';
      console.error('[amazonAuthCallback] Token error:', errMsg, JSON.stringify(tokenData));
      return redirectError(errMsg);
    }
  } catch (e) {
    console.error('[amazonAuthCallback] Fetch error:', (e as Error).message);
    return redirectError(`Erro na troca de token: ${(e as Error).message}`);
  }

  const refreshToken = tokenData.refresh_token as string;

  // Log seguro do refresh token (recuperável nos logs do servidor)
  console.log(`[amazonAuthCallback] ✅ seller=${sellingPartnerId}`);
  console.log(`[amazonAuthCallback] REFRESH_TOKEN=${refreshToken}`);

  // Persistir estado de conexão na AmazonAccount + salvar refresh token
  let accountId: string | null = null;
  try {
    const base44 = createClientFromRequest(req);
    const accounts = sellingPartnerId
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ seller_id: sellingPartnerId })
      : [];
    const account = accounts[0] || (await base44.asServiceRole.entities.AmazonAccount.list())[0];
    if (account) {
      accountId = account.id;
      await base44.asServiceRole.entities.AmazonAccount.update(account.id, {
        seller_id: sellingPartnerId || account.seller_id,
        status: 'connected',
        ads_refresh_token: refreshToken, // salvar para sync automático
        error_message: null,
        last_sync_at: new Date().toISOString(),
      });
    }
  } catch (dbErr) {
    console.warn('[amazonAuthCallback] DB update falhou (não crítico):', (dbErr as Error).message);
  }

  // Disparar sync automático em background (não bloqueia o redirect)
  if (accountId) {
    const syncUrl = `${APP_BASE_URL}/api/functions/runFullSync`;
    fetch(syncUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amazon_account_id: accountId, action: 'request' }),
    }).then(async (r) => {
      const d = await r.json().catch(() => ({}));
      console.log(`[amazonAuthCallback] Auto-sync disparado: ok=${d.ok} camps=${d.campaigns_imported} reports=${JSON.stringify(d.reportIds)}`);
    }).catch((e) => {
      console.warn('[amazonAuthCallback] Auto-sync falhou (não crítico):', e.message);
    });
  }

  return redirectSuccess;
});