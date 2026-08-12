/**
 * adsHelpers — utilitário legado para chamadas Amazon Ads.
 * Credenciais passam exclusivamente pelo resolvedor canônico.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { adsBaseUrlForRegion, resolveAmazonAdsCredentials } from '../../shared/amazonCredentials.ts';

const tokenCache: Record<string, { access_token: string; expires_at: number }> = {};

export async function getAdsToken() {
  const cached = tokenCache.ads;
  if (cached && cached.expires_at > Date.now()) return cached.access_token;

  const credentials = resolveAmazonAdsCredentials();
  if (!credentials.clientId.value || !credentials.clientSecret.value || !credentials.refreshToken.value) {
    throw new Error('Credenciais Amazon Ads ausentes na fonte canônica');
  }

  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: credentials.refreshToken.value,
    client_id: credentials.clientId.value,
    client_secret: credentials.clientSecret.value,
  });

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const res = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    if (res.status === 429 || res.status >= 500) {
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, Math.pow(2, attempt) * 500));
      continue;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.access_token) {
      throw new Error(String(data?.error_description || data?.error || 'Token refresh failed'));
    }
    tokenCache.ads = {
      access_token: String(data.access_token),
      expires_at: Date.now() + (Math.max(120, Number(data.expires_in || 3600) - 60) * 1000),
    };
    return tokenCache.ads.access_token;
  }
  throw new Error('Token refresh failed after 3 attempts');
}

export function getAdsBaseUrl() {
  return adsBaseUrlForRegion(resolveAmazonAdsCredentials().region);
}

export async function adsCall(method: string, path: string, body: any, contentType = 'application/json', profileId?: string) {
  const token = await getAdsToken();
  const credentials = resolveAmazonAdsCredentials();
  const scope = profileId || credentials.profileId.value;
  if (!scope) throw new Error('profileId não informado. Perfil Amazon Ads é obrigatório.');
  if (!credentials.clientId.value) throw new Error('ADS_CLIENT_ID ausente na fonte canônica.');

  const opts: RequestInit = {
    method: method || 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': credentials.clientId.value,
      'Amazon-Advertising-API-Scope': scope,
      'Content-Type': contentType,
      Accept: contentType,
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${getAdsBaseUrl()}${path}`, opts);
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 500) }; }
  if (!res.ok) throw new Error(`ADS ${res.status} ${path}: ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

export async function loadAllCampaigns(base44: any, amazonAccountId: string) {
  const allCampaigns: any[] = [];
  let offset = 0;
  const pageSize = 200;
  while (true) {
    const page = await base44.asServiceRole.entities.Campaign.filter(
      { amazon_account_id: amazonAccountId }, '-created_date', pageSize, offset,
    );
    allCampaigns.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }
  return allCampaigns;
}

Deno.serve(async (_req) => Response.json({ ok: true, message: 'adsHelpers — internal utility module' }));
