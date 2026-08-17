/**
 * testSpApiAuth — diagnóstico completo de autenticação SP-API
 * Testa: LWA token, SP-API authorization, marketplace, endpoint access
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token';

function maskSecret(s) {
  if (!s) return 'NÃO CONFIGURADO';
  if (s.length <= 12) return s.slice(0, 4) + '***';
  return s.slice(0, 8) + '...' + s.slice(-4);
}

function mapLwaError(error) {
  const map = {
    invalid_client: 'Cliente LWA inválido. Verifique o AMAZON_LWA_CLIENT_ID e AMAZON_LWA_CLIENT_SECRET.',
    invalid_grant: 'Refresh token inválido, expirado, revogado ou pertencente a outro aplicativo.',
    invalid_request: 'Pedido de token incompleto ou com formato incorreto.',
    unauthorized_client: 'Aplicativo não autorizado para esse fluxo.',
    temporarily_unavailable: 'Serviço Amazon temporariamente indisponível.',
  };
  return map[error] || `Erro desconhecido: ${error}`;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const lwaClientId = Deno.env.get('AMAZON_LWA_CLIENT_ID') || '';
    const lwaClientSecret = Deno.env.get('AMAZON_LWA_CLIENT_SECRET') || '';
    const spRefreshToken = Deno.env.get('AMAZON_SP_REFRESH_TOKEN') || '';
    const spAppId = Deno.env.get('AMAZON_SP_APP_ID') || '';
    const marketplaceId = Deno.env.get('AMAZON_MARKETPLACE_ID') || 'A2Q3Y263D00KWC';

    const results = {
      timestamp: new Date().toISOString(),
      credentials: {
        sp_app_id: maskSecret(spAppId),
        lwa_client_id: maskSecret(lwaClientId),
        lwa_client_secret: lwaClientSecret ? 'configurado' : 'ausente',
        sp_refresh_token: spRefreshToken ? 'configurado' : 'ausente',
        marketplace_id: marketplaceId,
      },
      tests: {
        lwa_authentication: { status: 'NOT_RUN', message: '' },
        sp_api_authorization: { status: 'NOT_RUN', message: '' },
        marketplace_configuration: { status: 'NOT_RUN', message: '' },
        endpoint_access: { status: 'NOT_RUN', message: '' },
      },
      access_token_preview: null,
      error_detail: null,
    };

    // Validação básica de formato
    if (lwaClientId.startsWith('amzn1.sp.solution')) {
      results.tests.lwa_authentication = {
        status: 'FAILED',
        message: 'AMAZON_LWA_CLIENT_ID contém um App ID (amzn1.sp.solution...) em vez do LWA Client ID (amzn1.application-oa2-client...). Corrija o secret.',
      };
      return Response.json(results);
    }
    if (!lwaClientId) {
      results.tests.lwa_authentication = { status: 'FAILED', message: 'AMAZON_LWA_CLIENT_ID não configurado.' };
      return Response.json(results);
    }
    if (!lwaClientSecret) {
      results.tests.lwa_authentication = { status: 'FAILED', message: 'AMAZON_LWA_CLIENT_SECRET não configurado.' };
      return Response.json(results);
    }
    if (!spRefreshToken) {
      results.tests.lwa_authentication = { status: 'FAILED', message: 'AMAZON_SP_REFRESH_TOKEN não configurado. Autorize a conta no Seller Central.' };
      return Response.json(results);
    }

    // TEST 1: LWA token
    let accessToken = null;
    try {
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: spRefreshToken,
        client_id: lwaClientId,
        client_secret: lwaClientSecret,
      });
      const res = await fetch(LWA_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: body.toString(),
      });
      const data = await res.json();
      if (!res.ok) {
        const errMsg = mapLwaError(data.error);
        results.tests.lwa_authentication = {
          status: 'FAILED',
          message: errMsg,
          detail: { error: data.error, description: data.error_description, http_status: res.status },
        };
        results.error_detail = { statusCode: res.status, amazonError: data.error, amazonErrorDescription: data.error_description };
        await base44.asServiceRole.entities.AmazonAccount.updateMany(
          {},
          { $set: { error_message: `LWA falhou: ${errMsg}`, status: 'error' } }
        ).catch(() => {});
        return Response.json(results);
      }
      accessToken = data.access_token;
      results.tests.lwa_authentication = { status: 'PASSED', message: `Token obtido. Expira em ${data.expires_in}s.` };
      results.access_token_preview = maskSecret(accessToken);
    } catch (e) {
      results.tests.lwa_authentication = { status: 'FAILED', message: `Erro de rede: ${e.message}` };
      return Response.json(results);
    }

    // TEST 2: SP-API authorization — marketplaceParticipations
    const spBase = 'https://sellingpartnerapi-na.amazon.com';
    let sellerId = null;
    try {
      const res = await fetch(`${spBase}/sellers/v1/marketplaceParticipations`, {
        headers: { 'x-amz-access-token': accessToken, 'User-Agent': 'LivingFinds/1.0' },
      });
      const data = await res.json();
      if (!res.ok) {
        results.tests.sp_api_authorization = {
          status: 'FAILED',
          message: `SP-API retornou HTTP ${res.status}: ${data.errors?.[0]?.message || JSON.stringify(data).slice(0, 200)}`,
        };
      } else {
        const participation = data.payload?.[0];
        sellerId = participation?.seller?.sellerId || null;
        results.tests.sp_api_authorization = { status: 'PASSED', message: `Seller ID: ${sellerId || 'obtido'}` };
        if (sellerId) {
          await base44.asServiceRole.entities.AmazonAccount.updateMany(
            {},
            { $set: { seller_id: sellerId, status: 'connected', error_message: null } }
          ).catch(() => {});
        }
      }
    } catch (e) {
      results.tests.sp_api_authorization = { status: 'FAILED', message: `Erro: ${e.message}` };
    }

    // TEST 3: Marketplace
    if (results.tests.sp_api_authorization.status === 'PASSED') {
      results.tests.marketplace_configuration = {
        status: 'PASSED',
        message: `Marketplace ID: ${marketplaceId} (Brasil)`,
      };
    } else {
      results.tests.marketplace_configuration = { status: 'SKIPPED', message: 'SP-API authorization falhou' };
    }

    // TEST 4: Catalog endpoint
    if (accessToken && results.tests.sp_api_authorization.status === 'PASSED') {
      try {
        const res = await fetch(`${spBase}/catalog/2022-04-01/items?marketplaceIds=${marketplaceId}&keywords=test&pageSize=1`, {
          headers: { 'x-amz-access-token': accessToken, 'User-Agent': 'LivingFinds/1.0' },
        });
        if (res.ok || res.status === 400) {
          results.tests.endpoint_access = { status: 'PASSED', message: `Catalog API acessível (HTTP ${res.status})` };
        } else {
          const d = await res.json().catch(() => ({}));
          results.tests.endpoint_access = {
            status: res.status === 403 ? 'FAILED' : 'PASSED',
            message: `HTTP ${res.status}: ${d.errors?.[0]?.message || 'resposta recebida'}`,
          };
        }
      } catch (e) {
        results.tests.endpoint_access = { status: 'FAILED', message: e.message };
      }
    }

    return Response.json(results);
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});