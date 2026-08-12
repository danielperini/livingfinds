/**
 * exchangeAmazonAdsCode — troca code OAuth e só persiste o novo refresh token
 * depois de validar /v2/profiles e confirmar o profile esperado.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import {
  adsBaseUrlForRegion,
  resolveAdsOAuthRedirectUri,
  resolveAmazonAdsCredentials,
  shortCredentialHash,
} from '../../shared/amazonCredentials.ts';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const code = String(body?.code || '').trim();
    if (!code) return Response.json({ ok: false, error: 'code é obrigatório' }, { status: 400 });

    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ user_id: user.id }, '-updated_date', 1).catch(() => [] as any[]);
    const account = accounts[0];
    if (!account) return Response.json({ ok: false, error: 'AmazonAccount não encontrada para o usuário autenticado' }, { status: 404 });

    const credentials = resolveAmazonAdsCredentials();
    if (!credentials.clientId.value || !credentials.clientSecret.value) {
      return Response.json({ ok: false, error: 'ADS_CLIENT_ID ou ADS_CLIENT_SECRET não configurados na fonte canônica' }, { status: 500 });
    }

    let redirectUri = '';
    try {
      redirectUri = resolveAdsOAuthRedirectUri();
    } catch (error: any) {
      return Response.json({ ok: false, error: 'APP_BASE_URL_REQUIRED', message: error?.message || String(error) }, { status: 500 });
    }

    const tokenRes = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: credentials.clientId.value,
        client_secret: credentials.clientSecret.value,
      }),
    });
    const tokenData = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok) {
      return Response.json({
        ok: false,
        error: String(tokenData?.error || 'token_error'),
        error_description: String(tokenData?.error_description || 'Falha ao trocar código por token'),
        amazon_status: tokenRes.status,
      }, { status: 400 });
    }

    const refreshToken = String(tokenData?.refresh_token || '').trim();
    const accessToken = String(tokenData?.access_token || '').trim();
    const expiresIn = Math.max(600, Number(tokenData?.expires_in || 3600));
    if (!refreshToken || !accessToken) {
      return Response.json({ ok: false, error: 'TOKEN_EXCHANGE_INCOMPLETE', message: 'Amazon LWA não retornou refresh_token e access_token completos.' }, { status: 400 });
    }

    const expectedProfileId = String(account.ads_profile_id || credentials.profileId.value || '').trim();
    if (!expectedProfileId) {
      return Response.json({ ok: false, error: 'ADS_PROFILE_ID_MISSING', message: 'Configure ads_profile_id antes de reautorizar.' }, { status: 409 });
    }

    const region = String(account.region || credentials.region || 'NA');
    const profileRes = await fetch(`${adsBaseUrlForRegion(region)}/v2/profiles`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Amazon-Advertising-API-ClientId': credentials.clientId.value,
        Accept: 'application/json',
      },
    });
    const profilePayload = await profileRes.json().catch(() => ({}));
    if (!profileRes.ok) {
      const amazonErrorCode = String(profilePayload?.code || profilePayload?.error || `http_${profileRes.status}`);
      return Response.json({
        ok: false,
        error: 'ADS_PROFILE_VALIDATION_FAILED',
        amazon_error_code: amazonErrorCode,
        amazon_status: profileRes.status,
        message: String(profilePayload?.details || profilePayload?.message || profilePayload?.error_description || 'Falha ao validar profiles Amazon Ads').slice(0, 500),
        token_persisted: false,
      }, { status: 400 });
    }

    const profiles = Array.isArray(profilePayload) ? profilePayload : [];
    const expectedProfile = profiles.find((profile: any) => String(profile?.profileId || '') === expectedProfileId);
    if (!expectedProfile) {
      return Response.json({
        ok: false,
        error: 'ADS_EXPECTED_PROFILE_NOT_FOUND',
        amazon_status: profileRes.status,
        expected_profile_id: expectedProfileId,
        profiles_count: profiles.length,
        message: 'A conta Amazon autorizada não contém o profile Ads esperado. O token anterior foi preservado.',
        token_persisted: false,
      }, { status: 409 });
    }

    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + Math.max((expiresIn * 1000) - (10 * 60 * 1000), 5 * 60 * 1000)).toISOString();
    const envToken = credentials.refreshToken.value;
    const envTokenPresent = Boolean(envToken);
    const tokenConflict = envTokenPresent && envToken !== refreshToken;

    await base44.asServiceRole.entities.AmazonAccount.update(account.id, {
      ads_refresh_token: refreshToken,
      ads_refresh_token_created_at: account.ads_refresh_token_created_at || now,
      ads_refresh_token_updated_at: now,
      ads_access_token: accessToken,
      ads_access_token_expires_at: expiresAt,
      ads_last_token_refresh_at: now,
      ads_last_verified_at: now,
      ads_token_status: 'active',
      ads_token_last_error: null,
      ads_requires_reauth: false,
      ads_credentials_error: false,
      ads_last_lwa_error_code: null,
      ads_last_lwa_status_code: null,
      ads_token_refresh_in_progress: false,
      ads_token_refresh_started_at: null,
      ads_active_token_source: 'database',
      ads_env_token_present: envTokenPresent,
      ads_token_source_conflict: tokenConflict,
      profile_validation_status: 'valid',
      profile_validated_at: now,
      status: 'connected',
      error_message: null,
    });

    // Só retoma pipeline depois de token persistido e profile confirmado.
    base44.asServiceRole.functions.invoke('checkAndForceReportPipeline', {
      amazon_account_id: account.id,
      force: true,
      _service_role: true,
    }).catch(() => {});

    return Response.json({
      ok: true,
      message: 'Amazon Ads conectada e profile validado com sucesso.',
      expires_in: expiresIn,
      token_status: 'active',
      profiles_count: profiles.length,
      expected_profile_validated: true,
      profile: {
        profileId: expectedProfile.profileId,
        name: expectedProfile.accountInfo?.name || null,
        marketplace: expectedProfile.countryCode || null,
        type: expectedProfile.accountInfo?.type || null,
        timezone: expectedProfile.timezone || null,
      },
      account_updated: true,
      account_id: account.id,
      redirect_uri: redirectUri,
      environment_update_required: tokenConflict || !envTokenPresent,
      environment_warning: tokenConflict
        ? 'O refresh token do banco é mais novo/diferente do ADS_REFRESH_TOKEN da VPS. Atualize o secret da VPS antes do próximo deploy/restart.'
        : (!envTokenPresent ? 'ADS_REFRESH_TOKEN não está configurado no ambiente da VPS; o banco permanece a fonte canônica em runtime.' : null),
      diagnostics: {
        db_refresh_token_fingerprint: shortCredentialHash(refreshToken),
        env_refresh_token_fingerprint: shortCredentialHash(envToken),
        env_refresh_token_source: credentials.refreshToken.source,
      },
    });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || 'Erro interno' }, { status: 500 });
  }
});
