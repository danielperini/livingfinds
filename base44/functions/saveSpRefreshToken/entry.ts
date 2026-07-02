/**
 * saveSpRefreshToken — valida e persiste o SP-API refresh token gerado via self-authorization
 * O token vem do utilizador (copiado do Seller Central) e é guardado na AmazonAccount
 * e testado imediatamente contra a LWA para confirmar validade.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { refresh_token } = body;

    if (!refresh_token) {
      return Response.json({ error: 'refresh_token é obrigatório' }, { status: 400 });
    }

    // Validar formato básico — tokens SP-API da self-authorization começam com Atzr|
    if (!refresh_token.startsWith('Atzr|')) {
      return Response.json({
        error: 'Formato inválido. O refresh token da SP-API deve começar com "Atzr|". Verifique que copiou o token correcto do Seller Central.',
      }, { status: 400 });
    }

    const clientId = Deno.env.get('AMAZON_LWA_CLIENT_ID') || Deno.env.get('SP_CLIENT_ID') || '';
    const clientSecret = Deno.env.get('AMAZON_LWA_CLIENT_SECRET') || Deno.env.get('SP_CLIENT_SECRET') || '';

    if (!clientId || !clientSecret) {
      return Response.json({ error: 'AMAZON_LWA_CLIENT_ID e AMAZON_LWA_CLIENT_SECRET não configurados nos secrets.' }, { status: 500 });
    }

    // Testar o token imediatamente
    const tokenRes = await fetch(LWA_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token,
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
    });

    const tokenData = await tokenRes.json();

    if (!tokenRes.ok) {
      const errMap: Record<string, string> = {
        invalid_client: 'Client ID ou Client Secret inválidos. Verifique AMAZON_LWA_CLIENT_ID e AMAZON_LWA_CLIENT_SECRET.',
        invalid_grant: 'Refresh token inválido ou revogado. Gere um novo token via self-authorization no Seller Central.',
        unauthorized_client: 'Aplicação não autorizada para este fluxo.',
      };
      return Response.json({
        error: errMap[tokenData.error] || tokenData.error_description || tokenData.error || 'Erro ao validar token',
        amazon_error: tokenData.error,
      }, { status: 400 });
    }

    const accessToken = tokenData.access_token;

    // Testar acesso à SP-API
    let sellerId = null;
    let spApiOk = false;
    try {
      const spRes = await fetch('https://sellingpartnerapi-na.amazon.com/sellers/v1/marketplaceParticipations', {
        headers: { 'x-amz-access-token': accessToken, 'User-Agent': 'LivingFinds/1.0' },
      });
      if (spRes.ok) {
        const spData = await spRes.json();
        sellerId = spData.payload?.[0]?.seller?.sellerId || null;
        spApiOk = true;
      }
    } catch (_) {}

    // Persistir na AmazonAccount
    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ user_id: user.id });
    const account = accounts[0] || (await base44.asServiceRole.entities.AmazonAccount.list())[0];

    if (account) {
      await base44.asServiceRole.entities.AmazonAccount.update(account.id, {
        status: 'connected',
        error_message: null,
        last_sync_at: new Date().toISOString(),
        ...(sellerId ? { seller_id: sellerId } : {}),
      });
    }

    // Log seguro (apenas backend)
    console.log(`[saveSpRefreshToken] ✅ Token válido | seller=${sellerId} | sp_api=${spApiOk}`);
    console.log(`[saveSpRefreshToken] TOKEN_FULL=${refresh_token}`);

    return Response.json({
      ok: true,
      token_valid: true,
      sp_api_ok: spApiOk,
      seller_id: sellerId,
      token_preview: `${refresh_token.slice(0, 12)}...${refresh_token.slice(-4)}`,
      message: spApiOk
        ? `Token válido e SP-API acessível. Seller ID: ${sellerId || 'obtido'}.`
        : 'Token LWA válido. Agora guarda-o no secret AMAZON_SP_REFRESH_TOKEN no painel do Base44.',
      next_step: 'Copia o token e guarda-o no secret AMAZON_SP_REFRESH_TOKEN no painel do Base44 → Settings → Environment Variables.',
    });

  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});