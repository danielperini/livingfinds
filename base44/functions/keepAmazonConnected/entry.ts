/**
 * keepAmazonConnected — Garante que a conta Amazon permaneça conectada
 *
 * Executa:
 *  1. Sincroniza ADS_REFRESH_TOKEN (secret) → AmazonAccount.ads_refresh_token
 *  2. Valida o token tentando obter um access token
 *  3. Verifica o profile ID chamando /v2/profiles
 *  4. Atualiza status da conta para 'connected' ou 'error' com mensagem clara
 *
 * Chamado pelo scheduler a cada 30 minutos para manter a conexão sempre válida.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

async function tryGetAccessToken(refreshToken: string): Promise<{ ok: boolean; token?: string; error?: string }> {
  const clientId = Deno.env.get('ADS_CLIENT_ID') || '';
  const clientSecret = Deno.env.get('ADS_CLIENT_SECRET') || '';
  if (!refreshToken || !clientId || !clientSecret) {
    return { ok: false, error: 'Credenciais incompletas: ADS_CLIENT_ID, ADS_CLIENT_SECRET ou refresh_token ausentes' };
  }
  try {
    const response = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.access_token) {
      return { ok: false, error: data.error_description || data.error || `HTTP ${response.status}` };
    }
    return { ok: true, token: data.access_token };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'Erro de rede ao obter token' };
  }
}

async function validateProfile(accessToken: string, profileId: string): Promise<{ ok: boolean; profile?: any; error?: string }> {
  try {
    const response = await fetch('https://advertising-api.amazon.com/v2/profiles', {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID') || '',
      },
    });
    const profiles = await response.json().catch(() => []);
    if (!response.ok) return { ok: false, error: `Profiles HTTP ${response.status}` };
    const found = Array.isArray(profiles) ? profiles.find((p: any) => String(p.profileId) === String(profileId)) : null;
    if (!found) return { ok: false, error: `Profile ${profileId} não encontrado na conta. Profiles disponíveis: ${Array.isArray(profiles) ? profiles.map((p: any) => p.profileId).join(', ') : 'nenhum'}` };
    return { ok: true, profile: found };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'Erro ao validar profile' };
  }
}

Deno.serve(async (request) => {
  const startedAt = new Date().toISOString();
  try {
    const base44 = createClientFromRequest(request);

    // Aceita chamada interna (service role) ou autenticada
    const body = await request.json().catch(() => ({}));
    if (!body._service_role) {
      const user = await base44.auth.me().catch(() => null);
      if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    // Carregar todas as contas
    const accounts = await base44.asServiceRole.entities.AmazonAccount.list();
    if (!accounts.length) return Response.json({ ok: false, error: 'Nenhuma conta Amazon cadastrada' });

    const results: any[] = [];

    for (const account of accounts) {
      const aid = account.id;
      const now = new Date().toISOString();

      // 1. Fonte primária: secret — sempre prevalece sobre o valor na entidade
      const secretToken = Deno.env.get('ADS_REFRESH_TOKEN') || '';
      const entityToken = account.ads_refresh_token || '';
      const refreshToken = secretToken || entityToken;

      if (!refreshToken) {
        await base44.asServiceRole.entities.AmazonAccount.update(aid, {
          status: 'error',
          error_message: 'ADS_REFRESH_TOKEN não configurado. Configure em Configurações → Variáveis de Ambiente.',
        }).catch(() => {});
        results.push({ account_id: aid, status: 'error', error: 'refresh_token ausente' });
        continue;
      }

      // 2. Sincronizar token para entidade se divergente
      if (secretToken && secretToken !== entityToken) {
        await base44.asServiceRole.entities.AmazonAccount.update(aid, {
          ads_refresh_token: secretToken,
        }).catch(() => {});
      }

      // 3. Validar token (obter access_token)
      const tokenResult = await tryGetAccessToken(refreshToken);
      if (!tokenResult.ok) {
        await base44.asServiceRole.entities.AmazonAccount.update(aid, {
          status: 'error',
          error_message: `Token inválido: ${tokenResult.error}. Refaça a autorização em /amazon-oauth-setup.`,
        }).catch(() => {});
        results.push({ account_id: aid, status: 'error', error: tokenResult.error });
        continue;
      }

      // 4. Validar profile
      const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID') || '';
      let profileOk = true;
      let profileData: any = null;

      if (profileId) {
        const profileResult = await validateProfile(tokenResult.token!, profileId);
        if (!profileResult.ok) {
          await base44.asServiceRole.entities.AmazonAccount.update(aid, {
            status: 'error',
            error_message: `Profile inválido: ${profileResult.error}`,
            profile_validation_status: 'invalid',
          }).catch(() => {});
          results.push({ account_id: aid, status: 'error', error: profileResult.error });
          profileOk = false;
          continue;
        }
        profileData = profileResult.profile;
      }

      // 5. Tudo OK — marcar como connected
      await base44.asServiceRole.entities.AmazonAccount.update(aid, {
        status: 'connected',
        error_message: null,
        profile_validation_status: profileId ? 'valid' : 'pending',
        profile_validated_at: profileId ? now : account.profile_validated_at,
        last_sync_at: account.last_sync_at, // não sobrescreve o último sync real
      }).catch(() => {});

      results.push({
        account_id: aid,
        status: 'connected',
        token_refreshed: secretToken !== entityToken,
        profile_id: profileId,
        profile_name: profileData?.accountInfo?.name || null,
        marketplace: profileData?.countryCode || null,
      });
    }

    const allOk = results.every(r => r.status === 'connected');

    return Response.json({
      ok: allOk,
      checked_at: startedAt,
      accounts: results,
      summary: `${results.filter(r => r.status === 'connected').length}/${results.length} contas conectadas`,
    });

  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || 'Erro no health-check Amazon' }, { status: 500 });
  }
});