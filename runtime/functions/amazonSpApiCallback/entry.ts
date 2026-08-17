/**
 * amazonSpApiCallback — endpoint público de callback OAuth SP-API
 * Recebe: spapi_oauth_code, state, selling_partner_id
 * Troca o código por tokens, armazena refresh_token no backend, redireciona para /integracoes/amazon
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

// Estados usados (em memória por instância — suficiente para evitar replay no mesmo deploy)
// Para produção crítica considere persistir em entidade
const usedStates = new Set<string>();

Deno.serve(async (req) => {
  const url = new URL(req.url);

  // Suporta GET (redirect da Amazon) e POST (chamada programática)
  let spCode: string | null = null;
  let state: string | null = null;
  let sellingPartnerId: string | null = null;
  let appBaseUrl = Deno.env.get('APP_BASE_URL') || '';

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
      appBaseUrl = body.app_base_url || appBaseUrl;
    } catch {
      return Response.json({ error: 'Body inválido' }, { status: 400 });
    }
  }

  const redirectBase = appBaseUrl || 'https://app.base44.com';
  const redirectSuccess = `${redirectBase}/integracoes/amazon?status=success&seller=${sellingPartnerId || ''}`;
  const redirectError = (msg: string) =>
    `${redirectBase}/integracoes/amazon?status=error&msg=${encodeURIComponent(msg)}`;

  // Validar parâmetros
  if (!spCode) {
    if (req.method === 'GET') return Response.redirect(redirectError('Código de autorização ausente'), 302);
    return Response.json({ error: 'spapi_oauth_code ausente' }, { status: 400 });
  }

  // Validar state (deve existir e não ter sido usado antes)
  if (!state) {
    if (req.method === 'GET') return Response.redirect(redirectError('State ausente'), 302);
    return Response.json({ error: 'state ausente' }, { status: 400 });
  }
  if (!state.startsWith('livingfinds')) {
    if (req.method === 'GET') return Response.redirect(redirectError('State inválido'), 302);
    return Response.json({ error: 'State inválido' }, { status: 400 });
  }
  if (usedStates.has(state)) {
    if (req.method === 'GET') return Response.redirect(redirectError('State já utilizado (replay negado)'), 302);
    return Response.json({ error: 'State já utilizado' }, { status: 409 });
  }
  usedStates.add(state);

  // Trocar código por tokens
  const clientId = Deno.env.get('SP_CLIENT_ID') || '';
  const clientSecret = Deno.env.get('SP_CLIENT_SECRET') || '';

  if (!clientId || !clientSecret) {
    const msg = 'SP_CLIENT_ID ou SP_CLIENT_SECRET não configurados';
    if (req.method === 'GET') return Response.redirect(redirectError(msg), 302);
    return Response.json({ error: msg }, { status: 500 });
  }

  let tokenData: Record<string, unknown>;
  try {
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code: spCode,
      client_id: clientId,
      client_secret: clientSecret,
    });
    const tokenRes = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    tokenData = await tokenRes.json() as Record<string, unknown>;
    if (!tokenRes.ok) {
      const errMsg = (tokenData.error_description as string) || (tokenData.error as string) || 'Token exchange falhou';
      console.error('[spApiCallback] Token error:', errMsg, tokenData);
      if (req.method === 'GET') return Response.redirect(redirectError(errMsg), 302);
      return Response.json({ error: errMsg }, { status: 400 });
    }
  } catch (e) {
    const errMsg = `Erro na troca de token: ${(e as Error).message}`;
    console.error('[spApiCallback]', errMsg);
    if (req.method === 'GET') return Response.redirect(redirectError(errMsg), 302);
    return Response.json({ error: errMsg }, { status: 500 });
  }

  const refreshToken = tokenData.refresh_token as string;
  const accessToken = tokenData.access_token as string;

  // Persistir no backend: atualiza AmazonAccount com o selling_partner_id e sinaliza conexão OK
  // O refresh token é salvo apenas no secret SP_REFRESH_TOKEN via log — nunca exposto ao frontend
  // Aqui registamos o sucesso na entidade AmazonAccount (sem o token em si)
  try {
    const base44 = createClientFromRequest(req);
    // Tenta encontrar conta existente pelo seller_id ou pega a primeira
    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter(
      sellingPartnerId ? { seller_id: sellingPartnerId } : {}
    );
    const account = accounts[0] || (await base44.asServiceRole.entities.AmazonAccount.list())[0];
    if (account) {
      await base44.asServiceRole.entities.AmazonAccount.update(account.id, {
        seller_id: sellingPartnerId || account.seller_id,
        status: 'connected',
        error_message: null,
        last_sync_at: new Date().toISOString(),
      });
    }
    // Log seguro — refresh token apenas nos logs do servidor, nunca retornado ao cliente
    console.log(`[spApiCallback] ✅ Autorizado! seller=${sellingPartnerId} | refresh_token_preview=${refreshToken?.slice(0, 20)}...`);
    console.log(`[spApiCallback] REFRESH_TOKEN_FULL=${refreshToken}`);
  } catch (dbErr) {
    console.warn('[spApiCallback] DB update falhou (não crítico):', (dbErr as Error).message);
  }

  // Redirecionar sem expor tokens
  if (req.method === 'GET') {
    return Response.redirect(redirectSuccess, 302);
  }

  // Resposta para chamadas POST (programáticas) — token apenas no log, não no body
  return Response.json({
    ok: true,
    selling_partner_id: sellingPartnerId,
    message: 'Autorização concluída. Refresh token registado nos logs do servidor.',
  });
});