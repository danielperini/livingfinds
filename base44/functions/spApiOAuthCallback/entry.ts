/**
 * spApiOAuthCallback — troca o authorization code pelo SP-API refresh token
 * Chame com: { code: "...", redirect_uri: "..." }
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const code = body.code;
    const redirectUri = body.redirect_uri;

    if (!code) return Response.json({ error: 'Parâmetro "code" obrigatório' }, { status: 400 });

    const clientId = Deno.env.get('SP_CLIENT_ID') || '';
    const clientSecret = Deno.env.get('SP_CLIENT_SECRET') || '';

    if (!clientId || !clientSecret) {
      return Response.json({ error: 'SP_CLIENT_ID e SP_CLIENT_SECRET não configurados' }, { status: 500 });
    }

    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      client_secret: clientSecret,
      ...(redirectUri ? { redirect_uri: redirectUri } : {}),
    });

    const res = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    const data = await res.json();

    if (!res.ok) {
      return Response.json({
        error: data.error_description || data.error || 'Token exchange failed',
        raw: data,
      }, { status: 400 });
    }

    return Response.json({
      ok: true,
      refresh_token: data.refresh_token,
      access_token: data.access_token,
      expires_in: data.expires_in,
      token_type: data.token_type,
      message: 'Copie o refresh_token e configure como secret SP_REFRESH_TOKEN',
    });

  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});