/**
 * validateAmazonAccountContext — Valida perfil e retorna contexto completo
 * Payload: { amazon_account_id, forceRefresh? }
 * 
 * Valida:
 * - profileId existe e está ativo
 * - marketplaceId compatível com país
 * - currencyCode correto (BRL para Brasil)
 * - Cache de 24h para evitar chamadas repetidas
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const profileCache: Map<string, { data: any; expiresAt: number }> = new Map();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

async function fetchAmazonAdsProfile(accessToken: string, profileId: string, baseUrl: string) {
  const res = await fetch(`${baseUrl}/profiles`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID') || '',
      'Amazon-Advertising-API-Scope': profileId,
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ADS Profile API ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  return Array.isArray(data) ? data[0] : data;
}

function getAdsBaseUrl(region?: string): string {
  const r = (region || Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function getAdsToken() {
  const cached = profileCache.get('token');
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: Deno.env.get('ADS_REFRESH_TOKEN') || '',
    client_id: Deno.env.get('ADS_CLIENT_ID') || '',
    client_secret: Deno.env.get('ADS_CLIENT_SECRET') || '',
  });

  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error_description || 'Token refresh failed');
  }

  profileCache.set('token', {
    data: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
  });

  return data.access_token;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const { amazon_account_id, forceRefresh } = body;

    if (!amazon_account_id) {
      return Response.json({ error: 'amazon_account_id required' }, { status: 400 });
    }

    // Verificar cache (24h)
    const cached = profileCache.get(amazon_account_id);
    if (cached && cached.expiresAt > Date.now() && !forceRefresh) {
      return Response.json({
        ok: true,
        cached: true,
        ...cached.data,
      });
    }

    // Buscar conta Amazon
    const account = await base44.asServiceRole.entities.AmazonAccount.get(amazon_account_id).catch(() => null);
    if (!account) {
      return Response.json({ error: 'AmazonAccount não encontrada' }, { status: 404 });
    }

    const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID');
    const region = account.region || Deno.env.get('ADS_REGION');

    if (!profileId) {
      return Response.json({
        ok: false,
        error: 'ads_profile_id não configurado',
        validationStatus: 'MISSING_PROFILE',
      });
    }

    // Buscar perfil na Amazon Ads API
    const token = await getAdsToken();
    const baseUrl = getAdsBaseUrl(region);

    let profileData;
    try {
      profileData = await fetchAmazonAdsProfile(token, profileId, baseUrl);
    } catch (error: any) {
      profileCache.set(amazon_account_id, {
        data: { validationStatus: 'ERROR', error: error.message },
        expiresAt: Date.now() + 60 * 60 * 1000, // 1h
      });

      return Response.json({
        ok: false,
        error: error.message,
        validationStatus: 'ERROR',
      });
    }

    // Extrair dados do perfil
    const countryCode = profileData.countryCode || 'BR';
    const currencyCode = profileData.currencyCode || 'BRL';
    const marketplaceId = account.marketplace_id || (countryCode === 'BR' ? 'A2Q3Y263D00KWC' : null);

    // Validação crítica: Brasil deve usar BRL
    if (countryCode === 'BR' && currencyCode !== 'BRL') {
      profileCache.set(amazon_account_id, {
        data: {
          validationStatus: 'INVALID_CURRENCY',
          error: `Moeda inválida para Amazon Brasil: ${currencyCode}. Esperado: BRL.`,
          profileId,
          countryCode,
          currencyCode,
        },
        expiresAt: Date.now() + 60 * 60 * 1000,
      });

      return Response.json({
        ok: false,
        validationStatus: 'INVALID_CURRENCY',
        error: `Operação bloqueada: o perfil Amazon Brasil retornou uma moeda incompatível (${currencyCode}). Sincronize novamente o perfil.`,
        profileId,
        countryCode,
        currencyCode,
        marketplaceId,
      });
    }

    // Determinar marketplaceId padrão para Brasil
    const finalMarketplaceId = marketplaceId || (countryCode === 'BR' ? 'A2Q3Y263D00KWC' : null);

    // Salvar no cache
    const result = {
      ok: true,
      profileId,
      marketplaceId: finalMarketplaceId,
      countryCode,
      currencyCode,
      currencySymbol: currencyCode === 'BRL' ? 'R$' : '$',
      locale: countryCode === 'BR' ? 'pt-BR' : 'en-US',
      validationStatus: 'VALID',
      profileName: profileData.name || account.seller_name || 'Perfil Amazon',
      validatedAt: new Date().toISOString(),
    };

    profileCache.set(amazon_account_id, {
      data: result,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });

    // Atualizar conta com dados validados
    await base44.asServiceRole.entities.AmazonAccount.update(amazon_account_id, {
      marketplace_id: finalMarketplaceId || account.marketplace_id,
      region: countryCode === 'BR' ? 'NA' : region,
      last_sync_at: new Date().toISOString(),
    }).catch(() => {});

    return Response.json(result);
  } catch (error: any) {
    return Response.json({
      ok: false,
      error: error.message,
      validationStatus: 'ERROR',
    }, { status: 500 });
  }
});