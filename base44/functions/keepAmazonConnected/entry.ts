/**
 * keepAmazonConnected — Sincroniza token local (secret → entidade).
 *
 * ZERO chamadas de API externa. Apenas mantém sincronizado o refresh token
 * do secret com a entidade AmazonAccount. Valida credenciais apenas se
 * force_validate=true for passado explicitamente (chamada manual/diagnóstico).
 *
 * Rodando 1x/dia, substitui o loop de 30 min anterior que gerava 96 chamadas/dia.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

async function tryGetAccessToken(refreshToken: string): Promise<{ ok: boolean; token?: string; error?: string }> {
  const clientId = Deno.env.get('ADS_CLIENT_ID') || '';
  const clientSecret = Deno.env.get('ADS_CLIENT_SECRET') || '';
  if (!refreshToken || !clientId || !clientSecret) {
    return { ok: false, error: 'Credenciais incompletas' };
  }
  try {
    const response = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.access_token) return { ok: false, error: data.error_description || data.error || `HTTP ${response.status}` };
    return { ok: true, token: data.access_token };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'Erro de rede' };
  }
}

Deno.serve(async (request) => {
  const startedAt = new Date().toISOString();
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    if (!body._service_role) {
      const user = await base44.auth.me().catch(() => null);
      if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const forceValidate = body.force_validate === true;
    const accounts = await base44.asServiceRole.entities.AmazonAccount.list();
    if (!accounts.length) return Response.json({ ok: false, error: 'Nenhuma conta Amazon cadastrada' });

    const results: any[] = [];

    for (const account of accounts) {
      const aid = account.id;
      const now = new Date().toISOString();
      const secretToken = Deno.env.get('ADS_REFRESH_TOKEN') || '';
      const entityToken = account.ads_refresh_token || '';
      const refreshToken = secretToken || entityToken;

      if (!refreshToken) {
        await base44.asServiceRole.entities.AmazonAccount.update(aid, {
          status: 'error',
          error_message: 'ADS_REFRESH_TOKEN não configurado.',
        }).catch(() => {});
        results.push({ account_id: aid, status: 'error', error: 'refresh_token ausente' });
        continue;
      }

      // Sincronizar token secret → entidade (sem chamada de API)
      if (secretToken && secretToken !== entityToken) {
        await base44.asServiceRole.entities.AmazonAccount.update(aid, {
          ads_refresh_token: secretToken,
        }).catch(() => {});
      }

      // Validação com API apenas quando explicitamente solicitada (diagnóstico manual)
      if (forceValidate) {
        const tokenResult = await tryGetAccessToken(refreshToken);
        if (!tokenResult.ok) {
          await base44.asServiceRole.entities.AmazonAccount.update(aid, {
            status: 'error',
            error_message: `Token inválido: ${tokenResult.error}. Refaça a autorização em /amazon-oauth-setup.`,
          }).catch(() => {});
          results.push({ account_id: aid, status: 'error', error: tokenResult.error });
          continue;
        }
      }

      // Marcar como conectado (sync local concluído)
      if (account.status !== 'connected' || secretToken !== entityToken) {
        await base44.asServiceRole.entities.AmazonAccount.update(aid, {
          status: 'connected',
          error_message: null,
        }).catch(() => {});
      }

      results.push({
        account_id: aid,
        status: 'connected',
        token_synced: secretToken !== entityToken,
        validated_api: forceValidate,
      });
    }

    return Response.json({
      ok: results.every(r => r.status === 'connected'),
      checked_at: startedAt,
      accounts: results,
      summary: `${results.filter(r => r.status === 'connected').length}/${results.length} contas sincronizadas`,
    });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || 'Erro no sync local' }, { status: 500 });
  }
});