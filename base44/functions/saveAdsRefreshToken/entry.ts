/**
 * saveAdsRefreshToken — valida refresh token e profile esperado ANTES de persistir.
 * Payload compatível: { amazon_account_id?, refresh_token }
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import {
  adsBaseUrlForRegion,
  resolveAmazonAdsCredentials,
  shortCredentialHash,
  validAmazonAdsRefreshToken,
} from '../../shared/amazonCredentials.ts';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const refreshToken = String(body?.refresh_token || '').trim();
    if (!validAmazonAdsRefreshToken(refreshToken)) {
      return Response.json({ ok: false, error: 'Token inválido: formato Amazon Ads não reconhecido.' }, { status: 400 });
    }

    let accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ user_id: user.id }, '-updated_date', 20).catch(() => [] as any[]);
    if (body?.amazon_account_id) {
      accounts = accounts.filter((row: any) => String(row.id) === String(body.amazon_account_id));
    }
    const account = accounts[0] || null;
    if (!account) return Response.json({ ok: false, error: 'AmazonAccount não encontrada para o usuário autenticado.' }, { status: 404 });

    const credentials = resolveAmazonAdsCredentials();
    if (!credentials.clientId.value || !credentials.clientSecret.value) {
      return Response.json({ ok: false, error: 'ADS_CLIENT_ID ou ADS_CLIENT_SECRET não configurados na fonte canônica.' }, { status: 500 });
    }

    const tokenRes = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: credentials.clientId.value,
        client_secret: credentials.clientSecret.value,
      }).toString(),
    });
    const tokenData = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok || !tokenData?.access_token) {
      return Response.json({
        ok: false,
        error: 'ADS_REFRESH_TOKEN_VALIDATION_FAILED',
        amazon_error_code: tokenData?.error || null,
        amazon_status: tokenRes.status,
        message: String(tokenData?.error_description || tokenData?.error || `HTTP ${tokenRes.status}`).slice(0, 500),
        token_persisted: false,
      }, { status: 400 });
    }

    const expectedProfileId = String(account.ads_profile_id || credentials.profileId.value || '').trim();
    if (!expectedProfileId) {
      return Response.json({ ok: false, error: 'ADS_PROFILE_ID_MISSING', token_persisted: false }, { status: 409 });
    }

    const region = String(account.region || credentials.region || 'NA');
    const profilesRes = await fetch(`${adsBaseUrlForRegion(region)}/v2/profiles`, {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        'Amazon-Advertising-API-ClientId': credentials.clientId.value,
        Accept: 'application/json',
      },
    });
    const profilesPayload = await profilesRes.json().catch(() => ({}));
    if (!profilesRes.ok) {
      return Response.json({
        ok: false,
        error: 'ADS_PROFILE_VALIDATION_FAILED',
        amazon_error_code: profilesPayload?.code || profilesPayload?.error || null,
        amazon_status: profilesRes.status,
        message: String(profilesPayload?.details || profilesPayload?.message || `HTTP ${profilesRes.status}`).slice(0, 500),
        token_persisted: false,
      }, { status: 400 });
    }

    const profiles = Array.isArray(profilesPayload) ? profilesPayload : [];
    const expectedProfile = profiles.find((p: any) => String(p?.profileId || '') === expectedProfileId);
    if (!expectedProfile) {
      return Response.json({
        ok: false,
        error: 'ADS_EXPECTED_PROFILE_NOT_FOUND',
        expected_profile_id: expectedProfileId,
        profiles_found: profiles.length,
        token_persisted: false,
        message: 'O token não pertence ao profile Ads esperado; o token anterior foi preservado.',
      }, { status: 409 });
    }

    const now = new Date().toISOString();
    const expiresIn = Math.max(600, Number(tokenData?.expires_in || 3600));
    const expiresAt = new Date(Date.now() + Math.max((expiresIn * 1000) - (10 * 60 * 1000), 5 * 60 * 1000)).toISOString();
    const envToken = credentials.refreshToken.value;
    const envTokenPresent = Boolean(envToken);
    const tokenConflict = envTokenPresent && envToken !== refreshToken;

    await base44.asServiceRole.entities.AmazonAccount.update(account.id, {
      ads_refresh_token: refreshToken,
      ads_refresh_token_created_at: account.ads_refresh_token_created_at || now,
      ads_refresh_token_updated_at: now,
      ads_access_token: String(tokenData.access_token),
      ads_access_token_expires_at: expiresAt,
      ads_last_token_refresh_at: now,
      ads_last_verified_at: now,
      ads_token_status: 'active',
      ads_token_last_error: null,
      ads_requires_reauth: false,
      ads_credentials_error: false,
      ads_last_lwa_error_code: null,
      ads_last_lwa_status_code: null,
      ads_active_token_source: 'database',
      ads_env_token_present: envTokenPresent,
      ads_token_source_conflict: tokenConflict,
      profile_validation_status: 'valid',
      profile_validated_at: now,
      status: 'connected',
      error_message: null,
    });

    base44.asServiceRole.functions.invoke('checkAndForceReportPipeline', {
      _service_role: true,
      force: true,
      amazon_account_id: account.id,
    }).catch(() => {});

    return Response.json({
      ok: true,
      message: 'Token e profile Amazon Ads validados e salvos com sucesso.',
      account_id: account.id,
      expected_profile_validated: true,
      profiles_found: profiles.length,
      pipeline_triggered: true,
      environment_update_required: tokenConflict || !envTokenPresent,
      environment_warning: tokenConflict
        ? 'Banco e ADS_REFRESH_TOKEN da VPS divergem. Atualize o secret da VPS.'
        : (!envTokenPresent ? 'ADS_REFRESH_TOKEN não está presente no ambiente da VPS.' : null),
      diagnostics: {
        db_refresh_token_fingerprint: shortCredentialHash(refreshToken),
        env_refresh_token_fingerprint: shortCredentialHash(envToken),
        env_refresh_token_source: credentials.refreshToken.source,
      },
    });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || 'Erro inesperado' }, { status: 500 });
  }
});
