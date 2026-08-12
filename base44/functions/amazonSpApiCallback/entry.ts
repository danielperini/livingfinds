/**
 * amazonSpApiCallback — callback OAuth SP-API legado.
 * Usa credenciais canônicas e nunca imprime/retorna tokens ou authorization codes.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { resolveAmazonSpCredentials, shortCredentialHash } from '../../shared/amazonCredentials.ts';
import { safeOverallStatusAfterSpSuccess } from '../../shared/amazonAuthStatus.ts';

const usedStates = new Set<string>();

Deno.serve(async (req) => {
  const url = new URL(req.url);
  let spCode: string | null = null;
  let state: string | null = null;
  let sellingPartnerId: string | null = null;
  const appBaseUrl = String(Deno.env.get('APP_BASE_URL') || '').replace(/\/+$/, '');
  if (!appBaseUrl) return Response.json({ ok: false, error: 'APP_BASE_URL_REQUIRED' }, { status: 500 });

  if (req.method === 'GET') {
    spCode = url.searchParams.get('spapi_oauth_code');
    state = url.searchParams.get('state');
    sellingPartnerId = url.searchParams.get('selling_partner_id');
  } else {
    try {
      const body = await req.json();
      spCode = body.spapi_oauth_code || body.code;
      state = body.state;
      sellingPartnerId = body.selling_partner_id;
    } catch {
      return Response.json({ error: 'Body inválido' }, { status: 400 });
    }
  }

  const redirectSuccess = `${appBaseUrl}/integracoes/amazon?status=success&seller=${encodeURIComponent(sellingPartnerId || '')}`;
  const redirectError = (msg: string) => `${appBaseUrl}/integracoes/amazon?status=error&msg=${encodeURIComponent(msg)}`;
  const fail = (msg: string, status = 400) => req.method === 'GET'
    ? Response.redirect(redirectError(msg), 302)
    : Response.json({ ok: false, error: msg }, { status });

  if (!spCode) return fail('Código de autorização ausente');
  if (!state) return fail('State ausente');
  if (!state.startsWith('livingfinds')) return fail('State inválido');
  if (usedStates.has(state)) return fail('State já utilizado (replay negado)', 409);
  usedStates.add(state);

  const credentials = resolveAmazonSpCredentials();
  if (!credentials.clientId.value || !credentials.clientSecret.value) return fail('Credenciais SP-API LWA não configuradas', 500);

  let refreshToken = '';
  try {
    const tokenRes = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: spCode,
        client_id: credentials.clientId.value,
        client_secret: credentials.clientSecret.value,
      }).toString(),
    });
    const tokenData = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok) {
      const code = String(tokenData?.error || `http_${tokenRes.status}`);
      console.error(`[spApiCallback] token exchange falhou: code=${code} http=${tokenRes.status}`);
      return fail(String(tokenData?.error_description || tokenData?.error || 'Token exchange falhou'));
    }
    refreshToken = String(tokenData?.refresh_token || '').trim();
    if (!refreshToken) return fail('Amazon não retornou refresh token SP-API');
  } catch (error: any) {
    console.error(`[spApiCallback] token exchange network error: ${error?.message || String(error)}`);
    return fail('Erro de rede na troca de token', 500);
  }

  try {
    const base44 = createClientFromRequest(req);
    const accounts = sellingPartnerId
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ seller_id: sellingPartnerId }, null, 1)
      : await base44.asServiceRole.entities.AmazonAccount.list('-updated_date', 1);
    const account = accounts[0] || null;
    if (account) {
      await base44.asServiceRole.entities.AmazonAccount.update(account.id, {
        seller_id: sellingPartnerId || account.seller_id,
        status: safeOverallStatusAfterSpSuccess(account),
        last_sync_at: new Date().toISOString(),
      });
      console.warn(`[spApiCallback] SP_REFRESH_TOKEN_SECRET_UPDATE_REQUIRED account=${account.id} hash=${shortCredentialHash(refreshToken)}`);
    }
  } catch (error: any) {
    console.warn(`[spApiCallback] DB update falhou: ${error?.message || String(error)}`);
  }

  if (req.method === 'GET') return Response.redirect(redirectSuccess, 302);
  return Response.json({
    ok: true,
    selling_partner_id: sellingPartnerId,
    message: 'Autorização concluída. Atualize AMAZON_SP_REFRESH_TOKEN por canal seguro; nenhum token foi exposto no retorno ou logs.',
    refresh_token_fingerprint: shortCredentialHash(refreshToken),
  });
});
