/**
 * validateAmazonAdsProfile — Valida perfil Amazon Ads e retorna contexto completo
 * Payload: { amazon_account_id, forceRefresh? }
 * Retorna: profileId, marketplaceId, countryCode, currencyCode, currencySymbol, locale
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 horas
const profileCache = new Map<string, { data: any; expiresAt: number }>();

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { amazon_account_id, forceRefresh } = body;
    
    if (!amazon_account_id) {
      return Response.json({ error: 'amazon_account_id required' }, { status: 400 });
    }

    const account = await base44.asServiceRole.entities.AmazonAccount.get(amazon_account_id).catch(() => null);
    if (!account) {
      return Response.json({ error: 'AmazonAccount não encontrada' }, { status: 404 });
    }

    const profileId = account.ads_profile_id;
    if (!profileId) {
      return Response.json({ error: 'ads_profile_id não configurado', requires_connection: true }, { status: 400 });
    }

    const cacheKey = `${amazon_account_id}:${profileId}`;
    const cached = profileCache.get(cacheKey);
    
    if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
      return Response.json({
        ok: true, cached: true, profile: cached.data,
        marketplaceId: cached.data.marketplaceId,
        countryCode: cached.data.countryCode,
        currencyCode: cached.data.currencyCode,
        currencySymbol: cached.data.currencyCode === 'BRL' ? 'R$' : '$',
        locale: cached.data.countryCode === 'BR' ? 'pt-BR' : 'en-US',
      });
    }

    const refreshToken = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN');
    if (!refreshToken) {
      return Response.json({ error: 'Sem refresh_token', requires_reauth: true }, { status: 400 });
    }

    const tokenParams = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: Deno.env.get('ADS_CLIENT_ID'),
      client_secret: Deno.env.get('ADS_CLIENT_SECRET'),
    });

    const tokenRes = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenParams.toString(),
    });

    if (!tokenRes.ok) {
      const tokenData = await tokenRes.json();
      return Response.json({
        error: 'Falha na autenticação Amazon Ads',
        amazon_error: tokenData.error_description || tokenData.error,
        requires_reauth: true,
      }, { status: 401 });
    }

    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;

    const region = (account.region || 'NA').toUpperCase();
    let baseUrl = 'https://advertising-api.amazon.com';
    if (region.includes('EU')) baseUrl = 'https://advertising-api-eu.amazon.com';
    if (region.includes('FE')) baseUrl = 'https://advertising-api-fe.amazon.com';

    const profileRes = await fetch(`${baseUrl}/profiles`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID'),
        'Amazon-Advertising-API-Scope': profileId,
        'Accept': 'application/json',
      },
    });

    if (!profileRes.ok) {
      const profileText = await profileRes.text();
      return Response.json({
        error: `Falha ao buscar perfil ${profileId}`,
        amazon_status: profileRes.status,
        amazon_error: profileText.slice(0, 200),
      }, { status: 400 });
    }

    const profiles = await profileRes.json();
    const profile = Array.isArray(profiles) ? profiles.find((p: any) => String(p.profileId) === String(profileId)) : null;
    
    if (!profile) {
      return Response.json({ error: `Profile ${profileId} não encontrado`, requires_reauth: true }, { status: 404 });
    }

    const profileData: any = {
      profileId: String(profile.profileId),
      countryCode: profile.countryCode || 'BR',
      currencyCode: profile.currencyCode || 'BRL',
      timezone: profile.timezone,
      accountType: profile.accountType || 'seller',
      accountId: profile.accountId,
      name: profile.name,
      status: profile.status,
      marketplaceId: profile.marketplaceId || null,
    };

    const errors: string[] = [];
    const warnings: string[] = [];

    if (profileData.countryCode === 'BR' && profileData.currencyCode !== 'BRL') {
      errors.push(`Moeda incompatível para Brasil: ${profileData.currencyCode}. Esperado: BRL.`);
    }

    if (profileData.status !== 'ACTIVE') {
      warnings.push(`Perfil status: ${profileData.status}`);
    }

    await base44.asServiceRole.entities.AmazonAccount.update(amazon_account_id, {
      marketplace_id: profileData.marketplaceId || account.marketplace_id,
      region: profileData.countryCode === 'BR' ? 'NA' : region,
      status: errors.length > 0 ? 'error' : 'connected',
      error_message: errors.join('; ') || null,
      last_sync_at: new Date().toISOString(),
    });

    profileCache.set(cacheKey, { data: profileData, expiresAt: Date.now() + CACHE_TTL_MS });

    await base44.asServiceRole.entities.LearningEvent.create({
      amazon_account_id,
      event_type: 'profile_validated',
      entity_type: 'account',
      entity_id: amazon_account_id,
      observation: `Perfil ${profileId} validado. País: ${profileData.countryCode}, Moeda: ${profileData.currencyCode}`,
      recorded_at: new Date().toISOString(),
    }).catch(() => {});

    return Response.json({
      ok: errors.length === 0,
      cached: false,
      profile: profileData,
      marketplaceId: profileData.marketplaceId,
      countryCode: profileData.countryCode,
      currencyCode: profileData.currencyCode,
      currencySymbol: profileData.currencyCode === 'BRL' ? 'R$' : '$',
      locale: profileData.countryCode === 'BR' ? 'pt-BR' : 'en-US',
      errors: errors.length > 0 ? errors : null,
      warnings: warnings.length > 0 ? warnings : null,
      validation_timestamp: new Date().toISOString(),
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});