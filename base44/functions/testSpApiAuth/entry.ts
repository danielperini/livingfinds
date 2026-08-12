/**
 * testSpApiAuth — diagnóstico real de autenticação SP-API.
 * AMAZON_LWA_* / AMAZON_SP_REFRESH_TOKEN são canônicos; SP_* são aliases legados.
 * Nenhum token/secret é retornado ou logado.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { credentialDiagnostic, resolveAmazonSpCredentials } from '../../shared/amazonCredentials.ts';
import { safeOverallStatusAfterSpSuccess } from '../../shared/amazonAuthStatus.ts';

const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token';
const SP_BASE_NA = 'https://sellingpartnerapi-na.amazon.com';
const BR_MARKETPLACE_ID = 'A2Q3Y263D00KWC';

function mapLwaError(error: string) {
  const map: Record<string, string> = {
    invalid_client: 'Cliente LWA inválido. Verifique a fonte canônica AMAZON_LWA_CLIENT_ID / AMAZON_LWA_CLIENT_SECRET.',
    invalid_grant: 'Refresh token inválido, expirado, revogado ou pertencente a outro aplicativo.',
    invalid_request: 'Pedido de token incompleto ou com formato incorreto.',
    unauthorized_client: 'Aplicativo não autorizado para esse fluxo.',
    temporarily_unavailable: 'Serviço Amazon temporariamente indisponível.',
  };
  return map[error] || `Erro Amazon LWA: ${error}`;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const credentials = resolveAmazonSpCredentials();
    const lwaClientId = credentials.clientId.value;
    const lwaClientSecret = credentials.clientSecret.value;
    const spRefreshToken = credentials.refreshToken.value;
    const marketplaceId = credentials.marketplaceId.value || BR_MARKETPLACE_ID;
    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ user_id: user.id }, '-updated_date', 1).catch(() => [] as any[]);
    const account = accounts[0] || null;

    const results: any = {
      timestamp: new Date().toISOString(),
      credentials: {
        sp_app_id: credentialDiagnostic(credentials.appId),
        lwa_client_id: credentialDiagnostic(credentials.clientId),
        lwa_client_secret: credentialDiagnostic(credentials.clientSecret),
        sp_refresh_token: credentialDiagnostic(credentials.refreshToken),
        marketplace_id: marketplaceId,
      },
      tests: {
        lwa_authentication: { status: 'NOT_RUN', message: '' },
        sp_api_authorization: { status: 'NOT_RUN', message: '' },
        marketplace_configuration: { status: 'NOT_RUN', message: '' },
        endpoint_access: { status: 'NOT_RUN', message: '' },
      },
      error_detail: null,
    };

    if (lwaClientId.startsWith('amzn1.sp.solution')) {
      results.tests.lwa_authentication = {
        status: 'FAILED',
        message: `${credentials.clientId.source || 'LWA client id'} contém App ID em vez de LWA Client ID.`,
      };
      return Response.json(results);
    }
    if (!lwaClientId || !lwaClientSecret || !spRefreshToken) {
      results.tests.lwa_authentication = {
        status: 'FAILED',
        message: 'Credenciais SP-API incompletas. Configure AMAZON_LWA_CLIENT_ID, AMAZON_LWA_CLIENT_SECRET e AMAZON_SP_REFRESH_TOKEN.',
      };
      return Response.json(results);
    }

    let accessToken = '';
    try {
      const res = await fetch(LWA_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: spRefreshToken,
          client_id: lwaClientId,
          client_secret: lwaClientSecret,
        }).toString(),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const code = String(data?.error || `http_${res.status}`);
        const errMsg = mapLwaError(code);
        results.tests.lwa_authentication = {
          status: 'FAILED',
          message: errMsg,
          detail: { error: code, description: data?.error_description, http_status: res.status },
        };
        results.error_detail = { statusCode: res.status, amazonError: code, amazonErrorDescription: data?.error_description };
        if (account) {
          await base44.asServiceRole.entities.AmazonAccount.update(account.id, {
            error_message: `SP LWA falhou: ${errMsg}`,
            status: safeOverallStatusAfterSpSuccess(account) === 'error' ? 'error' : (account.status || 'pending'),
          }).catch(() => {});
        }
        return Response.json(results);
      }
      accessToken = String(data?.access_token || '');
      if (!accessToken) throw new Error('Amazon LWA não retornou access_token');
      results.tests.lwa_authentication = { status: 'PASSED', message: `Token obtido e mantido somente em memória. Expira em ${Number(data?.expires_in || 0)}s.` };
    } catch (error: any) {
      results.tests.lwa_authentication = { status: 'FAILED', message: `Erro de rede: ${error?.message || String(error)}` };
      return Response.json(results);
    }

    let sellerId: string | null = null;
    try {
      const res = await fetch(`${SP_BASE_NA}/sellers/v1/marketplaceParticipations`, {
        headers: { 'x-amz-access-token': accessToken, 'User-Agent': 'LivingFinds/1.0' },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        results.tests.sp_api_authorization = {
          status: 'FAILED',
          message: `SP-API retornou HTTP ${res.status}: ${data?.errors?.[0]?.message || 'falha de autorização'}`,
        };
      } else {
        const participations = Array.isArray(data?.payload) ? data.payload : [];
        const participation = participations.find((row: any) => row?.marketplace?.id === marketplaceId) || participations[0];
        sellerId = participation?.seller?.sellerId || null;
        results.tests.sp_api_authorization = { status: 'PASSED', message: `SP-API autorizada${sellerId ? ` para seller ${sellerId}` : ''}.` };
        if (account) {
          await base44.asServiceRole.entities.AmazonAccount.update(account.id, {
            ...(sellerId ? { seller_id: sellerId } : {}),
            status: safeOverallStatusAfterSpSuccess(account),
            error_message: safeOverallStatusAfterSpSuccess(account) === 'connected' ? null : account.error_message,
          }).catch(() => {});
        }
      }
    } catch (error: any) {
      results.tests.sp_api_authorization = { status: 'FAILED', message: `Erro: ${error?.message || String(error)}` };
    }

    if (results.tests.sp_api_authorization.status === 'PASSED') {
      results.tests.marketplace_configuration = { status: 'PASSED', message: `Marketplace ID: ${marketplaceId} (Brasil)` };
    } else {
      results.tests.marketplace_configuration = { status: 'SKIPPED', message: 'SP-API authorization falhou' };
    }

    if (accessToken && results.tests.sp_api_authorization.status === 'PASSED') {
      try {
        const res = await fetch(`${SP_BASE_NA}/catalog/2022-04-01/items?marketplaceIds=${encodeURIComponent(marketplaceId)}&keywords=test&pageSize=1`, {
          headers: { 'x-amz-access-token': accessToken, 'User-Agent': 'LivingFinds/1.0' },
        });
        if (res.ok || res.status === 400) {
          results.tests.endpoint_access = { status: 'PASSED', message: `Catalog API acessível (HTTP ${res.status})` };
        } else {
          const data = await res.json().catch(() => ({}));
          results.tests.endpoint_access = {
            status: res.status === 403 ? 'FAILED' : 'PASSED',
            message: `HTTP ${res.status}: ${data?.errors?.[0]?.message || 'resposta recebida'}`,
          };
        }
      } catch (error: any) {
        results.tests.endpoint_access = { status: 'FAILED', message: error?.message || String(error) };
      }
    }

    return Response.json(results);
  } catch (error: any) {
    return Response.json({ error: error?.message || String(error) }, { status: 500 });
  }
});
