import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import {
  ADS_TOKEN_REVOKED_REAUTH_REQUIRED,
  adsBaseUrlForRegion,
  resolveAmazonAdsCredentials,
} from '../../shared/amazonCredentials.ts';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ user_id: user.id }, '-updated_date', 1).catch(() => [] as any[]);
    const account = accounts[0] || null;
    if (!account) return Response.json({ ok: false, error_code: 'amazon_account_not_found', message: 'AmazonAccount não encontrada' }, { status: 404 });

    const credentials = resolveAmazonAdsCredentials();
    const clientId = credentials.clientId.value;
    const profileId = String(account.ads_profile_id || credentials.profileId.value || '');
    const baseUrl = adsBaseUrlForRegion(String(account.region || credentials.region || 'NA'));
    if (!clientId || !profileId) {
      return Response.json({ ok: false, error_code: 'ads_configuration_incomplete', message: 'Client ID ou profile Ads ausente' }, { status: 500 });
    }

    const getAdsToken = async (forceRefresh = false) => {
      const response = await base44.asServiceRole.functions.invoke('amazonAdsTokenManager', {
        _service_role: true,
        amazon_account_id: account.id,
        force_refresh: forceRefresh,
        triggered_by: 'amazonAdsProxy',
      });
      const data = response?.data || response || {};
      if (data?.ok !== true || data?.token_available !== true) {
        const reauth = data?.requires_reauthorization === true || data?.error_type === ADS_TOKEN_REVOKED_REAUTH_REQUIRED;
        throw {
          code: reauth ? ADS_TOKEN_REVOKED_REAUTH_REQUIRED : (data?.error_type || 'ads_token_unavailable'),
          message: data?.message || 'Token Amazon Ads indisponível',
          status: reauth ? 401 : 503,
        };
      }
      const freshAccounts = await base44.asServiceRole.entities.AmazonAccount.filter({ id: account.id }, null, 1).catch(() => [] as any[]);
      const accessToken = String(freshAccounts[0]?.ads_access_token || '').trim();
      if (!accessToken) throw { code: 'ADS_ACCESS_TOKEN_STORE_EMPTY', message: 'Access token não encontrado no armazenamento interno.', status: 503 };
      return accessToken;
    };

    const adsRequest = async (path: string, method = 'GET', requestBody: any = null) => {
      let token = await getAdsToken(false);
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const headers: Record<string, string> = {
          Authorization: `Bearer ${token}`,
          'Amazon-Advertising-API-ClientId': clientId,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        };
        if (!path.startsWith('/v2/profiles')) headers['Amazon-Advertising-API-Scope'] = profileId;

        const response = await fetch(`${baseUrl}${path}`, {
          method,
          headers,
          body: requestBody ? JSON.stringify(requestBody) : undefined,
        });
        if ((response.status === 401 || response.status === 403) && attempt === 1) {
          token = await getAdsToken(true);
          continue;
        }
        if (response.status === 429 || response.status >= 500) {
          if (attempt < 3) {
            await wait(Math.pow(2, attempt) * 1000);
            continue;
          }
        }

        const text = await response.text();
        let data: any = {};
        try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text.slice(0, 500) }; }
        if (!response.ok) {
          if (response.status === 401 || response.status === 403) {
            await base44.asServiceRole.entities.AmazonAccount.update(account.id, {
              ads_token_status: 'revoked',
              ads_requires_reauth: true,
              ads_credentials_error: false,
              ads_token_last_error: String(data?.details || data?.message || 'Amazon Ads não autorizada').slice(0, 500),
              status: 'error',
              error_message: 'Amazon Ads requer reautorização.',
            }).catch(() => {});
            throw { code: ADS_TOKEN_REVOKED_REAUTH_REQUIRED, message: 'Amazon Ads requer reautorização em /amazon-oauth-setup', status: 401 };
          }
          throw { code: `ads_${response.status}`, message: data?.details || data?.message || 'Ads API error', status: response.status };
        }
        return data;
      }
      throw { code: 'max_retries', message: 'Ads API request failed after retries', status: 503 };
    };

    const body = await req.json().catch(() => ({}));
    const { action, payload } = body;
    let result: any;
    switch (action) {
      case 'getProfiles': result = await adsRequest('/v2/profiles'); break;
      case 'getCampaigns': result = await adsRequest('/v2/sp/campaigns?stateFilter=enabled,paused&count=100'); break;
      case 'getAdGroups': result = await adsRequest(`/v2/sp/adGroups?campaignIdFilter=${encodeURIComponent(payload?.campaign_id || '')}&count=100`); break;
      case 'getKeywords': result = await adsRequest(`/v2/sp/keywords?adGroupIdFilter=${encodeURIComponent(payload?.ad_group_id || '')}&count=500`); break;
      case 'updateCampaign': result = await adsRequest('/v2/sp/campaigns', 'PUT', [payload]); break;
      case 'updateKeyword': result = await adsRequest('/v2/sp/keywords', 'PUT', [payload]); break;
      case 'updateBid': result = await adsRequest('/v2/sp/keywords', 'PUT', [{ keywordId: payload?.keyword_id, bid: payload?.bid }]); break;
      default: return Response.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
    return Response.json({ ok: true, data: result });
  } catch (error: any) {
    return Response.json({ ok: false, error_code: error?.code || 'unknown', message: error?.message || 'Internal error' }, { status: error?.status || 500 });
  }
});
