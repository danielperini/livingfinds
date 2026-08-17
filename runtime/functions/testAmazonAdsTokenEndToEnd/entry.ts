/**
 * testAmazonAdsTokenEndToEnd — diagnóstico real de OAuth Amazon Ads
 *
 * Não confia apenas em campos preenchidos. Para marcar operacional:
 * 1. força refresh real via amazonAdsTokenManager;
 * 2. chama /v2/profiles;
 * 3. confirma o profile ativo salvo na conta.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function adsBase(region: string | undefined): string {
  const r = String(region || Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

function profileIdOf(profile: any): string {
  return String(profile?.profileId || profile?.profile_id || profile?.id || '');
}

function countryOf(profile: any): string | null {
  return profile?.countryCode || profile?.country_code || profile?.marketplaceStringId || profile?.accountInfo?.countryCode || null;
}

function typeOf(profile: any): string | null {
  return profile?.accountInfo?.type || profile?.type || profile?.accountInfo?.accountType || null;
}

function safeError(result: any): string {
  return String(result?.message || result?.error || result?.error_safe || result?.errors?.[0]?.message || 'Erro desconhecido').slice(0, 500);
}

async function logDiagnostic(base44: any, accountId: string, status: string, message: string, records = 0) {
  await base44.asServiceRole.entities.SyncExecutionLog.create({
    amazon_account_id: accountId,
    operation: 'amazon_ads:end_to_end_token_diagnostic',
    status,
    trigger_type: 'manual',
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    records_processed: records,
    result_summary: status === 'success' ? message.slice(0, 4000) : null,
    error_message: status !== 'success' ? message.slice(0, 500) : null,
  }).catch(() => {});
}

Deno.serve(async (req) => {
  const t0 = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const auth = await base44.auth.isAuthenticated().catch(() => false);

    if (!auth && !body._service_role) {
      return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    const accountId = body.amazon_account_id;
    if (!accountId) {
      return Response.json({ ok: false, error_type: 'missing_account_id', error: 'amazon_account_id obrigatório' }, { status: 400 });
    }

    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ id: accountId }, null, 1);
    const account = accounts[0];
    if (!account) {
      return Response.json({ ok: false, error_type: 'account_not_found', error: 'Conta Amazon não encontrada' }, { status: 404 });
    }

    const dbRefreshToken = String(account.ads_refresh_token || '');
    const envRefreshToken = String(Deno.env.get('ADS_REFRESH_TOKEN') || '');
    const tokenSourceConflict = !!(dbRefreshToken && envRefreshToken && dbRefreshToken !== envRefreshToken);
    const activeTokenSource = dbRefreshToken ? 'database' : 'missing';

    if (!dbRefreshToken || !dbRefreshToken.startsWith('Atzr|')) {
      const msg = 'Refresh token ausente ou inválido no banco. Reconecte Amazon Ads via OAuth.';
      await base44.asServiceRole.entities.AmazonAccount.update(accountId, {
        ads_token_status: 'missing',
        ads_requires_reauth: true,
        ads_active_token_source: activeTokenSource,
        ads_env_token_present: !!envRefreshToken,
        ads_token_source_conflict: tokenSourceConflict,
        ads_last_verified_at: new Date().toISOString(),
        ads_token_last_error: msg,
        status: 'error',
        error_message: msg,
      }).catch(() => {});
      await logDiagnostic(base44, accountId, 'error', msg);
      return Response.json({ ok: false, error_type: 'missing_refresh_token', requires_reauthorization: true, message: msg });
    }

    const tokenResponse = await base44.asServiceRole.functions.invoke('amazonAdsTokenManager', {
      amazon_account_id: accountId,
      force_refresh: true,
      _service_role: true,
    });
    const tokenData = tokenResponse?.data || tokenResponse || {};

    if (!tokenData.ok || !tokenData.access_token) {
      const msg = safeError(tokenData);
      const statusPatch: any = {
        ads_last_verified_at: new Date().toISOString(),
        ads_token_last_error: msg,
        ads_active_token_source: activeTokenSource,
        ads_env_token_present: !!envRefreshToken,
        ads_token_source_conflict: tokenSourceConflict,
        ads_requires_reauth: tokenData.requires_reauthorization === true,
        ads_credentials_error: tokenData.credentials_error === true,
        ads_token_status: tokenData.credentials_error ? 'credentials_error' : tokenData.requires_reauthorization ? 'revoked' : 'error',
        status: 'error',
        error_message: msg,
      };
      await base44.asServiceRole.entities.AmazonAccount.update(accountId, statusPatch).catch(() => {});
      await logDiagnostic(base44, accountId, 'error', msg);
      return Response.json({
        ok: false,
        stage: 'refresh_token',
        error_type: tokenData.error_type || 'token_refresh_failed',
        amazon_error_code: tokenData.amazon_error_code,
        credentials_error: tokenData.credentials_error === true,
        requires_reauthorization: tokenData.requires_reauthorization === true,
        retryable: tokenData.retryable === true,
        message: msg,
        token_source_conflict: tokenSourceConflict,
      });
    }

    const baseUrl = adsBase(account.region);
    const clientId = Deno.env.get('ADS_CLIENT_ID') || '';
    const profilesRes = await fetch(`${baseUrl}/v2/profiles`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        'Amazon-Advertising-API-ClientId': clientId,
        Accept: 'application/json',
      },
    });

    const rawText = await profilesRes.text().catch(() => '');
    let profilesPayload: any = null;
    try { profilesPayload = rawText ? JSON.parse(rawText) : []; } catch { profilesPayload = { raw: rawText.slice(0, 500) }; }

    if (!profilesRes.ok) {
      const msg = `Falha ao validar /v2/profiles: HTTP ${profilesRes.status} ${rawText.slice(0, 300)}`;
      await base44.asServiceRole.entities.AmazonAccount.update(accountId, {
        ads_token_status: profilesRes.status === 401 || profilesRes.status === 403 ? 'revoked' : 'error',
        ads_requires_reauth: profilesRes.status === 401 || profilesRes.status === 403,
        ads_last_verified_at: new Date().toISOString(),
        ads_token_last_error: msg,
        status: 'error',
        error_message: msg,
      }).catch(() => {});
      await logDiagnostic(base44, accountId, 'error', msg);
      return Response.json({ ok: false, stage: 'profiles', status: profilesRes.status, requires_reauthorization: profilesRes.status === 401 || profilesRes.status === 403, message: msg });
    }

    const profiles = Array.isArray(profilesPayload) ? profilesPayload : (profilesPayload?.profiles || profilesPayload?.data || []);
    const activeProfileId = String(account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID') || '');
    const activeProfile = profiles.find((p: any) => profileIdOf(p) === activeProfileId) || null;

    if (activeProfileId && !activeProfile) {
      const msg = `Token válido, mas profile ativo ${activeProfileId} não foi encontrado em /v2/profiles.`;
      await base44.asServiceRole.entities.AmazonAccount.update(accountId, {
        ads_token_status: 'profile_not_found',
        ads_requires_reauth: false,
        ads_last_verified_at: new Date().toISOString(),
        ads_token_last_error: msg,
        status: 'error',
        error_message: msg,
      }).catch(() => {});
      await logDiagnostic(base44, accountId, 'error', msg, profiles.length);
      return Response.json({ ok: false, stage: 'profile_match', profile_id: activeProfileId, profiles_found: profiles.length, message: msg });
    }

    const selected = activeProfile || profiles[0] || null;
    const country = selected ? countryOf(selected) : null;
    const accountType = selected ? typeOf(selected) : null;
    const now = new Date().toISOString();

    await base44.asServiceRole.entities.AmazonAccount.update(accountId, {
      ads_token_status: 'active',
      ads_requires_reauth: false,
      ads_credentials_error: false,
      ads_last_verified_at: now,
      ads_token_last_error: null,
      ads_active_token_source: activeTokenSource,
      ads_env_token_present: !!envRefreshToken,
      ads_token_source_conflict: tokenSourceConflict,
      ads_profiles_count: profiles.length,
      ads_profile_country_code: country,
      ads_profile_type: accountType,
      status: 'connected',
      error_message: null,
    }).catch(() => {});

    const summary = JSON.stringify({ profiles_found: profiles.length, active_profile_id: profileIdOf(selected), country, account_type: accountType, token_source_conflict: tokenSourceConflict });
    await logDiagnostic(base44, accountId, 'success', summary, profiles.length);

    return Response.json({
      ok: true,
      operational: true,
      stage: 'complete',
      profiles_found: profiles.length,
      active_profile_id: profileIdOf(selected),
      country,
      account_type: accountType,
      active_token_source: activeTokenSource,
      env_token_present: !!envRefreshToken,
      token_source_conflict: tokenSourceConflict,
      access_token_expires_at: tokenData.expires_at,
      duration_ms: Date.now() - t0,
    });
  } catch (error: any) {
    return Response.json({ ok: false, error_type: 'internal_error', error: String(error?.message || 'Erro no diagnóstico Amazon Ads').slice(0, 500) }, { status: 500 });
  }
});
