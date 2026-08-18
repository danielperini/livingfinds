type CachedLwaToken = {
  accessToken: string;
  expiresAt: number;
};

let cachedToken: CachedLwaToken | null = null;
let refreshInFlight: Promise<CachedLwaToken> | null = null;

function envFirst(...names: string[]): string {
  for (const name of names) {
    const value = String(Deno.env.get(name) || '').trim();
    if (value) return value;
  }
  return '';
}

export function isSpApiHost(hostname: string): boolean {
  return hostname.startsWith('sellingpartnerapi-') && hostname.endsWith('.amazon.com');
}

export function hasManagedSpApiCredentials(): boolean {
  return Boolean(
    envFirst('AMAZON_LWA_CLIENT_ID', 'SP_CLIENT_ID') &&
    envFirst('AMAZON_LWA_CLIENT_SECRET', 'SP_CLIENT_SECRET') &&
    envFirst('AMAZON_SP_REFRESH_TOKEN', 'SP_REFRESH_TOKEN')
  );
}

async function refreshToken(): Promise<CachedLwaToken> {
  const clientId = envFirst('AMAZON_LWA_CLIENT_ID', 'SP_CLIENT_ID');
  const clientSecret = envFirst('AMAZON_LWA_CLIENT_SECRET', 'SP_CLIENT_SECRET');
  const refreshTokenValue = envFirst('AMAZON_SP_REFRESH_TOKEN', 'SP_REFRESH_TOKEN');

  if (!clientId || !clientSecret || !refreshTokenValue) {
    throw new Error('SP_API_LWA_NOT_CONFIGURED: configure AMAZON_LWA_CLIENT_ID/SECRET e AMAZON_SP_REFRESH_TOKEN (ou aliases SP_*)');
  }

  const response = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshTokenValue,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.access_token) {
    const code = String(payload?.error || response.status || 'unknown');
    const description = String(payload?.error_description || payload?.message || 'Falha ao renovar token LWA');
    const revoked = /invalid_grant|invalid_client|unauthorized_client/i.test(`${code} ${description}`);
    throw new Error(`${revoked ? 'SP_API_REAUTHORIZATION_REQUIRED' : 'SP_API_LWA_REFRESH_FAILED'}: ${code} - ${description}`);
  }

  const expiresIn = Math.max(300, Number(payload.expires_in || 3600));
  const next = {
    accessToken: String(payload.access_token),
    // margem de 5 minutos para nunca reutilizar token no limite da expiração
    expiresAt: Date.now() + Math.max(60, expiresIn - 300) * 1000,
  };
  cachedToken = next;
  return next;
}

export async function getSpApiAccessToken(forceRefresh = false): Promise<string> {
  if (!forceRefresh && cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.accessToken;

  if (forceRefresh) cachedToken = null;
  if (!refreshInFlight) {
    refreshInFlight = refreshToken().finally(() => {
      refreshInFlight = null;
    });
  }
  const token = await refreshInFlight;
  return token.accessToken;
}

export function invalidateSpApiAccessToken(): void {
  cachedToken = null;
}
