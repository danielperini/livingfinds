/**
 * adsHelpers — Funções partilhadas para autenticação e chamadas à Amazon Ads API
 * Usado por todas as funções de sync via base44.functions.invoke('adsHelpers', ...)
 * NÃO é chamado directamente — serve como utilitário interno.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const tokenCache = {};

export async function getAdsToken() {
  const cached = tokenCache['ads'];
  if (cached && cached.expires_at > Date.now()) return cached.access_token;
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: Deno.env.get('ADS_REFRESH_TOKEN'),
    client_id: Deno.env.get('ADS_CLIENT_ID'),
    client_secret: Deno.env.get('ADS_CLIENT_SECRET'),
  });
  let attempt = 0;
  while (attempt < 3) {
    attempt++;
    const res = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    if (res.status === 429 || res.status >= 500) {
      await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 500));
      continue;
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error_description || 'Token refresh failed');
    tokenCache['ads'] = { access_token: data.access_token, expires_at: Date.now() + (data.expires_in - 60) * 1000 };
    return data.access_token;
  }
  throw new Error('Token refresh failed after 3 attempts');
}

export function getAdsBaseUrl() {
  const r = (Deno.env.get('ADS_REGION') || 'NA').toUpperCase().trim();
  if (r.includes('EU') || r.includes('EUROP')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE') || r.includes('JAPAN') || r.includes('ASIA')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

export async function adsCall(method, path, body, contentType = 'application/json') {
  const token = await getAdsToken();
  const opts = {
    method: method || 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID'),
      'Amazon-Advertising-API-Scope': String(Deno.env.get('ADS_PROFILE_ID')),
      'Content-Type': contentType,
      'Accept': contentType,
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${getAdsBaseUrl()}${path}`, opts);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`ADS ${res.status} ${path}: ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

// Endpoint handler obrigatório
Deno.serve(async (req) => {
  return Response.json({ ok: true, message: 'adsHelpers — internal utility module' });
});