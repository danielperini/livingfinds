/**
 * amazonAuthCallback — callback público OAuth SP-API.
 * Nunca grava refresh token SP no campo ads_refresh_token e nunca loga tokens/codes.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { resolveAmazonSpCredentials, shortCredentialHash } from '../../shared/amazonCredentials.ts';
import { safeOverallStatusAfterSpSuccess } from '../../shared/amazonAuthStatus.ts';

const usedStates = new Set<string>();

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const appBaseUrl = String(Deno.env.get('APP_BASE_URL') || '').replace(/\/+$/, '');
  if (!appBaseUrl) return Response.json({ ok: false, error: 'APP_BASE_URL_REQUIRED' }, { status: 500 });
  const redirectUri = `${appBaseUrl}/api/auth/amazon/callback`;

  const spCode = url.searchParams.get('spapi_oauth_code');
  const state = url.searchParams.get('state');
  const sellingPartnerId = url.searchParams.get('selling_partner_id');
  const redirectError = (msg: string) => Response.redirect(`${appBaseUrl}/integracoes/amazon?status=error&msg=${encodeURIComponent(msg)}`, 302);
  const redirectSuccess = Response.redirect(`${appBaseUrl}/integracoes/amazon?status=success&seller=${encodeURIComponent(sellingPartnerId || '')}`, 302);

  if (!spCode) return redirectError('Código de autorização ausente');
  if (!state) return redirectError('State ausente');
  if (!state.startsWith('livingfinds')) return redirectError('State inválido');
  if (usedStates.has(state)) return redirectError('State já utilizado (replay negado)');
  usedStates.add(state);

  const credentials = resolveAmazonSpCredentials();
  const clientId = credentials.clientId.value;
  const clientSecret = credentials.clientSecret.value;
  if (clientId.startsWith('amzn1.sp.solution')) return redirectError('LWA Client ID configurado contém App ID em vez de client ID.');
  if (!clientId || !clientSecret) return redirectError('Credenciais SP-API LWA não configuradas');

  let refreshToken = '';
  try {
    const tokenRes = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: spCode,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
      }).toString(),
    });
    const tokenData = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok) {
      const errorCode = String(tokenData?.error || `http_${tokenRes.status}`);
      console.error(`[amazonAuthCallback] token exchange falhou: code=${errorCode} http=${tokenRes.status}`);
      return redirectError(String(tokenData?.error_description || tokenData?.error || 'Token exchange falhou'));
    }
    refreshToken = String(tokenData?.refresh_token || '').trim();
    if (!refreshToken) return redirectError('Amazon não retornou refresh token SP-API');
  } catch (error: any) {
    console.error(`[amazonAuthCallback] token exchange network error: ${error?.message || String(error)}`);
    return redirectError('Erro de rede na troca de autorização SP-API');
  }

  // Somente fingerprint diagnóstico; o valor jamais é escrito em log.
  console.info(`[amazonAuthCallback] SP autorizado seller=${sellingPartnerId || 'unknown'} refresh_hash=${shortCredentialHash(refreshToken)}`);

  let accountId: string | null = null;
  try {
    const base44 = createClientFromRequest(req);
    const accounts = sellingPartnerId
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ seller_id: sellingPartnerId }, null, 1)
      : await base44.asServiceRole.entities.AmazonAccount.list('-updated_date', 1);
    const account = accounts[0] || null;
    if (account) {
      accountId = account.id;
      await base44.asServiceRole.entities.AmazonAccount.update(account.id, {
        seller_id: sellingPartnerId || account.seller_id,
        // SP nunca pode tornar a conta "connected" se Ads estiver revogada.
        status: safeOverallStatusAfterSpSuccess(account),
        last_sync_at: new Date().toISOString(),
      });
    }
  } catch (error: any) {
    console.warn(`[amazonAuthCallback] DB update falhou: ${error?.message || String(error)}`);
  }

  // A credencial SP canônica continua sendo AMAZON_SP_REFRESH_TOKEN. Como secrets
  // de processo não podem ser mutados por uma função em runtime, não há cross-write
  // para ads_refresh_token. O operador deve atualizar o secret SP por canal seguro.
  if (accountId) {
    console.warn(`[amazonAuthCallback] SP_REFRESH_TOKEN_SECRET_UPDATE_REQUIRED account=${accountId} hash=${shortCredentialHash(refreshToken)}`);
  }

  return redirectSuccess;
});
